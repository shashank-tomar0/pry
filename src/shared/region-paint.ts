/**
 * Region painting policy — the ONE place that decides how a sensitive region is
 * redacted, and with which rectangle (pure: no canvas, no DOM, no chrome).
 *
 * WHY THIS EXISTS
 *
 * Three files each carried their own copy of this decision, and they disagreed:
 *
 *   - `offscreen.ts` decided the tier inline (`kind.endsWith("_text")` plus a
 *     two-name blur list) and computed the painted rectangle itself, while the
 *     audit box was derived from the *source* region — which is how proof
 *     markers drifted off their masks;
 *   - `reocr-verification.ts` kept its own `BLUR_KINDS` / `DESTROYED_KINDS`
 *     sets, so a `credential` region was painted as a surrogate and verified as
 *     a blur — two classifications of the same kind, in the same pipeline;
 *   - `inspector.ts` had no notion of tier at all and drew every box alike,
 *     implying an opaque mask and a reversible blur carry the same guarantee.
 *
 * So this module owns the decision. It returns a PLAN, not pixels: the driver
 * executes the ops and, crucially, takes both the redaction list and the
 * reported audit box from the SAME op. The painter and the reporter cannot
 * disagree about a rectangle that only one of them computed.
 *
 * TIER TABLE (current behaviour, pinned by scripts/verify-pipeline.mjs)
 *
 *   face                             → opaque    biometric; never blurred
 *   *_text, image_text, ner_text     → opaque    the span IS the PII
 *   credential_label, input_field    → blur      non-identifying; soft tier
 *   other field kinds                → surrogate real pixels discarded, then a
 *                                                synthetic format-preserving
 *                                                value drawn in their place
 *   face with destroyFaces off       → skip      reported, deliberately not
 *                                                painted (see "skip" below)
 *
 * NOTE ON A KNOWN INCONSISTENCY, deliberately not resolved here. The module
 * header of `offscreen.ts` and §4/§5 of README.md both describe password/card/
 * Aadhaar FIELDS as opaque or blur-tier, while `surrogates.ts` exists precisely
 * to inpaint those same fields with format-preserving values — and the table
 * above encodes the surrogate behaviour that ships today. Flipping confirmed
 * credential fields to opaque would be a strictly stronger guarantee, but it is
 * a change to what masks secrets on screen and therefore the user's call, not a
 * refactor's. Tests pin today's mapping so any change is deliberate.
 */

import { getSyntheticSurrogate } from "../background/surrogates";
import {
  normalizePaintedRect,
  paintRectFor,
  REGION_PAINT_PADDING_CSS_PX,
  type NormalizedBox,
  type PaintCandidate,
  type PaintGeometry,
  type PaintedRect,
} from "./region-mapping";

/** How one region is redacted. `skip` reports without painting. */
export type RegionTier = "opaque" | "blur" | "surrogate" | "skip";

/** User toggles that change which tier a region receives. */
export interface PaintPolicy {
  destroyFaces: boolean;
  maskCredentials: boolean;
}

/** Solid fill for the opaque tier: zero entropy, nothing to reconstruct. */
export const OPAQUE_FILL = "#000000";
/** Box-blur radius in CSS pixels (scaled to device px at paint time). */
export const BLUR_RADIUS_CSS_PX = 6;
/** Surrogate inpaint chrome. */
export const SURROGATE_FILL = "#ffffff";
export const SURROGATE_BORDER = "#cbd5e1";
export const SURROGATE_TEXT_FILL = "#1e293b";

/** A region as the content script measured it (viewport CSS pixels). */
export interface PaintRegion extends PaintCandidate {
  kind: string;
  label: string;
  value?: string;
}

/**
 * Confirmed credential / identity FIELDS — the kinds `perceive.ts` emits for a
 * password box, a card box, an Aadhaar/PAN/SSN box, a CVV, an OTP or an API-key
 * field, and for the generic inputs and their labels it also redacts.
 *
 * Kept here as the single list, because `tierForKind` below and the verifier's
 * tier sets both enumerate it. Two lists is how `credential` came to be painted
 * as a surrogate and verified as a blur.
 */
export const FIELD_KINDS: readonly string[] = [
  "password",
  "credit_card",
  "cvv",
  "otp",
  "api_key",
  "id_number",
  "pan_card",
  "credential",
  "credential_label",
  "input_field",
];

/**
 * Exact-PII span kinds. Every one of these is a rectangle measured around a
 * literal value the text channel also tokenized, so the pixels must carry the
 * same guarantee the token does: nothing left to read.
 */
export const SPAN_TEXT_KINDS: readonly string[] = [
  "email_text",
  "phone_text",
  "id_text",
  "name_text",
  "ner_text",
  "image_text",
];

/**
 * Every kind the painter can be handed, in one place.
 *
 * The verifier walks this to build its destroyed/soft sets, so a kind added to
 * the pipeline without a tier decision is caught by the tests rather than
 * silently verified under the loosest rule.
 */
