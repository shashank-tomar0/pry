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
  /** True when the caller is capturing a stitched full-page image. */
  fullPage: boolean;
}

export interface RegionMapping {
  /** CSS px → image px. */
  scale: number;
  /** Added to a region's scaled y (device px). */
  offsetY: number;
  /** True when tile-scale mapping applies (used for logging/tests). */
  mapped: boolean;
}

export function regionMappingFor(input: RegionMappingInput): RegionMapping {
  const dpr = input.dpr > 0 ? input.dpr : 1;
  const mapped = input.fullPage && input.imageWidth > 0 && input.viewportWidth > 0;
  if (!mapped) {
    return { scale: dpr, offsetY: 0, mapped: false };
  }
  // canvasWidth / (viewportCssWidth × dpr) is the tile scale in device px per
  // device px; multiplying by dpr converts it to device px per CSS px, which
  // is the space the regions are measured in.
  const scale = (input.imageWidth / Math.max(1, input.viewportWidth * dpr)) * dpr;
  return {
    scale,
    offsetY: Math.max(0, input.scrollY) * scale,
    mapped: true,
  };
}
