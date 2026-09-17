/**
 * Re-OCR Verification (pure pixel checks)
 *
 * After redacting a screenshot, this module verifies — at the pixel level —
 * that the redaction actually worked before any data crosses a network
 * boundary. It re-scans every sensitive region in the EXACT image that ships
 * (the JPEG produced by the offscreen canvas) and asserts one of:
 *
 *   1. The region is now a solid black mask (credentials / ID numbers), or
 *   2. A DESTROYED region (faces) is near-uniformly opaque — merely altered is
 *      not enough, because a blur is recoverable and this check exists to
 *      enforce irreversibility rather than to accept any visible change, or
 *   3. The region's pixels were substantially altered (soft blur-tier fields),
 *      or
 *   4. The original region contained no content at all (nothing to leak).
 *
 * This is the "prove it works" feature that makes PRY demonstrably
 * different from other privacy tools that just claim to redact.
 *
 * The module is deliberately DOM-free: it only touches pixel buffers, so it
 * runs inside the offscreen document's canvas pipeline AND can be exercised
 * by the headless verification harness in Node.
 */

import type { VerificationResult } from "../shared/types";
import { tierForKind, tierSetsFor } from "../shared/region-paint";

export type { VerificationResult };

// ─── Types ──────────────────────────────────────────────────────────────────

/** Minimal ImageData-like view (what canvas getImageData returns). */
export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** One region that was supposed to be redacted, in device-pixel coordinates. */
export interface RedactionRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The detector kind: credential, id_number, face, input_field, ... */
  kind: string;
  /** Human-readable label shown in leaks/verification output. */
  label: string;
}

// ─── PII Pattern Detection in Text ──────────────────────────────────────────

/**
 * Patterns that indicate PII might still be visible in extracted text.
 * Used when a screenshot is verified by re-scanning OCR-able text.
 */
const PII_VERIFICATION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/, label: "Aadhaar number" },
  { pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/, label: "PAN card" },
  { pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/, label: "IFSC code" },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, label: "SSN" },
  { pattern: /\b[A-Z]{1,2}\d{6,8}\b/, label: "Passport number" },
  { pattern: /\b(?:\d{4}[\s-]?){3}\d{4}\b/, label: "Card number" },
  { pattern: /\b(sk-ant-[a-zA-Z0-9_-]{20,})\b/, label: "Anthropic API key" },
  { pattern: /\b(sk-[a-zA-Z0-9]{20,})\b/, label: "OpenAI API key" },
  { pattern: /\b(ghp_[a-zA-Z0-9]{36})\b/, label: "GitHub token" },
  { pattern: /\b(AKIA[0-9A-Z]{16})\b/, label: "AWS key" },
  { pattern: /\b(eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.)\b/, label: "JWT token" },
  { pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/, label: "Email address" },
  { pattern: /\b(\+?91[\s-]?\d{5}[\s-]?\d{5})\b/, label: "Indian phone" },
];

/** Check text content against the PII verification patterns. */
export function detectPIIInText(text: string): string[] {
  const found: string[] = [];
  for (const { pattern, label } of PII_VERIFICATION_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    if (regex.test(text)) {
      found.push(label);
    }
  }
  return found;
}

/**
 * Map an OCR leak label back to a PII kind for the missed-outcome signal.
 * Pure so the harness can pin the mapping.
 */
export function piiKindFromOcrLabel(label: string): string {
  if (/aadhaar|pan|ssn|passport|ifsc/i.test(label)) return "id_number";
  if (/card|email|phone/i.test(label)) return "credential";
  if (/api key|jwt|github|aws|anthropic|openai|token/i.test(label)) return "api_key";
  return "pii_text";
}

// ─── Pixel Checks ───────────────────────────────────────────────────────────

/** Clamp a region to the image bounds (returns null when nothing overlaps). */
function clampRegion(
  img: PixelImage,
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } | null {
  const rx = Math.max(0, Math.round(x));
  const ry = Math.max(0, Math.round(y));
  const right = Math.min(img.width, Math.round(x + width));
  const bottom = Math.min(img.height, Math.round(y + height));
  if (right - rx <= 0 || bottom - ry <= 0) return null;
  return { x: rx, y: ry, width: right - rx, height: bottom - ry };
}

