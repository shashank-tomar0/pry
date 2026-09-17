/**
 * Region → captured-image coordinate mapping.
 *
 * Sensitive regions are measured by the content script in VIEWPORT CSS pixels
 * (element `getBoundingClientRect()`), while redaction happens in device
 * pixels on a captured canvas. The mapping differs between the two capture
 * modes:
 *
 *   - Viewport capture: the canvas is `viewport × DPR` device pixels, so the
 *     scale is simply DPR and there is no scroll offset.
 *   - Stitched full-page capture: the canvas is the whole PAGE drawn at
 *     `canvasWidth / viewportCssWidth` of each tile, and the regions were
 *     measured with the document scrolled back to the position it had when
 *     the capture finished. Every region therefore needs that tile scale AND
 *     the restored scroll offset.
 *
 * Getting this wrong does not fail loudly — it paints correct redactions at
 * the wrong y, so the audit shows faces masked and text PII still readable a
 * few hundred pixels away ("the two distorted images" in the ledger, and
 * "text PII is not being black-boxed"). It is pure arithmetic, so it lives in
 * one place, is pinned by the headless harness, and every capture path uses
 * the same function.
 */

export interface RegionMappingInput {
  /** Captured canvas width in device pixels. */
  imageWidth: number;
  /** Device pixel ratio used for the capture. */
  dpr: number;
  /** Viewport width in CSS pixels when the regions were measured. */
  viewportWidth: number;
  /** Viewport scroll offset in CSS pixels when the regions were measured. */
  scrollY: number;
  /** True only for an actual stitched result, never merely a requested mode. */
  fullPage: boolean;
  /** Optional for arithmetic-only callers; capture callers must supply it. */
  imageHeight?: number;
}

export interface RegionMapping {
  /** CSS px → image px. */
  scale: number;
  /** Added to a region's scaled y (device px). */
  offsetY: number;
  /** True when tile-scale mapping applies (used for logging/tests). */
  mapped: boolean;
  /** Invalid geometry must never be treated as a safe viewport fallback. */
  valid: boolean;
  reasons: string[];
}

export function regionMappingFor(input: RegionMappingInput): RegionMapping {
  const positive = (n: number) => Number.isFinite(n) && n > 0;
  const reasons: string[] = [];
  if (!positive(input.imageWidth) ||
      (input.imageHeight !== undefined && !positive(input.imageHeight))) {
    reasons.push("capture-image-geometry-missing");
  }
  if (!positive(input.dpr) || !positive(input.viewportWidth) ||
      !Number.isFinite(input.scrollY) || input.scrollY < 0) {
    reasons.push("capture-region-geometry-missing");
  }
  if (reasons.length === 0 && !input.fullPage &&
      Math.abs(input.imageWidth - input.viewportWidth * input.dpr) > 1) {
    reasons.push("capture-viewport-geometry-mismatch");
  }
  if (reasons.length > 0) {
    // Finite placeholders for local preview only; callers must honor valid.
    return { scale: 1, offsetY: 0, mapped: false, valid: false, reasons };
  }
  const scale = input.fullPage ? input.imageWidth / input.viewportWidth : input.dpr;
  const offsetY = input.fullPage ? input.scrollY * scale : 0;
  if (!positive(scale) || !Number.isFinite(offsetY)) {
    return { scale: 1, offsetY: 0, mapped: false, valid: false,
      reasons: ["capture-region-transform-invalid"] };
  }
  return { scale, offsetY, mapped: input.fullPage, valid: true, reasons: [] };
}

// ─── What gets painted, and what the audit is told was painted ──────────────
//
// These two functions exist because the painter and the reporter used to
// compute the same rectangle DIFFERENTLY. The offscreen pipeline filled
// `rx/ry/rw/rh` (padded, clamped, offset) but reported `region.x * scale` — so
// every proof marker in the audit sat a few pixels up-and-left of its mask, and
// drifted far off it wherever clamping or the full-page offset applied. The fix
// is structural rather than arithmetic: one function decides the rectangle, and
// the box the audit draws is derived FROM that rectangle. They cannot disagree
// again without deleting a function.

/** CSS-pixel padding added around every region before painting. */
export const REGION_PAINT_PADDING_CSS_PX = 4;

/** A region to redact, measured in viewport CSS pixels. */
export interface PaintCandidate {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The device-pixel rectangle actually painted on the capture. */
export interface PaintedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Box in the 0-1 convention the audit overlays and VLM coordinates use. */
export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaintGeometry {
  /** CSS px → image px (DPR, or tile scale for a stitched capture). */
  scale: number;
  /** Device px added to a region's scaled y (full-page scroll offset). */
  offsetY: number;
  /** Captured image size in device pixels, for clamping. */
  imageWidth: number;
  imageHeight: number;
}

/**
 * Device-pixel rectangle to paint for one region, or null when the region is
 * degenerate or entirely outside the captured image.
 *
 * The scroll offset is applied BEFORE the clamp so a region measured above the
 * fold of a restored viewport still lands on the correct stitched row, and the
 * clamp keeps every painted byte inside the canvas.
 */
export function paintRectFor(
  region: PaintCandidate,
  geometry: PaintGeometry,
  paddingCssPx: number = REGION_PAINT_PADDING_CSS_PX,
): PaintedRect | null {
  const { scale, offsetY, imageWidth, imageHeight } = geometry;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  if (!Number.isFinite(offsetY)) return null;
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight)) return null;

  const padding = paddingCssPx * scale;
  const x = Math.max(0, Math.round(region.x * scale - padding));
  const y = Math.max(0, Math.round(region.y * scale + offsetY - padding));
  const width = Math.min(imageWidth - x, Math.round(region.width * scale + padding * 2));
  const height = Math.min(imageHeight - y, Math.round(region.height * scale + padding * 2));
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * The box the audit draws for a painted rectangle.
 *
 * Derived from the painted rect, never from the source region, so a marker can
 * only be wrong if the paint was wrong. Zero-sized images return a zero box
 * rather than NaN — a NaN coordinate would silently drop the marker, which is
 * the failure this replaced.
 */
export function normalizePaintedRect(
  rect: PaintedRect,
  imageWidth: number,
  imageHeight: number,
): NormalizedBox {
  if (!Number.isFinite(imageWidth) || imageWidth <= 0 ||
      !Number.isFinite(imageHeight) || imageHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return {
    x: rect.x / imageWidth,
    y: rect.y / imageHeight,
    width: rect.width / imageWidth,
    height: rect.height / imageHeight,
  };
}
