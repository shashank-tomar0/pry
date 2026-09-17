/**
 * Adversarial redaction attack — the module that tries to UNDO PRY's own work.
 *
 * WHY THIS EXISTS
 *
 * The existing auditor re-reads the shipped frame with OCR and complains when it
 * can still read something. That catches a blur that left text legible, but it
 * is blind to the attack the project's own threat model names first: a soft
 * redaction is a low-pass filter, and a low-pass filter is invertible given the
 * kernel. A blurred region can look convincingly destroyed to OCR and still be
 * recoverable by deconvolution or super-resolution — which is exactly the claim
 * PRY makes about *other* tools' redactions and must therefore survive about its
 * own.
 *
 * So this module attacks the shipped pixels:
 *
 *   1. RECONSTRUCTION — sharpen (unsharp mask, i.e. a crude deconvolution) each
 *      soft-tier region and measure HOW MUCH OF THE ORIGINAL'S EDGE ENERGY
 *      SURVIVED in the shipped pixels. An opaque fill has none; a blur leaves a
 *      fraction, and that residual fraction is the honest measure of "how much
 *      of the secret is still in there".
 *
 *      The decision rests on the RESIDUAL, and the measured reason is worth
 *      recording because the obvious alternative — "how much energy does the
 *      sharpening bring back?" — was implemented first and is WRONG. Measured
 *      against PRY's own box blur (see scripts/verify-pipeline.mjs, which pins
 *      both sides of this):
 *
 *        radius 12 (shipped at scale 2)    residual 0.05   sharpening gain 0.25
 *        radius  6 (shipped at scale 1)    residual 0.15   sharpening gain 0.44
 *        radius  2 (a weakened blur)       residual 0.47   sharpening gain 0.82
 *        opaque fill                       residual 0.00   sharpening gain 0.00
 *
 *      Sharpening gain rises with the amount and with repeated passes, but not
 *      with recoverability: three cheap passes at amount 4 push a well-destroyed
 *      radius-12 blur to a gain ABOVE 1.0, because iterated unsharp at a region
 *      edge manufactures ringing rather than restoring lost bandwidth. A gate on
 *      that number would open on every frame and escalate all of them to full
 *      opaque fills — a privacy check that destroys the product it protects.
 *      Residual energy is monotone in how much of the signal band the blur left
 *      behind, so it separates "destroyed" from "dampened" honestly.
 *
 *      What the residual does NOT prove: a low residual is not proof of
 *      irrecoverability. A Gaussian of unknown sigma is still invertible in
 *      principle, and no threshold on a heuristic can certify that pixels are
 *      gone. It certifies only that this probe found nothing to amplify — which
 *      is why the opaque tier exists and why the summary claims to COVER detected
 *      regions rather than to guarantee a frame is clean.
 *   2. FACE COVERAGE — re-run the face detector over the SHIPPED frame and
 *      report any detection that falls outside every region PRY believes it
 *      destroyed. That is a leak the pipeline missed, not a weak mask, and it is
 *      the highest-value thing an adversarial pass can find because no mask can
 *      be as bad as a missing one.
 *
 * Honesty boundaries, stated so the code cannot be read as more than it is:
 *
 *   - The reconstruction gain is a HEURISTIC PROXY for recoverability, not a
 *     reconstruction attack. A mean-unsharp filter is not a learned super-
 *     resolution model, and a region can be recoverable-in-principle while this
 *     measure stays low (a blur wide enough to leave no measurable gradient).
 *     It is calibrated to be conservative: escalate when the gain is high, and
 *     never report a region as "safe".
 *   - The face probe reports DETECTOR-RECOGNISABILITY, not identity. Proving a
 *     face is no longer identifiable needs a face-embedding model, which PRY
 *     does not ship; until it does, "a detector can no longer find it" is the
 *     strongest available statement and is labelled as such.
 *   - Pure functions only: pixel buffers in, verdicts out. No canvas, no DOM, no
 *     chrome APIs, so the verification harness pins every threshold.
 */

/** A pixel buffer, as the offscreen canvas reports it. */
export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Region kinds whose redaction is soft and therefore attackable. */
export interface AttackRegion extends PixelRect {
  kind: string;
  label: string;
}