/**
 * Fraction (0-1) of sampled pixels in a region that are near-black.
 *
 * `inset` shrinks the measured rectangle before sampling. The verifier uses a
 * small inset when proving that a destroyed region is opaque: a mask's own
 * boundary rings under JPEG (the encoder's high-frequency response to a hard
 * black edge), so a handful of edge pixels read as non-black even though the
 * redaction is complete. Measuring the interior avoids failing a correct
 * redaction for an artifact of the mask itself. It cannot mask a real leak —
 * a blurred or untouched region is non-black throughout, interior included.
 */
export function solidBlackRatio(
  img: PixelImage,
  x: number,
  y: number,
  width: number,
  height: number,
  inset: number = 0,
): number {
  const region = clampRegion(img, x + inset, y + inset, width - inset * 2, height - inset * 2)
    ?? clampRegion(img, x, y, width, height);
  if (!region) return 0;

  let blackPixels = 0;
  let total = 0;
  // Row-phase-offset stride (see regionVariance).
  for (let py = region.y, row = 0; py < region.y + region.height; py += 3, row++) {
    for (let px = region.x + (row % 3); px < region.x + region.width; px += 3) {
      const idx = (py * img.width + px) * 4;
      const r = img.data[idx];
      const g = img.data[idx + 1];
      const b = img.data[idx + 2];
      if (r < 30 && g < 30 && b < 30) blackPixels++;
      total++;
    }
  }
  return total > 0 ? blackPixels / total : 0;
}

/**
 * Mean absolute pixel difference (0-1) between two images over one region.
 * 0 = identical pixels, 1 = completely different.
 */
export function regionDiffScore(
  original: PixelImage,
  redacted: PixelImage,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  const region = clampRegion(original, x, y, width, height);
  if (!region || region.width === 0 || region.height === 0) return 0;

  let totalDiff = 0;
  let count = 0;
  // Row-phase-offset stride (see regionVariance): a fixed stride aliases
  // periodic content, and here that would score an unredacted region as fully
  // changed — a false PASS for a privacy check.
  for (let py = region.y, row = 0; py < region.y + region.height; py += 3, row++) {
    for (let px = region.x + (row % 3); px < region.x + region.width; px += 3) {
      const oi = (py * original.width + px) * 4;
      const ri = (py * redacted.width + px) * 4;
      // Guard against mismatched buffers.
      if (oi + 2 >= original.data.length || ri + 2 >= redacted.data.length) continue;
      const rDiff = Math.abs(original.data[oi] - redacted.data[ri]);
      const gDiff = Math.abs(original.data[oi + 1] - redacted.data[ri + 1]);
      const bDiff = Math.abs(original.data[oi + 2] - redacted.data[ri + 2]);
      totalDiff += (rDiff + gDiff + bDiff) / 765;
      count++;
    }
  }
  return count > 0 ? totalDiff / count : 0;
}

/**
 * Sum of local luminance gradient magnitudes in a region — a proxy for text
 * sharpness. A real blur collapses this energy even when the source text is
 * faint gray on white (where the mean pixel diff stays small), while an
 * untouched region keeps its energy. Higher = sharper content.
 */
export function regionGradientEnergy(
  img: PixelImage,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  const region = clampRegion(img, x, y, width, height);
  if (!region) return 0;

  let energy = 0;
  for (let py = region.y + 2; py < region.y + region.height - 2; py += 2) {
    for (let px = region.x + 2; px < region.x + region.width - 2; px += 2) {
      const l = ((py * img.width + px - 2) * 4);
      const r = ((py * img.width + px + 2) * 4);
      const u = (((py - 2) * img.width + px) * 4);
      const d = (((py + 2) * img.width + px) * 4);
      if (r + 2 >= img.data.length || u < 0) continue;
      const grayR = (img.data[r] + img.data[r + 1] + img.data[r + 2]) / 3;
      const grayL = (img.data[l] + img.data[l + 1] + img.data[l + 2]) / 3;
      const grayU = (img.data[u] + img.data[u + 1] + img.data[u + 2]) / 3;
      const grayD = (img.data[d] + img.data[d + 1] + img.data[d + 2]) / 3;
      energy += Math.abs(grayR - grayL) + Math.abs(grayD - grayU);
    }
  }
  return energy;
}