export const REGION_KIND_VOCABULARY: readonly string[] = [
  "face",
  ...SPAN_TEXT_KINDS,
  ...FIELD_KINDS,
];

/** The tier a `kind` receives, given the user's policy. */
export function tierForKind(kind: string, policy: PaintPolicy): RegionTier {
  if (kind === "face") return policy.destroyFaces ? "opaque" : "skip";
  // Masking off degrades EVERY remaining tier to blur. The surrogate tier draws
  // a plausible-looking synthetic value in place of the real one, which is the
  // opposite of what a user who switched masking off asked for; the soft tier
  // still protects the pixels, so it is the degradation that ships.
  if (!policy.maskCredentials) return "blur";
  if (kind.endsWith("_text")) return "opaque";
  if (kind === "credential_label" || kind === "input_field") return "blur";
  return "surrogate";
}

/**
 * The tiers in force for one policy, as kind sets.
 *
 * The verifier asks this question with the SAME policy the frame was painted
 * under, so "painted opaque" and "must be proven opaque" cannot drift apart.
 * With masking switched off, for instance, the span kinds degrade to blur — and
 * a verifier that hardcoded the shipped defaults would then demand opacity of a
 * frame the user had deliberately asked to paint softly, failing every frame.
 */
export function tierSetsFor(policy: PaintPolicy): {
  destroyed: Set<string>;
  soft: Set<string>;
} {
  const destroyed = new Set<string>();
  const soft = new Set<string>();
  for (const kind of REGION_KIND_VOCABULARY) {
    if (tierForKind(kind, policy) === "opaque") destroyed.add(kind);
    else soft.add(kind);
  }
  return { destroyed, soft };
}

/** One planned operation, carrying everything the driver and the audit need. */
export interface PaintedOp {
  tier: RegionTier;
  kind: string;
  label: string;
  /** The device-pixel rectangle this op concerns; null when it was dropped. */
  rect: PaintedRect | null;
  /** Box for the audit overlay — derived from `rect`, never from the region. */
  box: NormalizedBox | null;
  /** Blur radius in device px (blur tier only). */
  blurRadius?: number;
  /** Text to draw (surrogate tier only). */
  surrogateText?: string;
  /** Device-px font size and padding for the surrogate text. */
  fontSizePx?: number;
  padPx?: number;
  /** Kind for the audit detection list. See `detectionKindFor`. */
  detectionKind: string;
  /**
   * True when this op actually changed pixels. `false` means the region was
   * reported but left alone — a face with face destruction switched off — and
   * such an op must never be counted as a redaction.
   */
  painted: boolean;
}

/**
 * The audit-list kind for a painted region.
 *
 * Field kinds keep their own name (`password`, `credit_card`, …) because the
 * side panel's colour map distinguishes them deliberately — a password box and
 * an expiry box are not the same finding. Only the two generic container kinds
 * collapse, since "the label next to a secret" and "a field a user types into"
 * are both just `credential` to a reader.
 */
export function detectionKindFor(kind: string): string {
  if (kind === "credential_label" || kind === "input_field") return "credential";
  return kind;
}

export interface PaintPlanOptions {
  /** Padding around each region, in CSS px. */
  paddingCssPx?: number;
  /** Injected for tests; defaults to the shipped surrogate generator. */
  surrogateFor?: (kind: string, rawValue?: string) => string;
}

/**
 * Plan the paint for every DOM-detected region.
 *
 * Returns one op per region in input order, including `skip` ops, so the caller
 * can report what was detected-but-not-painted instead of silently dropping it.
 * Regions that fall entirely outside the captured image produce no op at all —
 * nothing was painted and nothing can be reported honestly.
 */
export function planRegionPaints(
  regions: readonly PaintRegion[] | undefined,
  geometry: PaintGeometry,
  policy: PaintPolicy,
  options: PaintPlanOptions = {},
): PaintedOp[] {
  const paddingCssPx = options.paddingCssPx ?? REGION_PAINT_PADDING_CSS_PX;
  const surrogateFor = options.surrogateFor ?? getSyntheticSurrogate;
  const ops: PaintedOp[] = [];

  for (const region of regions ?? []) {
    const rect = paintRectFor(region, geometry, paddingCssPx);
    if (!rect) continue;
    const box = normalizePaintedRect(rect, geometry.imageWidth, geometry.imageHeight);
    const tier = tierForKind(region.kind, policy);
    const op: PaintedOp = {
      tier,
      kind: region.kind,
      label: region.label,
      rect,
      box,
      detectionKind: detectionKindFor(region.kind),
      painted: tier !== "skip",
    };

    if (tier === "blur") {
      op.blurRadius = BLUR_RADIUS_CSS_PX * geometry.scale;
    } else if (tier === "surrogate") {
      op.surrogateText = surrogateFor(region.kind || region.label, region.value);
      op.fontSizePx = Math.max(
        9,
        Math.round(Math.min(rect.height * 0.5, 12 * geometry.scale)),
      );
      op.padPx = 4 * geometry.scale;
    }

    ops.push(op);
  }

  return ops;
}
