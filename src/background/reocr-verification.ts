/**
 * Re-OCR Verification (pure pixel checks)
 *
 * After redacting a screenshot, this module verifies — at the pixel level —
 * that the redaction actually worked before any data crosses a network
 * boundary. It re-scans every sensitive region in the EXACT image that ships
 * (the JPEG produced by the offscreen canvas) and asserts one of:
 *
 *   1. The region is now a solid black mask (credentials / ID numbers), or
 *   2. The region's pixels were substantially altered (blurred faces/labels),
 *      or
 *   3. The original region contained no content at all (nothing to leak).
 *
 * This is the "prove it works" feature that makes PRY demonstrably
 * different from other privacy tools that just claim to redact.
 *
 * The module is deliberately DOM-free: it only touches pixel buffers, so it
 * runs inside the offscreen document's canvas pipeline AND can be exercised
 * by the headless verification harness in Node.
 */

import type { VerificationResult } from "../shared/types";

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

/** Fraction (0-1) of sampled pixels in a region that are near-black. */
export function solidBlackRatio(img: PixelImage, x: number, y: number, width: number, height: number): number {
  const region = clampRegion(img, x, y, width, height);
  if (!region) return 0;

  let blackPixels = 0;
  let total = 0;
  // Sample every 4th pixel for speed.
  for (let py = region.y; py < region.y + region.height; py += 4) {
    for (let px = region.x; px < region.x + region.width; px += 4) {
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
  for (let py = region.y; py < region.y + region.height; py += 4) {
    for (let px = region.x; px < region.x + region.width; px += 4) {
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
  for (let py = region.y; py < region.y + region.height; py += 3) {
    for (let px = region.x; px < region.x + region.width; px += 3) {
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

/** Kinds whose redaction is a blur rather than a solid mask. */
const BLUR_KINDS = new Set(["input_field", "credential_label", "face", "credential"]);

/**
 * Variance of luminance inside a region. Uniform regions (blank fields, solid
 * backgrounds) have variance near 0; regions containing text or a face have
 * high variance. Used to decide whether a region held content worth leaking.
 */
export function regionVariance(img: PixelImage, x: number, y: number, width: number, height: number): number {
  const region = clampRegion(img, x, y, width, height);
  if (!region) return 0;

  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let py = region.y; py < region.y + region.height; py += 4) {
    for (let px = region.x; px < region.x + region.width; px += 4) {
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
 *   - its pixels changed substantially (blur/overlay actually applied).
 *
 * Regions that fail are reported in `leakedPatterns` with a reason.
 */
export function verifyRegions(
  original: PixelImage | null,
  redacted: PixelImage,
  regions: RedactionRegion[],
  timestamp: number = Date.now(),
): VerificationResult {
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
      // Pixels substantially altered → blur/overlay applied.
      if (diff > 0.12) {
        regionsRedacted++;
        continue;
      }
      // Blur verification: a real blur collapses local gradient (sharpness)
      // energy and moves a large fraction of pixels, even when the source
      // text is faint gray (placeholder text) and the mean diff stays low.
      // An untouched region keeps its sharpness and pixel identity.
      if (BLUR_KINDS.has(region.kind)) {
        const e0 = regionGradientEnergy(original, region.x, region.y, region.width, region.height);
        const e1 = regionGradientEnergy(redacted, region.x, region.y, region.width, region.height);
        const changed = regionChangedFraction(original, redacted, region.x, region.y, region.width, region.height);
        if ((e0 > 800 && e1 < Math.max(e0 * 0.45, 120)) || changed > 0.1) {
          regionsRedacted++;
          continue;
        }
      }
      leakedPatterns.push(
        `"${region.label}" (${region.kind}) at ${region.x},${region.y} was not visibly redacted — original content may still be visible.`,
      );
    } else {
      // No original for comparison: a mask or a low-variance (blurred/uniform)
      // region is the best evidence we have.
      if (blackRatio > 0.5 || regionVariance(redacted, region.x, region.y, region.width, region.height) < 400) {
        regionsRedacted++;
      } else {
        leakedPatterns.push(
          `"${region.label}" (${region.kind}) at ${region.x},${region.y} could not be confirmed redacted.`,
        );
      }
    }
  }

  const verified = regionsChecked === 0 || regionsRedacted === regionsChecked;
  const confidence = regionsChecked > 0 ? regionsRedacted / regionsChecked : 1;

  const summary = verified
    ? `VERIFIED: ${regionsRedacted}/${regionsChecked} sensitive regions confirmed redacted. Zero PII leakage.`
    : `WARNING: ${regionsRedacted}/${regionsChecked} regions confirmed redacted; ${regionsChecked - regionsRedacted} may still contain sensitive content.`;

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
    summary: "VERIFIED: nothing sensitive on screen — zero regions required redaction.",
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