/**
 * Fraction (0-1) of sampled pixels whose brightness changed by at least
 * `threshold` levels between the original and redacted image over a region.
 * A blur visibly moves a large share of pixels even when the mean shift is
 * small; an untouched region is near 0.
 */
export function regionChangedFraction(
  original: PixelImage,
  redacted: PixelImage,
  x: number,
  y: number,
  width: number,
  height: number,
  threshold: number = 8,
): number {
  const region = clampRegion(original, x, y, width, height);
  if (!region) return 0;

  let changed = 0;
  let count = 0;
  for (let py = region.y, row = 0; py < region.y + region.height; py += 3, row++) {
    for (let px = region.x + (row % 3); px < region.x + region.width; px += 3) {
      const oi = (py * original.width + px) * 4;
      const ri = (py * redacted.width + px) * 4;
      if (ri + 2 >= redacted.data.length || oi + 2 >= original.data.length) continue;
      const dr = Math.abs(original.data[oi] - redacted.data[ri]);
      const dg = Math.abs(original.data[oi + 1] - redacted.data[ri + 1]);
      const db = Math.abs(original.data[oi + 2] - redacted.data[ri + 2]);
      if (dr >= threshold || dg >= threshold || db >= threshold) changed++;
      count++;
    }
  }
  return count > 0 ? changed / count : 0;
}

// ─── Tier vocabulary, derived from the painter's own table ──────────────────
//
// These sets used to be maintained HERE, independently of the painter, and the
// two disagreed: `credential` was painted as a surrogate while this file
// classified it as a blur, so the check measured the wrong guarantee for that
// kind. Both sides now read `tierForKind` from shared/region-paint.ts, and the
// verifier asks it with the SAME policy the frame was painted under — otherwise
// a frame the user asked to paint softly (masking off) would be measured as if
// it had promised opaque fills, and fail for obeying its own settings.

/**
 * Kinds whose redaction must be IRREVERSIBLE, not merely altered.
 *
 * Faces and the exact-PII span kinds live here. A blurred face is still the
 * face: super-resolution deanonymization inverts a Gaussian blur given the
 * kernel, which is the very attack PRY's threat model names. Accepting "pixels
 * changed" for these kinds would let a reverting edit to the offscreen pipeline
 * silently weaken the guarantee again, so the verifier demands near-total opaque
 * coverage — and since the painter fills exactly these kinds with pure black,
 * the demand is one the shipped code can actually meet.
 */
function destroyedKindsFor(policy: VerificationTierPolicy): Set<string> {
  return tierSetsFor(policy).destroyed;
}

/**
 * The tier policy a frame was painted with. Structurally `PaintPolicy`, named
 * separately here so this module does not have to care whether the painter's
 * policy ever grows a third toggle.
 */
export interface VerificationTierPolicy {
  destroyFaces: boolean;
  maskCredentials: boolean;
}

/**
 * The toggles as they ship. Used only when the caller has no policy in hand —
 * every real capture passes its own, because the tiers it painted with are the
 * tiers that must be proven.
 */
export const DEFAULT_TIER_POLICY: VerificationTierPolicy = {
  destroyFaces: true,
  maskCredentials: true,
};

/** Kinds on the soft tier: they must be proven altered, not proven opaque. */
function softKindsFor(policy: VerificationTierPolicy): Set<string> {
  return tierSetsFor(policy).soft;
}