export interface ReconstructionFinding {
  region: AttackRegion;
  /** Edge energy of the ORIGINAL region (0 when there was nothing to leak). */
  originalEnergy: number;
  /** Edge energy of the shipped region. */
  shippedEnergy: number;
  /**
   * Shipped energy as a fraction of the original — how much of the region's
   * structure survived the redaction. THIS is what the decision rests on.
   */
  residualFraction: number;
  /**
   * Shipped energy after one sharpening pass, as a fraction of the original:
   * reported as supporting evidence that the surviving structure is amplifiable,
   * never used as the gate. See the module header for why.
   */
  recoveredFraction: number;
  /** Human-readable line for the audit reason list. */
  reason: string;
}

/**
 * Residual energy at or above this fraction of the original means the redaction
 * dampened the region rather than destroying it.
 *
 * CALIBRATION, and its honest limit. Measured against PRY's own box blur across
 * five content patterns (fine 2px strokes at a 4px pitch through 6px strokes at
 * a 12px pitch — /tmp sweep recorded in the verify harness's sibling comment):
 *
 *   radius 12 (shipped at scale 2)  residual 0.05 – 0.15  → silent
 *   radius  8                      residual 0.08 – 0.26  → silent
 *   radius  6 (shipped at scale 1) residual 0.08 – 0.20  → silent
 *   radius  4                      residual 0.16 – 0.38  → silent on fine content
 *   radius  3                      residual 0.21 – 0.69  → FIRES on coarse content
 *   radius  2                      residual 0.29 – 0.97  → FIRES on coarse content
 *   no blur at all (residual 1.0)  and opaque (0.0)      → FIRES / silent
 *
 * The shipped radii top out at 0.20 residual on coarse content while a weakened
 * radius-3 blur starts at 0.21 — the two ranges TOUCH. So this threshold is a
 * coarse guard, not a meter, and 0.35 is chosen to buy real margin above every
 * shipped reading (2.6× the worst one) at the cost of missing a marginal
 * weakening. What it reliably catches:
 *
 *   - the blur silently doing NOTHING (the documented `ctx.filter` no-op risk,
 *     residual 1.0 on every content pattern);
 *   - the radius losing its `* scale` factor or being "optimised" down to ~2 on
 *     coarse content;
 *   - any opaque region reverting to a blur.
 *
 * What it will NOT catch, stated so nobody reads it as more: a subtle change
 * (radius 6 → 4 on fine content) leaves a residual this probe cannot distinguish
 * from the shipped behavior at all. Separating those needs a real deconvolution
 * or a learned reconstruction, not a gradient heuristic — see the module header.
 */
export const RECONSTRUCTION_THRESHOLD = 0.35;

/**
 * Below this much ORIGINAL edge energy a region held no structure worth
 * protecting: a blank field blurred over a white page has nothing to leak, and
 * demanding an opaque fill of every empty input would black out whole forms.
 * Measured in the same units as `edgeEnergy` (mean gradient magnitude 0-255).
 */
export const MIN_ORIGINAL_ENERGY = 8;

/** Unsharp radius in device pixels — roughly the blur radius it is reversing. */
export const UNSHARP_RADIUS_PX = 3;

/**
 * Unsharp amount for the evidence pass. 1.0 is the classic amount; it only has
 * to demonstrate that the residual is amplifiable, so it stays conservative.
 */
export const UNSHARP_AMOUNT = 1.0;

/** Luminance at a pixel, 0-255. */
function luma(img: PixelImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0;
  const i = (y * img.width + x) * 4;
  return (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
}

/**
 * Mean |horizontal + vertical gradient| over a region, sampled on a stride.
 *
 * A stride of 3 with a per-row phase offset (the same defence `regionVariance`
 * uses) stops periodic content from aliasing itself into a flat reading.
 */
export function edgeEnergy(img: PixelImage, rect: PixelRect): number {
  const x1 = Math.max(0, Math.floor(rect.x));
  const y1 = Math.max(0, Math.floor(rect.y));
  const x2 = Math.min(img.width, Math.ceil(rect.x + rect.width));
  const y2 = Math.min(img.height, Math.ceil(rect.y + rect.height));
  if (x2 - x1 < 3 || y2 - y1 < 3) return 0;

  let sum = 0;
  let count = 0;
  for (let y = y1 + 1, row = 0; y < y2 - 1; y += 3, row++) {
    for (let x = x1 + 1 + (row % 3); x < x2 - 1; x += 3) {
      const gx = Math.abs(luma(img, x + 1, y) - luma(img, x - 1, y));
      const gy = Math.abs(luma(img, x, y + 1) - luma(img, x, y - 1));
      sum += gx + gy;
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Unsharp mask over one region, in a copy.
 *
 * The high-pass term is `pixel - box_mean`, scaled by `amount` and added back.
 * That is the cheapest reversible filter there is: applying it to a box-blurred
 * patch pushes the surviving low-frequency residue back toward the original
 * edges, which is all a probe needs to do to show that the information is still
 * present.
 */
export function unsharpRegion(
  img: PixelImage,
  rect: PixelRect,
  radius: number = UNSHARP_RADIUS_PX,
  amount: number = UNSHARP_AMOUNT,
): PixelImage {
  const out: PixelImage = {
    width: img.width,
    height: img.height,
    data: new Uint8ClampedArray(img.data),
  };
  const x1 = Math.max(1, Math.floor(rect.x));
  const y1 = Math.max(1, Math.floor(rect.y));
  const x2 = Math.min(img.width - 1, Math.ceil(rect.x + rect.width));
  const y2 = Math.min(img.height - 1, Math.ceil(rect.y + rect.height));
  const r = Math.max(1, Math.round(radius));

  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let n = 0;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const px = x + dx;
            const py = y + dy;
            if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
            sum += img.data[(py * img.width + px) * 4 + c];
            n++;
          }
        }
        if (n === 0) continue;
        const mean = sum / n;
        const idx = (y * img.width + x) * 4 + c;
        const sharp = img.data[idx] + amount * (img.data[idx] - mean);
        out.data[idx] = sharp < 0 ? 0 : sharp > 255 ? 255 : sharp;
      }
    }
  }
  return out;
}

