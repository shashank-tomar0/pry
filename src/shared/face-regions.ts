/**
 * Face-box fusion policy for the redaction pipeline.
 *
 * Three face channels exist, in descending precision:
 *   1. BlazeFace (bundled tflite, short-range) — accurate, but a short-range
 *      model misses small faces: thumbnail grids, avatars, video tiles.
 *   2. Chrome's shape-detection FaceDetector — same class of limitation.
 *   3. Skin-colour clustering — noisy, but the only channel that reliably
 *      reaches the 28–120 px faces channels 1 and 2 drop.
 *
 * These used to be an EXCLUSIVE chain (`if (faceBoxes.length === 0)`) inside
 * the offscreen pipeline: one confident BlazeFace hit skipped the skin-colour
 * pass entirely. On a page with one large portrait and a grid of thumbnails,
 * that destroyed the large face and left every thumbnail face fully readable —
 * a privacy tool shipping the exact leak it claims to prevent.
 *
 * Policy here (pure, pinned by scripts/verify-pipeline.mjs):
 *   - Every model box is kept. A confident detection is never trimmed to make
 *     room for a heuristic guess, and never replaced by one.
 *   - Skin boxes are kept only when they cover a distinct area — a skin blob
 *     overlapping an existing box (fraction of the SMALLER box) is the same
 *     face seen twice, not a second face.
 *   - The number of skin-box additions is capped so a photo (skin-like pixels
 *     everywhere) cannot turn a whole page into one opaque wall.
 */

export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  /** Which channel produced the box. `model` boxes are never dropped. */
  source: "model" | "skin";
}

/** Fraction of the smaller box's area that counts as "the same face". */
export const FACE_DUPLICATE_COVERAGE = 0.3;

/** How many skin-colour additions are allowed on top of the model's boxes. */
export const MAX_SKIN_FACE_ADDITIONS = 16;

/** Intersection area of two rectangles (0 when they do not overlap). */
export function overlapArea(a: FaceBox, b: FaceBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

/**
 * True when `candidate` covers enough of any box in `accepted` to be the same
 * face. Coverage is measured against the SMALLER of the two boxes, so a tiny
 * skin blob inside a big detected face is a duplicate rather than a new face.
 */
export function coversExistingFace(
  candidate: FaceBox,
  accepted: FaceBox[],
  coverage: number = FACE_DUPLICATE_COVERAGE,
): boolean {
  const candidateArea = candidate.width * candidate.height;
  if (candidateArea <= 0) return true;
  return accepted.some((existing) => {
    const existingArea = existing.width * existing.height;
    if (existingArea <= 0) return false;
    const smaller = Math.min(candidateArea, existingArea);
    return overlapArea(candidate, existing) / smaller >= coverage;
  });
}

/** Largest first, then most confident — a stable, useful redaction order. */
function byAreaThenConfidence(a: FaceBox, b: FaceBox): number {
  const areaDiff = b.width * b.height - a.width * a.height;
  if (areaDiff !== 0) return areaDiff;
  return b.confidence - a.confidence;
}

/**
 * Should the SECOND model detector be asked for a second opinion on this frame?
 *
 * Chrome's shape-detection `FaceDetector` is a different algorithm from
 * BlazeFace with a different failure mode, and the two disagree most on exactly
 * the case that matters here: small faces. The pipeline used to gate the
 * secondary detector on `model.length === 0` — "BlazeFace found nothing" — the
 * same exclusive-chain shape that had already been removed between the model
 * and skin channels. The consequence on a YouTube results page is concrete: the
 * short-range model finds the one large channel avatar and drops a 40 px
 * thumbnail face, and because SOMETHING was found, the second detector — the one
 * that might have seen it — is never asked. The portrait is destroyed, the
 * thumbnail face ships readable.
 *
 * The gate is therefore evidence-driven rather than count-driven. The supplied
 * skin pass is cheap and has already run; when it reports a face that no model
 * box covers, that is the signature of a face the primary model downscaled away
 * (or of skin-like pixels it was never going to return), and the extra detector
 * is worth its encode. When the primary model already explains every skin blob,
 * the secondary detector is skipped exactly as before — so the common frame
 * costs nothing extra.
 *
 * @param model  boxes from the primary model detector (BlazeFace)
 * @param skin   boxes from the skin-colour heuristic
 */
export function shouldRunSecondaryFaceDetector(
  model: FaceBox[],
  skin: FaceBox[],
  coverage: number = FACE_DUPLICATE_COVERAGE,
): boolean {
  // Nothing detected at all: the secondary detector is the only real detector
  // this frame can still have, so it always gets a turn.
  if (model.length === 0) return true;
  return skin.some((candidate) => !coversExistingFace(candidate, model, coverage));
}

/**
 * Fuse every channel's boxes into the list the redaction loop draws.
 *
 * @param model  boxes from BlazeFace / Chrome FaceDetector (trusted)
 * @param skin   boxes from the skin-colour heuristic (supplementary)
 */
export function mergeFaceBoxes(
  model: FaceBox[],
  skin: FaceBox[],
  opts: { maxSkin?: number; coverage?: number } = {},
): FaceBox[] {
  const maxSkin = opts.maxSkin ?? MAX_SKIN_FACE_ADDITIONS;
  const coverage = opts.coverage ?? FACE_DUPLICATE_COVERAGE;

  const accepted: FaceBox[] = [...model];
  let skinAdded = 0;

  for (const candidate of [...skin].sort(byAreaThenConfidence)) {
    if (skinAdded >= maxSkin) break;
    if (coversExistingFace(candidate, accepted, coverage)) continue;
    accepted.push(candidate);
    skinAdded++;
  }

  return accepted.sort(byAreaThenConfidence);
}