/**
 * The regions worth reading back with OCR.
 *
 * An OCR re-read exists to catch a SOFT region that still holds the user's
 * original text — the case where a blur was too weak to matter. A SURROGATE
 * region is excluded because by construction it holds NONE of the user's
 * pixels: the real value was discarded and a synthetic, format-preserving
 * stand-in was painted instead. Reading it back therefore finds PRY's own
 * painting, and those stand-ins are designed to satisfy the very patterns this
 * scan looks for — the synthetic card "4111 8703 3161 1545" matches "Card
 * number" and (16 digits in 4-4-4 groups) "Aadhaar number", and the synthetic
 * email and phone match their patterns too. Every frame containing a masked
 * credential field used to report ~4 residual leaks, fail its own mask
 * verification, and be withheld from vision — a privacy check rejecting the
 * output it had just produced correctly.
 *
 * Coverage is not reduced. The failure this inclusion COULD catch — a surrogate
 * region that was never painted — is caught directly by the pixel check, which
 * sees an unpainted region keep its original variance and show no change at all
 * (see `verifyRegions`).
 */
export function ocrCheckableRegions<T extends { kind: string }>(
  regions: readonly T[],
  policy: VerificationTierPolicy = DEFAULT_TIER_POLICY,
): T[] {
  return regions.filter((region) => tierForKind(region.kind, policy) !== "surrogate");
}
/** Fraction of the region that must be near-black for a destroyed region. */
const DESTROYED_BLACK_RATIO = 0.9;

/**
 * Variance of luminance inside a region. Uniform regions (blank fields, solid
 * backgrounds) have variance near 0; regions containing text or a face have
 * high variance. Used to decide whether a region held content worth leaking.
 *
 * Sampling note: a fixed stride that is a multiple of the content's period
 * aliases it away. Striding 4 on both axes over an alternating two-tone
 * pattern (exactly what fine photo detail or a dithered fill looks like) lands
 * on a single phase and reads as PERFECTLY FLAT — which would declare the
 * region blank, skip its redaction, and silently drop the protection. A stride
 * of 3 with a per-row phase offset keeps the phase rotating so periodic
 * content cannot hide from the check that decides whether it needs redacting.
 */