/**
 * Attack the shipped frame and report every soft region whose content the blur
 * dampened rather than destroyed.
 *
 * `original` is the pre-redaction capture, needed to know how much energy the
 * region USED to carry: a region that was already blank has nothing to recover,
 * and reporting it as a leak would be a false alarm on every empty field.
 */
export function attackSoftRegions(
  original: PixelImage,
  shipped: PixelImage,
  regions: readonly AttackRegion[] | undefined,
  options: {
    threshold?: number;
    radius?: number;
    amount?: number;
    minOriginalEnergy?: number;
  } = {},
): ReconstructionFinding[] {
  const threshold = options.threshold ?? RECONSTRUCTION_THRESHOLD;
  const radius = options.radius ?? UNSHARP_RADIUS_PX;
  const amount = options.amount ?? UNSHARP_AMOUNT;
  const minOriginalEnergy = options.minOriginalEnergy ?? MIN_ORIGINAL_ENERGY;
  const findings: ReconstructionFinding[] = [];

  for (const region of regions ?? []) {
    const originalEnergy = edgeEnergy(original, region);
    // Nothing was there: a blank field cannot leak, and demanding an opaque fill
    // of every empty input would black out whole forms for no gain.
    if (originalEnergy < minOriginalEnergy) continue;

    const shippedEnergy = edgeEnergy(shipped, region);
    const residualFraction = shippedEnergy / originalEnergy;
    const recoveredEnergy = edgeEnergy(unsharpRegion(shipped, region, radius, amount), region);

    if (residualFraction < threshold) continue;

    findings.push({
      region,
      originalEnergy,
      shippedEnergy,
      residualFraction,
      recoveredFraction: recoveredEnergy / originalEnergy,
      reason:
        `"${region.label}" (${region.kind}) was dampened, not destroyed: ` +
        `${Math.round(residualFraction * 100)}% of the original edge energy is still in the ` +
        `shipped pixels (a destroyed region reads under ${Math.round(threshold * 100)}%). ` +
        `A blur is a linear filter, so this region belongs on the opaque path.`,
    });
  }

  return findings;
}

/**
 * Faces the detector can still find in the SHIPPED frame, outside every region
 * the pipeline believes it destroyed.
 *
 * These are coverage failures rather than weak masks, and they are reported
 * separately for that reason: a missed face is a readable face, and no amount of
 * escalation inside the known regions fixes it.
 */
export function uncoveredFaceBoxes(
  boxes: ReadonlyArray<PixelRect> | undefined,
  covered: ReadonlyArray<PixelRect> | undefined,
  coverage: number = 0.5,
): PixelRect[] {
  const regions = covered ?? [];
  return (boxes ?? []).filter((box) => {
    const area = box.width * box.height;
    if (area <= 0) return false;
    return !regions.some((region) => {
      const left = Math.max(box.x, region.x);
      const top = Math.max(box.y, region.y);
      const right = Math.min(box.x + box.width, region.x + region.width);
      const bottom = Math.min(box.y + box.height, region.y + region.height);
      if (right <= left || bottom <= top) return false;
      return ((right - left) * (bottom - top)) / area >= coverage;
    });
  });
}
