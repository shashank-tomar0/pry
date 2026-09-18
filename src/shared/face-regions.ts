/**
 * Face-box fusion policy for the redaction pipeline.
 *
 * Three face channels exist, in descending precision:
 *   1. BlazeFace (bundled tflite, short-range) — accurate, but a short-range
 *      model misses small faces: thumbnail grids, avatars, video tiles. It is
 *      also run over overlapping TILES of the frame, because the miss is a
 *      resolution problem (its input is a fixed ~128×128) rather than a
 *      sensitivity one — see planFaceTiles.
 *   2. Chrome's shape-detection FaceDetector — same class of limitation, asked
 *      only when the cheap channels leave a face unexplained.
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

// ─── Tiling: how a short-range face model is made to see a small face ───────
//
// BlazeFace's short-range model has a fixed ~128×128 input, so the image it is
// handed is resized to that before any face is looked for. Handed a whole
// viewport — 1280×800 — that is a scale of 0.1: a 44 px thumbnail face arrives
// as ~4 px and is gone before the first convolution, no matter how good the
// detector is. This is why the reported face at 359,198 was missed, and why
// "tune the confidence threshold" cannot fix it: the pixels are not there.
//
// The remedy is the one the frame-text channel already uses for the same reason
// (see TRIAGE_TILE_HEIGHT in the offscreen document): hand the model a CROP at
// native resolution instead of the whole frame. A 375 px tile scales at 0.34, so
// the same 44 px face arrives as ~15 px — detectable, and detectable because the
// crop made it bigger in model space, not because a threshold was loosened.

/** Largest side a tile should have, in frame pixels. 128/320 ≈ 0.4 scale. */
export const FACE_TILE_TARGET_PX = 320;

/** Overlap between neighbouring tiles, as a fraction of the tile size. A face
 *  on a seam is half in each tile and found in neither, so tiles must overlap. */
export const FACE_TILE_OVERLAP = 0.25;

/** Hard cap on tiles per frame — the whole pass must stay well inside the
 *  frame budget the agent loop allows for a capture. */
export const FACE_TILE_MAX = 16;

/**
 * Frames taller/wider than this are NOT tiled.
 *
 * A stitched full-page capture is the case: tiling 1280×10000 into 320 px crops
 * needs ~130 tiles to cover it, and tiling only part of it would make coverage
 * depend on where the page happened to be cut. Below this bound the tile grid is
 * bounded by FACE_TILE_MAX and covers the frame exactly; above it the caller
 * keeps the single full-frame pass it already had (documented, not silent).
 */
export const FACE_TILE_MAX_FRAME_PX = FACE_TILE_TARGET_PX * 4;

/** Fraction of the SMALLER box's area at which two detections are one face.
 *  Deliberately looser than FACE_DUPLICATE_COVERAGE: overlapping tiles report
 *  the same face from slightly different crops, so their boxes differ. */
export const FACE_TILE_DUPLICATE_COVERAGE = 0.5;

/** One crop of the frame handed to the detector, in frame pixel coordinates. */
export interface FaceTile {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The crops to run the detector over; empty means "do not tile this frame". */
export function planFaceTiles(
  frameWidth: number,
  frameHeight: number,
  opts: { target?: number; maxTiles?: number; overlap?: number } = {},
): FaceTile[] {
  const target = opts.target ?? FACE_TILE_TARGET_PX;
  const maxTiles = opts.maxTiles ?? FACE_TILE_MAX;
  const overlap = opts.overlap ?? FACE_TILE_OVERLAP;
  const width = Math.max(0, Math.floor(frameWidth));
  const height = Math.max(0, Math.floor(frameHeight));
  if (width <= 0 || height <= 0 || target <= 0) return [];

  // Already inside one tile: tiling would be the same pass at the same scale,
  // for the same one detector call. The caller's full-frame pass IS this tile.
  if (Math.max(width, height) <= target) return [];
  // Too large to cover usefully (see FACE_TILE_MAX_FRAME_PX).
  if (Math.max(width, height) > target * 4) return [];

  let cols = Math.max(1, Math.ceil(width / target));
  let rows = Math.max(1, Math.ceil(height / target));
  // Stay inside the tile budget by giving up tiles on the longer axis.
  while (cols * rows > maxTiles) {
    if (cols >= rows && cols > 1) cols--;
    else if (rows > 1) rows--;
    else break;
  }

  const tileW = Math.min(width, Math.ceil((width / cols) * (1 + overlap)));
  const tileH = Math.min(height, Math.ceil((height / rows) * (1 + overlap)));
  const tiles: FaceTile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // Spread the slack across the gaps so the LAST tile always reaches the
      // frame edge — a face in the bottom-right corner must be inside a tile.
      const x = cols === 1 ? 0 : Math.round((col * (width - tileW)) / (cols - 1));
      const y = rows === 1 ? 0 : Math.round((row * (height - tileH)) / (rows - 1));
      tiles.push({
        x,
        y,
        width: Math.min(tileW, width - x),
        height: Math.min(tileH, height - y),
      });
    }
  }
  return tiles;
}

/** Detector boxes are tile-local; the redaction loop works in frame pixels. */
export function offsetFaceBoxes(boxes: readonly FaceBox[], tile: FaceTile): FaceBox[] {
  return boxes.map((box) => ({ ...box, x: box.x + tile.x, y: box.y + tile.y }));
}

/**
 * Collapse the same face reported by several overlapping tiles into one box.
 *
 * Keeps the largest/most confident of each group, so a face clipped by a tile
 * boundary is represented by the tile that saw all of it. Without this, one face
 * on an overlap would be painted and audited up to four times, and the audit's
 * face count would report detections rather than faces.
 */
export function dedupeFaceBoxes(
  boxes: readonly FaceBox[],
  coverage: number = FACE_TILE_DUPLICATE_COVERAGE,
): FaceBox[] {
  const ordered = [...boxes].sort(byAreaThenConfidence);
  const kept: FaceBox[] = [];
  for (const candidate of ordered) {
    if (coversExistingFace(candidate, kept, coverage)) continue;
    kept.push(candidate);
  }
  return kept;
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