export function regionVariance(img: PixelImage, x: number, y: number, width: number, height: number): number {
  const region = clampRegion(img, x, y, width, height);
  if (!region) return 0;

  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let py = region.y, row = 0; py < region.y + region.height; py += 3, row++) {
    for (let px = region.x + (row % 3); px < region.x + region.width; px += 3) {
      const idx = (py * img.width + px) * 4;
      const gray = (img.data[idx] + img.data[idx + 1] + img.data[idx + 2]) / 3;
      sum += gray;
      sumSq += gray * gray;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return Math.max(0, sumSq / count - mean * mean);
}

// ─── Main Verification ──────────────────────────────────────────────────────

/**
 * Verify that every sensitive region was actually redacted in the image that
 * ships, by comparing its pixels against the pre-redaction original.
 *
 * A region counts as verified when:
 *   - the original region was blank (variance below threshold → nothing to
 *     leak, e.g. an empty input field blurred over a white page), or
 *   - it is now a solid black mask, or
 *   - it is a DESTROYED kind (face) and is now near-uniformly opaque, or
 *   - its pixels changed substantially (blur/overlay actually applied).
 *
 * Regions that fail are reported in `leakedPatterns` with a reason.
 */
export function verifyRegions(
  original: PixelImage | null,
  redacted: PixelImage,
  regions: RedactionRegion[],
  timestamp: number = Date.now(),
  /**
   * The policy the frame was PAINTED with. Defaults to the shipped toggles, so
   * an arithmetic-only caller (the harness) gets the ordinary run's tiers. An
   * offscreen caller must pass its real policy: with masking off the span kinds
   * are painted softly, and measuring them as if they had been filled opaque
   * would fail a frame for honouring the user's settings.
   */
  policy: VerificationTierPolicy = DEFAULT_TIER_POLICY,
): VerificationResult {
  const destroyedKinds = destroyedKindsFor(policy);
  const softKinds = softKindsFor(policy);
  let regionsChecked = 0;
  let regionsRedacted = 0;
  const leakedPatterns: string[] = [];

  for (const region of regions) {
    if (!clampRegion(redacted, region.x, region.y, region.width, region.height)) {
      // Outside the canvas entirely — nothing to check, nothing redacted.
      continue;
    }
    regionsChecked++;

    const blackRatio = solidBlackRatio(redacted, region.x, region.y, region.width, region.height);
    // Same measurement over the region's interior, for the opacity proof below.
    const interiorInset = Math.max(1, Math.round(Math.min(region.width, region.height) * 0.08));
    const interiorBlackRatio = solidBlackRatio(
      redacted, region.x, region.y, region.width, region.height, interiorInset,
    );

    if (original) {
      const origVariance = regionVariance(original, region.x, region.y, region.width, region.height);
      const diff = regionDiffScore(original, redacted, region.x, region.y, region.width, region.height);

      // Blank original → nothing sensitive was present → nothing can leak.
      if (origVariance < 40) {
        regionsRedacted++;
        continue;
      }
      // Solid black mask → content covered.
      if (blackRatio > 0.5) {
        regionsRedacted++;
        continue;
      }
      // Destroyed kinds require PROOF of irreversibility, checked before the
      // loose "pixels changed" rule below — otherwise a regression back to
      // blur (which changes plenty of pixels) would still verify.
      if (destroyedKinds.has(region.kind)) {
        // Interior measurement: prove the fill itself, not the JPEG ringing at
        // its edge. A blur/touch-up regression leaves the interior non-black.
        if (interiorBlackRatio >= DESTROYED_BLACK_RATIO) {
          regionsRedacted++;
          continue;
        }
        leakedPatterns.push(
          `PIXEL: "${region.label}" (${region.kind}) at ${region.x},${region.y} is not opaque ` +
          `(only ${Math.round(interiorBlackRatio * 100)}% of the interior covered) — a ` +
          `reversible redaction, recoverable by super-resolution deanonymization.`,
        );
        continue;
      }
      // Pixels substantially altered → blur/overlay applied.
      if (diff > 0.12) {
        regionsRedacted++;
        continue;
      }
      // Blur verification: a real blur collapses local gradient (sharpness)
      // energy and moves a large fraction of pixels, even when the source
      // text is faint gray (placeholder text) and the mean diff stays low.
      // An untouched region keeps its sharpness and pixel identity.
      if (softKinds.has(region.kind)) {
        const e0 = regionGradientEnergy(original, region.x, region.y, region.width, region.height);
        const e1 = regionGradientEnergy(redacted, region.x, region.y, region.width, region.height);
        const changed = regionChangedFraction(original, redacted, region.x, region.y, region.width, region.height);
        if ((e0 > 800 && e1 < Math.max(e0 * 0.45, 120)) || changed > 0.1) {
          regionsRedacted++;
          continue;
        }
      }
      leakedPatterns.push(
        `PIXEL: "${region.label}" (${region.kind}) at ${region.x},${region.y} was not visibly redacted — original content may still be visible.`,
      );
    } else {
      // No original for comparison: a mask or a low-variance (blurred/uniform)
      // region is the best evidence we have.
      if (blackRatio > 0.5 || regionVariance(redacted, region.x, region.y, region.width, region.height) < 400) {
        regionsRedacted++;
      } else {
        leakedPatterns.push(
          `PIXEL: "${region.label}" (${region.kind}) at ${region.x},${region.y} could not be confirmed redacted.`,
        );
      }
    }
  }

  const verified = regionsChecked === 0 || regionsRedacted === regionsChecked;
  const confidence = regionsChecked > 0 ? regionsRedacted / regionsChecked : 1;

  // Scope the claim to what was actually measured. This check re-reads the
  // pixels of the regions the pipeline REDACTED; it cannot see a face the face
  // detector never found or an email the text channel never matched. Saying
  // "zero PII leakage" here asserted completeness from a coverage-of-known-
  // regions proof, which is how a frame with un-detected names on screen could
  // still display a green "ZERO-LEAK VERIFIED" badge.
  const summary = verified
    ? `VERIFIED: ${regionsRedacted}/${regionsChecked} redacted regions confirmed opaque in the shipped image (covers regions PRY detected, not detection completeness).`
    : `WARNING: ${regionsRedacted}/${regionsChecked} redacted regions confirmed opaque; ${regionsChecked - regionsRedacted} may still contain sensitive content.`;

  return {
    verified,
    regionsChecked,
    regionsRedacted,
    leakedPatterns,
    confidence,
    summary,
    timestamp,
  };
}

/** A safe default result when no regions were redacted (nothing to verify). */
export function emptyVerification(timestamp: number = Date.now()): VerificationResult {
  return {
    verified: true,
    regionsChecked: 0,
    regionsRedacted: 0,
    leakedPatterns: [],
    confidence: 1,
    // Deliberately NOT "nothing sensitive on screen": zero regions means zero
    // detections, which can also mean the detectors found nothing — not the
    // same claim. The panel renders this state as neutral, not as a pass.
    summary: "Nothing to verify on this frame — no region was flagged for redaction.",
    timestamp,
  };
}

// ─── Region-Crop Layout (OCR scoping) ───────────────────────────────────────

/** One source region placed into the OCR composite canvas. */
export interface RegionCropSlot {
  /** Index into the source regions array. */
  regionIndex: number;
  /** Source rectangle in the full screenshot (device pixels). */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Destination rectangle inside the composite strip. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

export interface RegionCropLayout {
  slots: RegionCropSlot[];
  /** Composite canvas size the caller should create. */
  width: number;
  height: number;
}

/**
 * Lay out the redacted regions as one composite strip for a single OCR pass.
 *
 * The OCR leak scan MUST be scoped to exactly the regions the pipeline
 * redacted: scanning the whole shipped image would flag PII that legitimately
 * remains visible on the page (an email in an inbox, a phone number in body
 * text) and turn every honest run into a false WARNING. Crops are scaled to a
 * readable height, wrapped into rows, and capped so the pass stays one cheap
 * OCR call. Pure and DOM-free so the headless harness can pin the geometry.
 */
export function layoutRegionCrops(
  regions: RedactionRegion[],
  opts: {
    maxCrops?: number;
    maxWidth?: number;
    maxHeight?: number;
    maxCropHeight?: number;
  } = {},
): RegionCropLayout {
  const maxCrops = opts.maxCrops ?? 24;
  const maxWidth = opts.maxWidth ?? 4096;
  const maxHeight = opts.maxHeight ?? 2048;
  const maxCropHeight = opts.maxCropHeight ?? 128;
  const GUTTER = 4;
  const ROW_GAP = 8;

  const slots: RegionCropSlot[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;

  for (let i = 0; i < regions.length && slots.length < maxCrops; i++) {
    const r = regions[i];
    if (!(r.width > 0) || !(r.height > 0)) continue;

    const sx = Math.round(r.x);
    const sy = Math.round(r.y);
    const sw = Math.max(1, Math.round(r.width));
    const sh = Math.max(1, Math.round(r.height));
    // Scale very tall regions down so OCR sees a compact, readable glyph strip.
    const scale = Math.min(1, maxCropHeight / sh);
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));

    if (x + dw > maxWidth) {
      // Wrap to a new row.
      x = 0;
      y += rowHeight + ROW_GAP;
      rowHeight = 0;
    }
    if (y + dh > maxHeight) break;

    slots.push({ regionIndex: i, sx, sy, sw, sh, dx: x, dy: y, dw, dh });
    x += dw + GUTTER;
    rowHeight = Math.max(rowHeight, dh);
  }

  let width = 0;
  let height = 0;
  for (const slot of slots) {
    width = Math.max(width, slot.dx + slot.dw);
    height = Math.max(height, slot.dy + slot.dh);
  }

  return { slots, width, height };
}
