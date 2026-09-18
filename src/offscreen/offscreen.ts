/**
 * Offscreen Document
 *
 * Manifest V3 service workers cannot access DOM APIs, WebGPU, or run
 * long-lived inference. This offscreen document provides the environment for:
 *   1. DOM-guided screenshot redaction (masking/blurring PII regions)
 *   2. Face detection (BlazeFace over the frame and over tiles of it →
 *      Chrome FaceDetector → skin-colour)
 *   3. Canvas-based redaction engine
 *
 * Redaction tiers, weakest to strongest:
 *   - blur      : the soft tier, for non-identifying fields (input_field,
 *                 credential_label). Deterministic, and escalated to an
 *                 opaque mask if the adversarial OCR auditor can still read
 *                 anything inside it (see the escalation pass below).
 *   - surrogate : real pixels replaced by a synthetic value, for confirmed
 *                 credential fields.
 *   - opaque    : zero-entropy solid fill. Used for text PII, and for FACES.
 *                 Faces are deliberately NOT blurred — blur is recoverable by
 *                 super-resolution deanonymization (arXiv 2506.12344), and a
 *                 reversible redaction of a biometric identifier is not a
 *                 redaction.
 *
 * The key insight: instead of trying to detect PII from the image (which
 * requires heavy ML models), we use the DOM to KNOW where sensitive data
 * is on screen, then redact those exact pixel regions.
 *
 * Communication: service worker sends messages here via sendMessage.
 * Results are sent back via chrome.runtime.sendMessage (NOT sendResponse).
 */

import {
  verifyRegions,
  emptyVerification,
  detectPIIInText,
  layoutRegionCrops,
  ocrCheckableRegions,
  escalationDecision,
} from "../background/reocr-verification";
import {
  attackSoftRegions,
  uncoveredFaceBoxes,
  type PixelRect,
  type ReconstructionFinding,
} from "../background/redaction-attack";
import { tierForKind, type RegionTier } from "../shared/region-paint";
import { ocrDataUrl, ocrWordLines, warmOcrWorker } from "./ocr";
import {
  findTriageBoxes,
  dropCoveredBoxes,
  capTriageBoxes,
  type OcrLine,
  type TriageBox,
} from "../shared/ocr-pii-triage";
import type { ProcessedScreenshotResult, ScreenshotProtection, VerificationResult } from "../shared/types";
import { detectSpans, warmUpNer } from "../ml/ner";
import { classifyInjection, warmUpGuard } from "../ml/guard";
import { FilesetResolver, FaceDetector as MpFaceDetector } from "@mediapipe/tasks-vision";
import { tileLooksReadable } from "../shared/frame-text";
import {
  coversExistingFace,
  dedupeFaceBoxes,
  mergeFaceBoxes,
  planFaceTiles,
  shouldRunSecondaryFaceDetector,
  type FaceBox,
} from "../shared/face-regions";
import { normalizePaintedRect } from "../shared/region-mapping";
import {
  BLUR_RADIUS_CSS_PX,
  OPAQUE_FILL,
  planRegionPaints,
  SURROGATE_BORDER,
  SURROGATE_FILL,
  SURROGATE_TEXT_FILL,
} from "../shared/region-paint";
import { deriveOffscreenProtection } from "../shared/screenshot-protection";

// ─── BlazeFace (real face detection, Tier 0) ────────────────────────────────
// Replaces the skin-color heuristic as the PRIMARY face channel. The model
// (~224 KB tflite, vendored) runs via MediaPipe tasks-vision on a CPU delegate
// inside the offscreen document. The skin-color blob detector remains the
// fallback for the case the model files are absent.

let blazeFacePromise: Promise<MpFaceDetector | null> | null = null;
let blazeFaceFailed = false;

async function getBlazeFace(): Promise<MpFaceDetector | null> {
  if (blazeFaceFailed) return null;
  if (!blazeFacePromise) {
    blazeFacePromise = (async () => {
      const files = await FilesetResolver.forVisionTasks(
        chrome.runtime.getURL("vendor/mediapipe/wasm"),
      );
      const modelAssetPath = chrome.runtime.getURL("models/blazeface/face_detection_short_range.tflite");
      
      // WebGPU acceleration: attempt GPU delegate first for 10x tensor speedup.
      // If WebGPU is not supported or fails, seamlessly fall back to CPU delegate.
      try {
        if ("gpu" in navigator && (navigator as any).gpu) {
          return await MpFaceDetector.createFromOptions(files, {
            baseOptions: { modelAssetPath, delegate: "GPU" },
            runningMode: "IMAGE",
            minDetectionConfidence: 0.28,
          });
        }
      } catch {
        // Fallback to CPU below
      }

      return await MpFaceDetector.createFromOptions(files, {
        baseOptions: { modelAssetPath, delegate: "CPU" },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.28,
      });
    })().catch(() => {
      blazeFaceFailed = true;
      return null;
    });
  }
  const detector = await blazeFacePromise;
  return detector ?? null;
}

/**
 * BlazeFace pass over the ORIGINAL pixels. Boxes come back in image pixel
 * coordinates — the same space the caller's blur loop already works in.
 */
async function detectFacesWithBlazeFace(
  canvas: OffscreenCanvas,
): Promise<Array<{ x: number; y: number; width: number; height: number; confidence: number }>> {
  const detector = await getBlazeFace();
  if (!detector) return [];
  const bitmap = await createImageBitmap(canvas);
  try {
    const result = await detector.detect(bitmap);
    return (result.detections ?? [])
      .map((d) => {
        const bb = d.boundingBox ?? { originX: 0, originY: 0, width: 0, height: 0 };
        return {
          x: bb.originX,
          y: bb.originY,
          width: bb.width,
          height: bb.height,
          confidence: d.categories?.[0]?.score ?? 0.8,
        };
      })
      .filter((f) => f.width > 16 && f.height > 16);
  } finally {
    bitmap.close();
  }
}

/**
 * The tiled pass: the SAME detector over overlapping NATIVE-RESOLUTION crops.
 *
 * Why this exists, in one number. The model's input is a fixed ~128×128, so a
 * whole 1280×800 viewport is scaled to 0.1 before the first convolution: a 44 px
 * thumbnail face — the one reported at 359,198 — arrives as ~4 px and is lost
 * before any threshold can see it. That is a resolution problem, not a
 * sensitivity problem, so no confidence tuning fixes it; only handing the model
 * a bigger version of the face does. Each 375 px crop scales at ~0.34, which puts
 * that same face at ~15 px in model space.
 *
 * Tiles are drawn at 1:1 from the frame, so boxes come back in FRAME pixels after
 * the tile offset — the same space the blur loop and the audit already use.
 * Overlapping tiles report one face several times, so the results are deduped
 * (see dedupeFaceBoxes) before they reach the paint loop: a face must be painted
 * once, not once per tile that happened to contain it.
 */
async function detectFacesWithBlazeFaceTiles(
  canvas: OffscreenCanvas,
  width: number,
  height: number,
): Promise<Array<{ x: number; y: number; width: number; height: number; confidence: number }>> {
  const detector = await getBlazeFace();
  if (!detector) return [];
  const tiles = planFaceTiles(width, height);
  if (tiles.length === 0) return [];
  const found: Array<{ x: number; y: number; width: number; height: number; confidence: number }> = [];
  for (const tile of tiles) {
    const tileCanvas = new OffscreenCanvas(tile.width, tile.height);
    const tileCtx = tileCanvas.getContext("2d")!;
    tileCtx.drawImage(canvas, tile.x, tile.y, tile.width, tile.height, 0, 0, tile.width, tile.height);
    const bitmap = await createImageBitmap(tileCanvas);
    try {
      const result = await detector.detect(bitmap);
      for (const detection of result.detections ?? []) {
        const bb = detection.boundingBox ?? { originX: 0, originY: 0, width: 0, height: 0 };
        if (!(bb.width > 16 && bb.height > 16)) continue;
        found.push({
          x: bb.originX + tile.x,
          y: bb.originY + tile.y,
          width: bb.width,
          height: bb.height,
          confidence: detection.categories?.[0]?.score ?? 0.8,
        });
      }
    } finally {
      bitmap.close();
    }
  }
  return found;
}

// ─── Chrome FaceDetector API (Chrome 100+, Shape Detection API) ─────────────

declare class FaceDetector {
  constructor(options?: { fastMode?: boolean; maxDetectedFaces?: number });
  detect(image: ImageBitmap | HTMLCanvasElement): Promise<Array<{
    boundingBox: { x: number; y: number; width: number; height: number };
  }>>;
}

let chromeFaceDetector: FaceDetector | null = null;

async function getChromeFaceDetector(): Promise<FaceDetector | null> {
  if (chromeFaceDetector) return chromeFaceDetector;
  try {
    if (typeof FaceDetector !== "undefined") {
      chromeFaceDetector = new FaceDetector({ fastMode: true, maxDetectedFaces: 10 });
      return chromeFaceDetector;
    }
  } catch {
    // Not available in this context.
  }
  return null;
}

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * One entry in the frame's audit detection list.
 *
 * NOTE the `kind` vocabulary is the AUDIT vocabulary, not the model-facing
 * `DetectedPII["kind"]` union: a password box reports as `password`, a card box
 * as `credit_card`, and the side panel's colour map has a deliberate entry for
 * each (red for secrets, violet for identifiers). The previous code typed this
 * list as `DetectedPII[]` and cast every write with `as any`, which is how field
 * kinds came to sit outside the type they were declared to be.
 */
interface AuditDetection {
  kind: string;
  box?: { x: number; y: number; width: number; height: number };
  confidence: number;
  label: string;
  /**
   * The tier this region was ACTUALLY painted with — recorded where the paint
   * decision is made, not recomputed by whoever displays it.
   *
   * Every consumer used to re-derive this from `kind` (the inspector kept its
   * own hand-copied rule), so a detection could be displayed as `opaque` by a
   * viewer that disagreed with the painter — and a face left unpainted was
   * labelled solid black on the very image meant to prove it was redacted.
   * The tier now travels with the report.
   */
  tier: RegionTier;
}

interface SensitiveRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: string;
  label: string;
  value?: string;
}

// ─── Skin-Color Face Detection ──────────────────────────────────────────────
//
// A simple but effective heuristic: scan the image for clusters of skin-colored
// pixels. Not as accurate as a proper face detector, but works in any context
// without ML model dependencies. Good enough for the privacy pipeline.

/** Check if an RGB pixel is likely skin-colored (works across skin tones). */
function isSkinColor(r: number, g: number, b: number): boolean {
  // Combined rule using multiple color spaces for robustness.
  // Works across diverse skin tones by checking multiple ranges.

  // Rule 1: RGB heuristic (works for most skin tones).
  const rgbRule =
    r > 95 && g > 40 && b > 20 &&
    r > g && r > b &&
    Math.abs(r - g) > 15 &&
    r - b > 15;

  // Rule 2: Normalized RGB (handles lighting variation).
  const sum = r + g + b;
  if (sum === 0) return false;
  const nr = r / sum;
  const ng = g / sum;
  const nb = b / sum;
  const normalizedRule =
    nr > 0.28 && nr < 0.55 &&
    ng > 0.18 && ng < 0.42 &&
    nb > 0.08 && nb < 0.32 &&
    nr > nb;

  // Rule 3: YCbCr chrominance color space (standard invariant against lighting and shadows).
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const ycbcrRule = cb >= 77 && cb <= 135 && cr >= 130 && cr <= 177;

  return rgbRule || normalizedRule || ycbcrRule;
}

/**
 * Detect face-like regions using skin-color clustering.
 * Returns bounding boxes of likely face regions.
 */
function detectFacesBySkinColor(
  imageData: ImageData,
  canvasWidth: number,
  canvasHeight: number,
): Array<{ x: number; y: number; width: number; height: number; confidence: number }> {
  const { data } = imageData;
  const blockSize = 12; // Sample every 12 pixels for speed.
  const minClusterSize = 40; // Minimum skin pixels to count as a face region.

  // Build a skin-color mask.
  const mask = new Uint8Array(canvasWidth * canvasHeight);
  for (let i = 0; i < mask.length; i++) {
    const px = i * 4;
    mask[i] = isSkinColor(data[px], data[px + 1], data[px + 2]) ? 1 : 0;
  }

  // Find connected skin regions using simple grid-based clustering.
  const regions: Array<{ x: number; y: number; width: number; height: number; confidence: number }> = [];
  const visited = new Uint8Array(mask.length);

  for (let by = 0; by < canvasHeight; by += blockSize) {
    for (let bx = 0; bx < canvasWidth; bx += blockSize) {
      const idx = by * canvasWidth + bx;
      if (!mask[idx] || visited[idx]) continue;

      // BFS to find connected skin region.
      let minX = bx, maxX = bx, minY = by, maxY = by;
      let count = 0;
      const queue = [idx];

      while (queue.length > 0 && count < 2000) {
        const ci = queue.pop()!;
        if (visited[ci]) continue;
        visited[ci] = 1;

        const cx = ci % canvasWidth;
        const cy = Math.floor(ci / canvasWidth);
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);
        count++;

        // Check neighbors (4-connected).
        for (const [dx, dy] of [[0, -blockSize], [0, blockSize], [-blockSize, 0], [blockSize, 0]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= canvasWidth || ny < 0 || ny >= canvasHeight) continue;
          const ni = ny * canvasWidth + nx;
          if (mask[ni] && !visited[ni]) queue.push(ni);
        }
      }

      if (count >= minClusterSize) {
        const regionW = maxX - minX;
        const regionH = maxY - minY;
        const aspectRatio = regionW / regionH;

        // Faces are roughly 1:1 to 1:1.5 aspect ratio. Min size 28px keeps
        // real faces in thumbnails while dropping tiny avatar icons. The
        // per-frame cap on how many of these guesses are ADDED lives in
        // mergeFaceBoxes (shared policy), never here: this scanner's job is
        // to report what it sees, not to decide what the pipeline keeps.
        if (aspectRatio > 0.5 && aspectRatio < 2.0 && regionW > 28 && regionH > 28) {
          regions.push({
            x: minX,
            y: minY,
            width: regionW,
            height: regionH,
            confidence: Math.min(0.9, count / 200),
          });
        }
      }
    }
  }

  // Merge regions that are obviously the same blob. Capping how many of
  // these guesses reach the pipeline happens in mergeFaceBoxes, which can
  // also see the model's boxes — capping here would throw away a real face
  // before the channel that trusts it ever looked.
  return mergeOverlappingRegions(regions);
}

function mergeOverlappingRegions(
  regions: Array<{ x: number; y: number; width: number; height: number; confidence: number }>,
): Array<{ x: number; y: number; width: number; height: number; confidence: number }> {
  if (regions.length <= 1) return regions;

  const merged: typeof regions = [];
  const used = new Set<number>();

  for (let i = 0; i < regions.length; i++) {
    if (used.has(i)) continue;
    let best = regions[i];
    used.add(i);

    for (let j = i + 1; j < regions.length; j++) {
      if (used.has(j)) continue;
      if (regionsOverlap(best, regions[j])) {
        best = mergeRects(best, regions[j]);
        used.add(j);
      }
    }

    merged.push(best);
  }

  return merged;
}

function regionsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return !(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y);
}

// ─── Deterministic Blur ─────────────────────────────────────────────────────
//
// Manual separable box blur on ImageData. ctx.filter = "blur(...)" is not
// guaranteed on OffscreenCanvas in every Chrome build — when it silently
// no-ops, the region never changes and re-OCR verification correctly reports
// it as unredacted (the "WARNING: 0/3 regions" failure). A deterministic
// pixel blur always alters the region, so redaction + verification agree
// everywhere. Cost is trivial for field/face-sized regions.

/**
 * Exported for the verification harness only: it needs PRY's REAL blur so the
 * adversarial probe can be calibrated against the thing it will actually be
 * pointed at ("is the radius this pipeline ships recoverable?") instead of
 * against a blur the test wrote to make itself pass.
 */
export function blurChannel(
  img: { width: number; height: number; data: Uint8ClampedArray },
  channel: number,
  radius: number,
): void {
  const { width: w, height: h, data } = img;
  const tmp = new Float64Array(w * h);
  const span = radius * 2 + 1;

  // Horizontal pass with a sliding window.
  for (let y = 0; y < h; y++) {
    const rowBase = y * w;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const x = Math.min(w - 1, Math.max(0, k));
      sum += data[(rowBase + x) * 4 + channel];
    }
    for (let x = 0; x < w; x++) {
      tmp[rowBase + x] = sum / span;
      const addX = Math.min(w - 1, x + radius + 1);
      const remX = Math.max(0, x - radius);
      sum += data[(rowBase + addX) * 4 + channel] - data[(rowBase + remX) * 4 + channel];
    }
  }

  // Vertical pass with a sliding window, written straight back.
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const y = Math.min(h - 1, Math.max(0, k));
      sum += tmp[y * w + x];
    }
    for (let y = 0; y < h; y++) {
      data[(y * w + x) * 4 + channel] = sum / span;
      const addY = Math.min(h - 1, y + radius + 1);
      const remY = Math.max(0, y - radius);
      sum += tmp[addY * w + x] - tmp[remY * w + x];
    }
  }
}

/**
 * Box-blur an (x, y, w, h) device-pixel region in place on the context.
 * Exported for the harness — see `blurChannel`.
 */
export function boxBlurRegion(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(40, Math.max(2, Math.round(radius)));
  const image = ctx.getImageData(x, y, width, height);
  blurChannel(image, 0, r);
  blurChannel(image, 1, r);
  blurChannel(image, 2, r);
  ctx.putImageData(image, x, y);
}

function mergeRects(
  a: { x: number; y: number; width: number; height: number; confidence: number },
  b: { x: number; y: number; width: number; height: number; confidence: number },
) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
    confidence: Math.max(a.confidence, b.confidence),
  };
}

// ─── Screenshot Processing ──────────────────────────────────────────────────

async function processScreenshot(
  dataUrl: string,
  width: number,
  height: number,
  sensitiveRegions: SensitiveRegion[] = [],
  dpr: number = 1,
  privacy?: {
    destroyFaces: boolean;
    maskCredentials: boolean;
    showRedactionLabels: boolean;
    scanFrameText?: boolean;
  },
  /**
   * Region→image mapping (see the service worker's captureAndProcessScreenshot):
   * DPR for viewport captures; tile scale + scroll offset pre-multiplied for
   * stitched full-page captures.
   */
  regionScale: number = dpr,
  regionOffsetY: number = 0,
  /** Spans the on-device NER already found on this page — see triageFrameText. */
  knownSpans: string[] = [],
  /**
   * Values the DOM channel detected and could NOT place on screen. Handed to
   * the frame-text channel so its verdict on them is evidence rather than a
   * guess — see triageFrameText's `unlocatedText`.
   */
  unlocatedValues: string[] = [],
): Promise<{
  unlocatedText?: ProcessedScreenshotResult["unlocatedText"];
  redactedDataUrl: string;
  detections: Array<{
    kind: string;
    box?: { x: number; y: number; width: number; height: number };
    confidence: number;
    label: string;
    /** The tier actually painted for this region. See AuditDetection. */
    tier: RegionTier;
  }>;
  redactedCount: number;
  processingTimeMs: number;
  verification: VerificationResult;
  /** Egress evidence this document can witness. See screenshot-protection.ts. */
  protection: ScreenshotProtection;
}> {
  const startTime = performance.now();
  console.log(`[PRY Offscreen] Processing ${width}x${height} screenshot, DPR=${dpr}, ${sensitiveRegions.length} DOM regions + face detection`);

  // Load the screenshot into an ImageBitmap.
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const imageBitmap = await createImageBitmap(blob);

  // Create canvas for redaction. willReadFrequently is required: the blur
  // path and verification read pixels back with getImageData/putImageData, and
  // without it Chrome warns (and drops to slow software readback) on every
  // screenshot.
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(imageBitmap, 0, 0);
  imageBitmap.close();

  // Keep an untouched copy of the original pixels: re-OCR verification and the
  // skin-color fallback both compare against the pre-redaction image.
  const originalCanvas = new OffscreenCanvas(width, height);
  const originalCtx = originalCanvas.getContext("2d", { willReadFrequently: true })!;
  originalCtx.drawImage(canvas, 0, 0);

  // Every region actually redacted, in device-pixel coordinates, so the
  // verification pass can re-scan exactly those pixels in the shipped image.
  const redactionRegions: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    kind: string;
    label: string;
  }> = [];

  const allDetections: AuditDetection[] = [];

  // Scale factor: DOM coordinates are CSS pixels, screenshot is device pixels.
  // Full-page captures fold the tile scale and scroll offset into regionScale
  // / regionOffsetY so the same mapping covers both capture modes.
  const scale = regionScale > 0 ? regionScale : dpr;

  const maskCredentials = privacy?.maskCredentials !== false;
  const destroyFaces = privacy?.destroyFaces !== false;
  const showLabels = privacy?.showRedactionLabels === true;

  // 1. DOM-guided redaction — redact known sensitive regions.
  //
  // The tier decision and the painted rectangle both come from
  // shared/region-paint.ts as a plan, so this loop only executes ops. That
  // matters for more than tidiness: the audit box is read off `op.box`, which
  // was derived from `op.rect` — the rectangle this loop paints. Previously the
  // box was derived from the SOURCE region while the fill used a padded,
  // clamped, scroll-offset rect, so every proof marker sat off its mask (and far
  // off it in full-page mode). One op, one rectangle.
  const paintOps = planRegionPaints(
    sensitiveRegions,
    { scale, offsetY: regionOffsetY, imageWidth: width, imageHeight: height },
    { destroyFaces, maskCredentials },
  );

  for (const op of paintOps) {
    const rect = op.rect;
    if (!rect || !op.box) continue;
    const { x: rx, y: ry, width: rw, height: rh } = rect;

    if (op.tier === "skip") {
      // Face redaction is switched off, or masking is off for this kind: still
      // report the detection, change nothing. Reported with the rect we WOULD
      // have painted, so the panel can show what was left untouched, and
      // deliberately NOT added to redactionRegions — an unpainted region is not
      // a redaction, and counting it as one made the audit's "regions masked"
      // claim larger than the pixels support.
      allDetections.push({
        kind: op.detectionKind,
        box: op.box,
        confidence: 0.95,
        label: `${op.label} — NOT redacted (destruction is off for this kind)`,
        tier: "skip",
      });
      continue;
    }

    if (op.tier === "opaque") {
      // Solid black, zero information left.
      ctx.fillStyle = OPAQUE_FILL;
      ctx.fillRect(rx, ry, rw, rh);
    } else if (op.tier === "blur") {
      // Deterministic blur (see boxBlurRegion): alters pixels on every Chrome
      // build, so re-OCR verification can always confirm the redaction.
      boxBlurRegion(ctx, rx, ry, rw, rh, op.blurRadius ?? BLUR_RADIUS_CSS_PX * scale);
    } else {
      // Synthetic Semantic Surrogate Inpainting: overwrite the real PII pixels
      // with a clean field, then draw a format-preserving synthetic value so
      // downstream visual structure survives.
      ctx.fillStyle = SURROGATE_FILL;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = SURROGATE_BORDER;
      ctx.lineWidth = 1;
      ctx.strokeRect(rx, ry, rw, rh);

      const fontSize = op.fontSizePx ?? Math.max(9, Math.round(Math.min(rh * 0.5, 12 * scale)));
      const pad = op.padPx ?? 4 * scale;
      ctx.fillStyle = SURROGATE_TEXT_FILL;
      ctx.font = `500 ${fontSize}px system-ui, -apple-system, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(op.surrogateText ?? "", rx + pad, ry + rh / 2, Math.max(10, rw - pad * 2));
    }

    allDetections.push({
      kind: op.detectionKind,
      box: op.box,
      confidence: 0.95,
      label: op.label,
      // The plan's own tier — this is the branch that painted it.
      tier: op.tier,
    });
    // Only painted ops reach the verifier, so "regions checked" is exactly the
    // set of regions whose pixels this pipeline claims to have changed.
    redactionRegions.push({ x: rx, y: ry, width: rw, height: rh, kind: op.kind, label: op.label });

    // Optional demo labels: a small chip above the redacted region so viewers
    // can see exactly where PII was hidden. Off by default; only used for demos.
    if (showLabels) {
      const chipText = "🔒 redacted";
      ctx.font = `600 ${Math.max(9, Math.round(10 * scale))}px system-ui, sans-serif`;
      const tw = ctx.measureText(chipText).width;
      const cy = Math.max(0, ry - 14 * scale);
      ctx.fillStyle = "#dc2626";
      ctx.fillRect(rx, cy, tw + 8 * scale, 14 * scale);
      ctx.fillStyle = "#ffffff";
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(chipText, rx + 4 * scale, cy + 7 * scale);
    }
  }

  // 2. Face detection — every channel contributes (see shared/face-regions.ts).
  //
  // This used to be an EXCLUSIVE chain: `if (faceBoxes.length === 0)` guarded
  // both fallbacks, so a single BlazeFace hit suppressed the skin-colour pass.
  // A short-range detector reliably finds one large portrait and reliably
  // misses 40 px thumbnail faces, so on a video grid the pipeline destroyed the
  // big face and shipped every small one — the "faces are not being blacked
  // out" report. The same exclusivity survived between the two MODEL channels
  // (`if (modelFaces.length === 0)` around Chrome's detector), so the fix is the
  // same shape here: every channel is asked when the evidence says it might know
  // something the others do not, and nothing a channel finds is discarded.
  let modelFaces: FaceBox[] = [];
  // Evidence for the egress contract: a channel counts as "ran" only when it
  // completed without throwing. A model that is missing and a model that threw
  // are the same thing to the guard — no proof — but the reason string they
  // leave behind is not, so the failure is captured rather than swallowed.
  let faceChannelRan = false;
  let faceChannelFailure = "";

  try {
    // ORIGINAL pixels, not `canvas`. The DOM region loop above has already
    // painted black fills onto `canvas`, and the skin-colour pass below
    // deliberately reads `originalCtx` for exactly that reason — but this call
    // passed the redacted canvas, contradicting its own documented contract
    // ("BlazeFace pass over the ORIGINAL pixels"). Feeding masks to the
    // detector is how a face near a redacted field goes undetected and stays
    // readable in a frame the pipeline believes it cleaned.
    const fullFrameFaces = (await detectFacesWithBlazeFace(originalCanvas)).map((f) => ({ ...f, source: "model" as const }));
    faceChannelRan = true;
    if (fullFrameFaces.length > 0) {
      console.log(`[PRY Offscreen] BlazeFace found ${fullFrameFaces.length} faces`);
    }
    // Then the same detector over native-resolution crops, which is the ONLY way
    // a small face survives the model's fixed 128×128 input (see
    // detectFacesWithBlazeFaceTiles). Deduped against the full-frame result, so a
    // large face found by both is one face.
    let tiledFaces: FaceBox[] = [];
    try {
      tiledFaces = (await detectFacesWithBlazeFaceTiles(originalCanvas, width, height)).map(
        (f) => ({ ...f, source: "model" as const }),
      );
    } catch (err) {
      // A tile failure must not cost the full-frame result the pipeline already
      // has — and must not be recorded as "the face channel ran" on its own.
      faceChannelFailure = err instanceof Error ? err.message : String(err);
    }
    const dedupedFaces = dedupeFaceBoxes([...fullFrameFaces, ...tiledFaces]);
    if (dedupedFaces.length > fullFrameFaces.length) {
      console.log(
        `[PRY Offscreen] Face tiles found ${dedupedFaces.length - fullFrameFaces.length} face(s) ` +
        `the full-frame pass missed (${planFaceTiles(width, height).length} tiles)`,
      );
    }
    modelFaces = dedupedFaces;
  } catch (err) {
    faceChannelFailure = err instanceof Error ? err.message : String(err);
    // Fall through to the next channel.
  }

  // Supplementary pass runs BEFORE the secondary model detector, because its
  // output is the evidence that detector is gated on (see
  // shouldRunSecondaryFaceDetector). On the ORIGINAL pixels (not the already
  // redacted canvas, which may contain black masks): it adds faces the model
  // missed and never removes one the model found.
  let skinFaces: FaceBox[] = [];
  try {
    const imageData = originalCtx.getImageData(0, 0, width, height);
    skinFaces = detectFacesBySkinColor(imageData, width, height).map((f) => ({ ...f, source: "skin" as const }));
    faceChannelRan = true;
    if (skinFaces.length > 0) {
      console.log(`[PRY Offscreen] Skin-colour heuristic found ${skinFaces.length} candidate faces`);
    }
  } catch (err) {
    faceChannelFailure = faceChannelFailure || (err instanceof Error ? err.message : String(err));
    // No supplementary channel — the model's boxes still stand.
  }

  // Chrome's FaceDetector — a DIFFERENT algorithm from BlazeFace, asked only
  // when the cheap channels left a face unexplained. This used to be gated on
  // `modelFaces.length === 0`, which is how a large portrait suppressed the one
  // detector that might have seen a 40 px thumbnail face in the same frame.
  if (shouldRunSecondaryFaceDetector(modelFaces, skinFaces)) {
    const chromeDetector = await getChromeFaceDetector();
    if (chromeDetector) {
      try {
        const bitmap = await createImageBitmap(await (async () => {
          const c = new OffscreenCanvas(width, height);
          // Original pixels here too — same reason as BlazeFace above.
          c.getContext("2d")!.drawImage(originalCanvas, 0, 0);
          return c.convertToBlob();
        })());
        const faces = await chromeDetector.detect(bitmap);
        bitmap.close();
        const secondary = faces
          .map((f) => ({
            x: f.boundingBox.x,
            y: f.boundingBox.y,
            width: f.boundingBox.width,
            height: f.boundingBox.height,
            confidence: 0.95,
            source: "model" as const,
          }))
          // The two model channels can now both answer on one frame, so the
          // same face must not be painted and audited twice. A secondary box
          // that only re-finds what BlazeFace already reported is dropped.
          .filter((candidate) => !coversExistingFace(candidate, modelFaces));
        modelFaces = [...modelFaces, ...secondary];
        faceChannelRan = true;
        if (secondary.length > 0) {
          console.log(`[PRY Offscreen] Chrome FaceDetector added ${secondary.length} face(s) BlazeFace missed`);
        }
      } catch (err) {
        faceChannelFailure = faceChannelFailure || (err instanceof Error ? err.message : String(err));
        // The primary model's boxes still stand.
      }
    }
  }

  const faceBoxes = mergeFaceBoxes(modelFaces, skinFaces);
  if (faceBoxes.length > modelFaces.length) {
    console.log(
      `[PRY Offscreen] Face channels fused: ${faceBoxes.length} faces ` +
      `(${modelFaces.length} model + ${faceBoxes.length - modelFaces.length} from skin-colour)`,
    );
  }

  // DOM-detected avatar/profile images arrive as `kind: "face"` regions and
  // are NOT part of faceBoxes (they are DOM regions, painted earlier). They are
  // handled where they are drawn — see the region loop — so that channel stays
  // consistent with this one.

  for (const face of faceBoxes) {
    // Expand face box for fuller coverage. Slightly wider than before: this is
    // now a destructive fill, so the chin/jaw/hairline at the edge of the
    // detector box must be covered too, or the surviving facial outline is
    // itself identifying.
    const expandX = face.width * 0.15;
    const expandY = face.height * 0.15;
    const rx = Math.max(0, Math.round(face.x - expandX));
    const ry = Math.max(0, Math.round(face.y - expandY));
    const rw = Math.min(width - rx, Math.round(face.width + expandX * 2));
    const rh = Math.min(height - ry, Math.round(face.height + expandY * 2));

    if (rw > 10 && rh > 10) {
      if (destroyFaces) {
        // `source` only affects reporting: both channels are heuristics, and
        // both are destroyed the same way.
        // DESTROY, do not blur. A solid opaque fill leaves zero recoverable
        // signal: nothing of the original pixels survives to be
        // super-resolved, deconvolved, or statistically reconstructed. Blur is
        // a low-pass filter and is invertible given the kernel — which is
        // exactly what PRY's own threat model (super-resolution de-blurring)
        // says about everyone else's redaction.
        //
        // The fill is pure black so verification can PROVE the outcome: the
        // region must come back near-uniformly black in the shipped bytes.
        ctx.fillStyle = "#000000";
        ctx.fillRect(rx, ry, rw, rh);

        redactionRegions.push({ x: rx, y: ry, width: rw, height: rh, kind: "face", label: "Face destroyed" });
      }

      allDetections.push({
        kind: "face",
        // The EXPANDED, clamped rectangle — the pixels this loop actually
        // painted — not the raw detector box. Reporting the unexpanded box put
        // the audit marker inside the mask instead of on it.
        box: normalizePaintedRect({ x: rx, y: ry, width: rw, height: rh }, width, height),
        confidence: face.confidence,
        // A face left unpainted says so in its label as well as its tier: the
        // old wording ("Face detected") read as a redaction on the audit image,
        // and the inspector then labelled it `opaque`.
        label: destroyFaces
          ? "Face destroyed (opaque)"
          : "Face detected — NOT redacted (destruction is off for this kind)",
        tier: destroyFaces ? "opaque" : "skip",
      });
    }
  }

  // 2.5 Frame-text triage — the only channel that can see PII the DOM never had.
  //       Every other pixel path starts from the DOM (text nodes, fields,
  //       avatars, detector elements). Text baked into an <img>, a <canvas> or a
  //       video frame is invisible to all of them, so it stayed readable in the
  //       audit's BEFORE/AFTER pair and — with vision on — in the frame that
  //       shipped. This reads the ALREADY-REDACTED canvas back with on-device
  //       OCR and boxes whatever PII is still legible there, which makes it
  //       self-targeting: a DOM-redacted value is a black rectangle and OCR
  //       cannot read it, so what remains is by definition what nothing else
  //       covered. Best-effort and bounded: no OCR, no triage, never a block.
  let triageBoxes = 0;
  let triageDropped = 0;
  let triageRan = false;
  /** Evidence about the values the DOM channel could not place — see the type. */
  let unlocatedText: ProcessedScreenshotResult["unlocatedText"];
  if (privacy?.scanFrameText !== false) {
    try {
      const triage = await triageFrameText(
        canvas, width, height, redactionRegions, knownSpans, unlocatedValues,
      );
      triageRan = triage.ran;
      triageDropped = triage.dropped;
      unlocatedText = triage.unlocatedText;
      for (const box of triage.boxes) {
        ctx.fillStyle = "#000000";
        ctx.fillRect(box.x, box.y, box.width, box.height);
        redactionRegions.push({
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          kind: box.kind,
          label: box.label,
        });
        allDetections.push({
          kind: "image_text",
          // Painted rect, normalised — same rule as every other channel.
          box: normalizePaintedRect(
            { x: box.x, y: box.y, width: box.width, height: box.height },
            width, height,
          ),
          confidence: 0.8,
          label: box.label,
          // Triage paints a solid fill — the opaque tier, always.
          tier: "opaque",
        });
        triageBoxes++;
      }
      console.log(`[PRY Offscreen] Frame-text triage: ${triageBoxes} box(es) painted, ` +
        `${triageDropped} capped, ${triage.tiles} tile(s) examined, ${triage.timedOut ? "PARTIAL (tile budget or timeout)" : "complete"}`);
    } catch {
      // Triage is additive: a failed OCR must never lose the DOM redactions.
    }
  }

  // 3. Convert to Blob. These are `let` because the adversarial auditor may
  // rebuild and re-encode the image (see the escalation pass below) in which
  // case the ESCALATED bytes are the ones that ship.
  let redactedBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  let redactedDataUrl = await blobToDataUrl(redactedBlob);

  // 4. Adversarial verification — decode the EXACT bytes that will be shipped
  // (the post-JPEG image) and re-scan every redacted region, at the pixel level
  // and with a real OCR re-read, to prove the redaction worked.
  let verification: VerificationResult = emptyVerification();
  // Evidence for the egress contract (see shared/screenshot-protection.ts).
  // With no redacted regions there is nothing to re-read, and the pass is
  // complete by definition — treating that as "the scan did not run" would have
  // withheld every frame of a clean page for no reason.
  let finalScanRan = redactionRegions.length === 0;
  let finalScanFailure = "";
  if (redactionRegions.length > 0) {
    try {
      const originalData = originalCtx.getImageData(0, 0, width, height);
      const first = await verifyShippedImage(redactedBlob, originalData, redactionRegions, width, height, { destroyFaces, maskCredentials });
      verification = first.result;

      // 5. ESCALATION — the auditor must REMEDIATE, not just complain.
      //    If OCR could still read PII inside a soft (blur-tier) region, the
      //    blur is proven insufficient. Rebuild the whole frame from the
      //    untouched original pixels with every region destroyed, re-encode,
      //    and verify again. The escalated image is what ships, so the failure
      //    never reaches the model — and the claim that incomplete redactions
      //    are elevated to zero-entropy fills is a description of this code
      //    rather than an aspiration.
      //    The adversarial pass feeds the SAME escalation. A region a
      //    reconstruction probe can still read is no different from a region OCR
      //    can still read: both mean the blur did not destroy the content, and
      //    both must be lifted to an opaque fill before the frame ships.
      //    A PIXEL finding feeds it too. Those are the verifier's own findings —
      //    a destroyed region that is not opaque, a soft region whose paint did
      //    not land — and they were the one class that could not ask for the
      //    rebuild that fixes them, so the frame was withheld instead (see
      //    `escalationDecision`).
      const reconstructionHits = first.attack.reconstruction.length;
      const uncoveredFaces = first.attack.uncoveredFaces;
      const escalation = escalationDecision({
        ocrLeaks: first.ocrLeaks,
        reconstruction: reconstructionHits,
        uncoveredFaces: uncoveredFaces.length,
        attackDetails: first.attack.details,
        pixelFindings: first.pixelFindings,
      });
      if (escalation.escalate) {
        // A face the detector found only in the SHIPPED frame is not in
        // `redactionRegions` — nothing painted it — so the rebuild has to be
        // told about it, or the escalation would repaint the frame and still
        // ship the face. These boxes become real redactions from here on: they
        // are painted, they are reported as detections, and they are re-verified
        // like every other region.
        const escalationRegions = [
          ...redactionRegions,
          ...uncoveredFaces.map((box) => ({
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            kind: "face",
            label: "Face found by the adversarial re-probe",
          })),
        ];
        const escalated = await rebuildWithOpaqueMasks(originalCanvas, escalationRegions, width, height);
        redactedBlob = escalated.blob;
        redactedDataUrl = escalated.dataUrl;
        for (const box of uncoveredFaces) {
          redactionRegions.push({ ...box, kind: "face", label: "Face found by the adversarial re-probe" });
          allDetections.push({
            kind: "face",
            box: normalizePaintedRect(box, width, height),
            confidence: 0.7,
            label: "Face found by the adversarial re-probe",
            // Painted by the opaque rebuild, not by the original plan.
            tier: "opaque",
          });
        }
        const second = await verifyShippedImage(redactedBlob, originalData, escalationRegions, width, height, { destroyFaces, maskCredentials });
        // WHY the rebuild happened. The escalated frame's own leak list is
        // (correctly) empty — the leaks were destroyed — but a record with no
        // trace of what the first paint got wrong is not an audit, it is a
        // clean bill of health for a failure nobody wrote down.
        // `escalation.reasons` now carries the first paint's PIXEL findings too.
        // They were absent before, so when the rebuild was triggered by an
        // unrelated OCR leak the record of what the first paint got wrong — the
        // reversible region — was dropped, and the audit showed a frame whose
        // only recorded story was a clean rebuild.
        const escalationReasons = escalation.reasons;
        verification = {
          ...second.result,
          escalated: true,
          escalationReasons: [...new Set(escalationReasons)],
          // Both passes' EVIDENCE is kept, and the counts are the second pass's
          // own — the numbers that describe the image that actually ships.
          //
          // They used to be overwritten with the first pass's counts, on the
          // theory that the second run attacks a rebuild it just proved clean
          // and therefore reports nothing by construction. That theory is false,
          // and it produced a record that argued with itself: a panel printing
          // "no uncovered face" directly above a FACE COVERAGE line the second
          // probe had just written. A face the re-probe finds on the REBUILT
          // frame is outside every region the rebuild painted — the one kind of
          // finding escalation cannot fix — and the panel's own counts said it
          // did not exist. A count that disagrees with the list under it is
          // worse than no count. What the first paint got wrong is still in
          // `escalationReasons` and in the first pass's details below.
          attack: {
            ...(second.result.attack ?? { ran: true, reconstructableRegions: 0, uncoveredFaces: 0, details: [] }),
            details: [
              ...first.attack.details,
              ...(second.result.attack?.details ?? []),
            ],
          },
          leakedText: verification.leakedText ?? second.result.leakedText,
          summary: second.result.verified
            ? `ESCALATED: ${escalationReason(reconstructionHits, uncoveredFaces.length, first.ocrLeaks, first.pixelFindings.length)}, ` +
              `so every region was destroyed and the image re-verified. ${second.result.summary}`
            : `ESCALATED and still failing: ${second.result.summary}`,
          // (`escalationReason` describes the FIRST paint's findings, which is
          // what the rebuild was for. The shipped image's own findings are
          // `attack` above and `leakedPatterns` on this object.)
        };
      }
      finalScanRan = true;
      console.log(`[PRY Offscreen] Re-OCR verification: ${verification.summary}`);
    } catch (error) {
      finalScanFailure = error instanceof Error ? error.message : String(error);
      verification = {
        verified: false,
        regionsChecked: 0,
        regionsRedacted: 0,
        leakedPatterns: [
          `Re-OCR verification could not run: ${finalScanFailure}`,
        ],
        confidence: 0,
        summary: "WARNING: re-OCR verification could not run.",
        timestamp: Date.now(),
      };
    }
  }

  // The egress contract's evidence, produced where the scans actually ran:
  // this document witnessed its own face pass and its own final scan, so it
  // reports those; the service worker owns the text-channel and geometry halves
  // (see shared/screenshot-protection.ts) because it is the process holding
  // those numbers. Before this, nothing produced the object at all and the
  // guard refused every frame, so the vision path could never ship one.
  const protection = deriveOffscreenProtection({
    faceScanRan: faceChannelRan,
    faceScanFailure: faceChannelFailure || undefined,
    finalScanRan,
    finalScanFailure: finalScanFailure || undefined,
    // Proven leaks only: the pixel re-read and the OCR re-read both write here.
    residualDetections: verification.leakedPatterns?.length ?? 0,
    // …and WHICH ones, so a withheld frame names its region in the transcript
    // instead of reporting a count the user cannot act on.
    residualDetails: verification.leakedPatterns ?? [],
    policyEnabled: destroyFaces && maskCredentials,
  });

  console.log(`[PRY Offscreen] Redacted ${redactionRegions.length} region(s) of ${allDetections.length} detection(s) (${faceBoxes.length} faces, ${sensitiveRegions.length} DOM regions, ${triageBoxes} from frame-text OCR${triageRan ? "" : " (triage unavailable)"}) in ${(performance.now() - startTime).toFixed(0)}ms`);

  return {
    redactedDataUrl,
    detections: allDetections.map((d) => ({
      kind: d.kind,
      box: d.box,
      confidence: d.confidence,
      label: d.label,
      tier: d.tier,
    })),
    // Regions actually masked on the canvas, not the number of things noticed.
    // A face that was detected while face destruction is off is a finding, not
    // a redaction, and counting it inflated the audit's "regions masked" claim
    // above what the pixels support.
    redactedCount: redactionRegions.length,
    processingTimeMs: performance.now() - startTime,
    verification,
    protection,
    // The frame-text channel's verdict on the values the DOM could not place.
    // Absent when no such value was asked about, which is the common case.
    unlocatedText,
  };
}

/** Tile height for frame-text triage. One viewport-ish slice at a time. */
const TRIAGE_TILE_HEIGHT = 900;
/** Never OCR more than this many slices — bounds the worst-case frame cost. */
const TRIAGE_MAX_TILES = 6;
/** Per-tile OCR bound; a tile that times out is reported, not retried. */
const TRIAGE_TILE_TIMEOUT_MS = 8000;
/**
 * Wall-clock budget for the WHOLE triage pass, across all tiles.
 *
 * The per-tile bound above bounds one tile and nothing else: six tiles at 8 s is
 * 48 s of worst case inside a capture the agent loop waits 15 s for, so the frame
 * was given up on and the planner went blind — twice in the reported run ("Frame
 * capture (opening frame) did not finish within 15s", then the same line after
 * the first action). A budget that fits inside that wait turns "no frame at all"
 * into "a frame triaged as far as it got", which is strictly more useful and is
 * what `timedOut` already exists to report. Tiles are read top-down, so the part
 * that is given up is the bottom of the page, and the record says so.
 */
const TRIAGE_TOTAL_BUDGET_MS = 6000;

/**
 * Read the already-redacted canvas back with on-device OCR and return the boxes
 * that still hold legible PII.
 *
 * Tiled on purpose. A stitched full-page capture can be 1280×10000, and handing
 * that to Tesseract in one call costs tens of seconds and a lot of memory; the
 * run would stall waiting for its own privacy check. Slicing keeps each OCR job
 * viewport-sized, and the tile budget bounds the total: a very tall page is
 * triaged from the top down and the shortfall is REPORTED (`timedOut`), never
 * implied to be complete.
 *
 * Returns `ran: false` when OCR was unavailable for every tile — the caller
 * then knows the frame was not triaged at all, which is a different statement
 * from "triaged and clean".
 */
async function triageFrameText(
  canvas: OffscreenCanvas,
  width: number,
  height: number,
  covered: Array<{ x: number; y: number; width: number; height: number }>,
  knownSpans: string[],
  unlocatedValues: string[] = [],
): Promise<{
  boxes: TriageBox[];
  dropped: number;
  tiles: number;
  timedOut: boolean;
  ran: boolean;
  unlocatedText: ProcessedScreenshotResult["unlocatedText"];
}> {
  const tileHeight = Math.min(TRIAGE_TILE_HEIGHT, height);
  const tileCount = Math.min(TRIAGE_MAX_TILES, Math.max(1, Math.ceil(height / tileHeight)));
  const collected: OcrLine[] = [];
  let tilesRun = 0;
  let tilesBlank = 0;
  let timedOut = false;
  // See TRIAGE_TOTAL_BUDGET_MS: the per-tile timeout bounds one tile, and this
  // bounds the pass. Whichever runs out first ends the pass, and either way the
  // result is reported as partial rather than as a complete scan.
  const deadline = Date.now() + TRIAGE_TOTAL_BUDGET_MS;

  for (let index = 0; index < tileCount; index++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      timedOut = true;
      break;
    }
    const top = index * tileHeight;
    const sliceHeight = Math.min(tileHeight, height - top);
    if (sliceHeight <= 0) break;
    try {
      const tile = new OffscreenCanvas(width, sliceHeight);
      const tileCtx = tile.getContext("2d")!;
      // Copy from the REDACTED canvas: whatever is still readable here is what
      // no other channel covered.
      tileCtx.drawImage(canvas, 0, top, width, sliceHeight, 0, 0, width, sliceHeight);
      // Skip blank slices. Most of a page is whitespace or an already-painted
      // black mask, and OCR'ing either one is pure cost in the user's critical
      // path. A slice with almost no mid-tone pixels carries no legible text.
      if (!tileLooksReadable(tileCtx.getImageData(0, 0, width, sliceHeight))) {
        tilesBlank++;
        continue;
      }
      // PNG, not JPEG: compression artifacts around small UI text cost real
      // recognition accuracy, and this image never leaves the machine.
      const tileUrl = await blobToDataUrl(await tile.convertToBlob({ type: "image/png" }));
      const lines = await ocrWordLines(
        tileUrl,
        Math.max(1, Math.min(TRIAGE_TILE_TIMEOUT_MS, deadline - Date.now())),
      );
      if (!lines) {
        // A null result is either "nothing legible in this tile" or a failure;
        // only a total absence across all tiles means OCR itself was down.
        continue;
      }
      tilesRun++;
      for (const line of lines) {
        collected.push({
          words: line.words.map((w) => ({ ...w, y: w.y + top })),
        });
      }
    } catch {
      timedOut = timedOut || index < tileCount - 1;
    }
  }

  // Any tile left unprocessed (budget reached) means partial coverage.
  if (tileCount < Math.ceil(height / tileHeight)) timedOut = true;

  // The unplaceable values ride along with the NER spans: this channel is the
  // designated catch-all for text the DOM never had (image, canvas, video), so
  // it is also the only thing that can say whether a value the DOM could not
  // place is legible in the frame or simply not there at all.
  const spans = [...knownSpans, ...unlocatedValues];
  const found = findTriageBoxes(collected, { spans });
  const uncovered = dropCoveredBoxes(found, covered);
  // Boxes dropCoveredBoxes removed were already covered by a painted region, so
  // they are clean too; only what the CAP discards is left legible.
  const coveredAlready = found.filter((box) => !uncovered.includes(box));
  const { kept, dropped } = capTriageBoxes(uncovered);
  const ran = tilesRun + tilesBlank > 0;

  // Which of the asked-about values are still legible in the shipped frame?
  const wanted = [...new Set(unlocatedValues.map((value) => (value ?? "").trim()).filter(Boolean))];
  const named = (list: TriageBox[], value: string): boolean =>
    list.some((box) => box.value.toLowerCase() === value.toLowerCase());
  const readInFrame = wanted.filter((value) => named(found, value));
  const stillLegible = readInFrame.filter(
    (value) => !named(kept, value) && !named(coveredAlready, value),
  );
  // What the caller may conclude from this, and what it may NOT: a value this
  // channel FOUND and painted (or found already covered) is proven covered. A
  // value it did not find is NOT proven absent — OCR misreads and low-confidence
  // lines are real limits of this channel, which is why it reports `legible`
  // alongside `stillLegible` instead of only the count of survivors. The caller
  // must require `legible === requested` before treating a frame as safe; a bare
  // "stillLegible === 0" would clear a frame on the strength of an OCR miss.

  // `ran` means the frame was EXAMINED, not that it produced boxes: a page that
  // is mostly whitespace was triaged and is clean. Reporting that as "triage
  // unavailable" would be the wrong story for the common case.
  return {
    boxes: kept,
    dropped,
    tiles: tilesRun + tilesBlank,
    timedOut,
    ran,
    unlocatedText: {
      requested: wanted.length,
      // Proof needs pixels to have been read. No OCR means no claim.
      searched: ran && wanted.length > 0,
      legible: readInFrame.length,
      stillLegible: stillLegible.length,
      // Deliberately no samples: masking is a background concern and this
      // document must never hold an unmasked value in a report. The caller
      // already has the value list it supplied, and masks it for the warning.
    },
  };
}

/**
 * Verify ONE candidate shipped image: pixel checks over every redacted region,
 * then a real OCR re-read scoped to exactly those regions.
 *
 * OCR scoping matters. The regions are composited into one strip (crop layout
 * is pure, in reocr-verification) and only that strip is read. Scanning the
 * whole shipped image would flag PII that is legitimately still visible on the
 * page — an email in an inbox row, a phone number in body text — and turn
 * every honest run into a false WARNING.
 *
 * Returns the pixel result plus whichever OCR leaks were found, so the caller
 * can decide whether to escalate. Any OCR failure keeps the pixel result: OCR
 * must never downgrade or discard the pixel verification.
 */
async function verifyShippedImage(
  blob: Blob,
  originalData: ImageData,
  regions: Array<{ x: number; y: number; width: number; height: number; kind: string; label: string }>,
  width: number,
  height: number,
  /** The tiers this frame was painted with — see verifyRegions. */
  policy: { destroyFaces: boolean; maskCredentials: boolean },
): Promise<{ result: VerificationResult; ocrLeaks: string[]; attack: AttackOutcome; pixelFindings: string[] }> {
  const bitmap = await createImageBitmap(blob);
  const verifyCanvas = new OffscreenCanvas(width, height);
  const verifyCtx = verifyCanvas.getContext("2d", { willReadFrequently: true })!;
  verifyCtx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const shippedData = verifyCtx.getImageData(0, 0, width, height);
  let result = verifyRegions(originalData, shippedData, regions, Date.now(), policy);
  // The PIXEL findings of the FIRST paint, captured before the adversarial and
  // OCR passes append their own lines to `leakedPatterns`. The escalation
  // decision needs them as their own class: they were the one kind of finding
  // that could not trigger the rebuild that fixes them. Captured here rather
  // than recovered by string prefix later, because a prefix is a formatting
  // convention and this is a decision.
  const pixelFindings = [...result.leakedPatterns];
  let ocrLeaks: string[] = [];

  // ── Adversarial attack, on the SHIPPED pixels ────────────────────────────
  //
  // Everything above asks "did the redaction happen?". This asks the question
  // the project's own threat model actually cares about: "can I UNDO it?". Two
  // probes, both against the decoded bytes that are about to ship:
  //
  //   1. Reconstruction — the soft (blur) tier is a low-pass filter, and a
  //      low-pass filter is invertible given its kernel. Sharpening each soft
  //      region measures how much of the original's edge energy is still in
  //      there. An opaque fill returns ~0; a blur returns a real fraction, and
  //      that fraction is the honest measure of what is recoverable.
  //   2. Face coverage — re-run the model detector over the SHIPPED frame and
  //      look for any face outside every region the pipeline believes it
  //      destroyed. That is not a weak mask, it is a MISSING one, and no amount
  //      of escalation inside the known regions can fix it.
  //
  // The artifact is built here, next to the pixels, because this is the only
  // place that holds both the original and the exact shipped buffer.
  const attack = await attackShippedFrame(originalData, shippedData, regions, policy, verifyCanvas);
  if (attack.details.length > 0) {
    result = {
      ...result,
      leakedPatterns: [...result.leakedPatterns, ...attack.details],
    };
  }

  try {
    // Only regions that could still hold the USER's pixels are read back — see
    // ocrCheckableRegions for why the surrogate tier is out.
    const layout = layoutRegionCrops(ocrCheckableRegions(regions, policy));
    if (layout.slots.length > 0) {
      const ocrCanvas = new OffscreenCanvas(layout.width, layout.height);
      const ocrCtx = ocrCanvas.getContext("2d")!;
      ocrCtx.fillStyle = "#ffffff";
      ocrCtx.fillRect(0, 0, layout.width, layout.height);
      const regionBitmap = await createImageBitmap(blob);
      for (const slot of layout.slots) {
        ocrCtx.drawImage(
          regionBitmap,
          slot.sx, slot.sy, slot.sw, slot.sh,
          slot.dx, slot.dy, slot.dw, slot.dh,
        );
      }
      regionBitmap.close();

      const ocrText = await ocrDataUrl(await blobToDataUrl(await ocrCanvas.convertToBlob({ type: "image/jpeg", quality: 0.9 })));
      if (ocrText) {
        ocrLeaks = detectPIIInText(ocrText);
        result = {
          ...result,
          ocrRan: true,
          leakedText: ocrLeaks.length > 0 ? ocrText.slice(0, 300) : undefined,
        };
        if (ocrLeaks.length > 0) {
          result.verified = false;
          result.leakedPatterns = [
            ...result.leakedPatterns,
            ...ocrLeaks.map((l) => `OCR: ${l} still readable inside a redacted region`),
          ];
          result.confidence = Math.min(result.confidence, 0.3);
          result.summary =
            `WARNING: OCR found ${ocrLeaks.join(", ")} still readable inside a redacted region. ` +
            `Pixel regions: ${result.regionsRedacted}/${result.regionsChecked} confirmed.`;
        } else {
          result.summary =
            `${result.summary} OCR re-read the redacted regions and found no readable PII.`;
        }
      }
    }
  } catch {
    // OCR is corroboration only — the pixel result above stands.
  }

  // The attack evidence travels with the verification (so the audit panel can
  // show what was probed, not just what failed) and with the leak list (so the
  // escalation pass below treats a recoverable blur exactly like a readable
  // string: something that must not reach the model).
  result = {
    ...result,
    attack: {
      // `ran` means the PROBE ran, not that it found anything — the same
      // distinction the egress contract draws for scan completeness. A probe
      // that could not run (detector missing, pixel read failed) reports false
      // so the audit never implies a frame was attacked when it was not.
      ran: attack.ran,
      reconstructableRegions: attack.reconstruction.length,
      uncoveredFaces: attack.uncoveredFaces.length,
      details: attack.details,
    },
  };

  return { result, ocrLeaks, attack, pixelFindings };
}

/**
 * Why the frame was escalated, as a phrase. Built rather than interpolated
 * inline because the three triggers fire independently and the zero cases read
 * as nonsense ("proved 0 recoverable blur(s) and 1 uncovered face(s)") if the
 * counts are simply concatenated.
 */
function escalationReason(
  reconstructionHits: number,
  uncoveredFaces: number,
  ocrLeaks: string[],
  pixelFindings: number = 0,
): string {
  const reasons: string[] = [];
  if (reconstructionHits > 0) {
    reasons.push(`${reconstructionHits} blur${reconstructionHits === 1 ? "" : "s"} the adversarial pass proved recoverable`);
  }
  if (uncoveredFaces > 0) {
    reasons.push(`${uncoveredFaces} face${uncoveredFaces === 1 ? "" : "s"} the pipeline had not covered`);
  }
  if (ocrLeaks.length > 0) {
    reasons.push(`OCR still reading ${ocrLeaks.join(", ")}`);
  }
  if (pixelFindings > 0) {
    reasons.push(
      `${pixelFindings} region${pixelFindings === 1 ? "" : "s"} the pixel check found unredacted`,
    );
  }
  const last = reasons.pop() ?? "a redaction the auditor could not accept";
  return reasons.length > 0 ? `${reasons.join(", ")} and ${last}` : last;
}

/** What the adversarial pass found on one candidate shipped frame. */
interface AttackOutcome {
  /** True when the reconstruction probe completed (found nothing or not). */
  ran: boolean;
  /** Soft regions a reconstruction probe could still read. */
  reconstruction: ReconstructionFinding[];
  /** Faces the detector still finds outside every destroyed region. */
  uncoveredFaces: PixelRect[];
  /** Human-readable lines, ready for the audit's reason list. */
  details: string[];
}

/**
 * Attack one candidate frame: reconstruction on the soft tier, plus a face
 * coverage re-probe when faces were supposed to be destroyed.
 *
 * Runs on the shipped pixels only. A region painted opaque has no structure to
 * recover, so the probe is silent there — which is what makes escalation
 * convergent: re-running this after a rebuild finds nothing, and the loop
 * cannot oscillate.
 */
async function attackShippedFrame(
  originalData: ImageData,
  shippedData: ImageData,
  regions: Array<{ x: number; y: number; width: number; height: number; kind: string; label: string }>,
  policy: { destroyFaces: boolean; maskCredentials: boolean },
  shippedCanvas: OffscreenCanvas,
): Promise<AttackOutcome> {
  const details: string[] = [];
  let ran = false;
  let reconstruction: ReconstructionFinding[] = [];
  let uncoveredFaces: PixelRect[] = [];

  try {
    // Only the SOFT tier is attackable: `skip` regions were deliberately left
    // alone, and opaque/surrogate regions have had their real pixels discarded.
    const soft = regions
      .filter((r) => tierForKind(r.kind, policy) === "blur")
      .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height, kind: r.kind, label: r.label }));
    if (soft.length > 0) {
      reconstruction = attackSoftRegions(originalData, shippedData, soft);
      for (const finding of reconstruction) details.push(`RECONSTRUCTION: ${finding.reason}`);
    }
    // Nothing on the soft tier means there was nothing to reconstruct: the probe
    // is complete, and an opaque/surrogate-only frame is genuinely not soft-
    // attackable rather than unexamined.
    ran = true;
  } catch {
    // A probe failure must never block a frame the pixel checks already passed.
  }

  if (policy.destroyFaces) {
    try {
      // The model detector only. The skin-colour pass is deliberately excluded:
      // it is a high-recall heuristic with a real false-positive rate, and a
      // false positive here would escalate the frame (blacking out an innocent
      // region) on the strength of a colour histogram.
      //
      // Deliberately NOT the tiled pass either, and the reason is remediation:
      // escalation repaints the regions the pipeline already knows about, so a
      // small face this probe found outside every region would be reported on
      // every frame and could never be fixed by the rebuild that follows it.
      // The tiled pass belongs where detection can still act on what it finds
      // (the main pass above); this probe's job is to catch a LARGE face the
      // pipeline lost between detecting it and shipping the frame.
      //
      // AWAITED, not fire-and-forget: an unawaited probe would hand back an
      // empty finding list before the detector resolved, so the attack would
      // silently report "no uncovered faces" on every frame — a check that
      // always passes, which is worse than no check.
      const shippedFaces = await detectFacesWithBlazeFace(shippedCanvas);
      const covered = regions.filter((r) => r.kind === "face");
      uncoveredFaces = uncoveredFaceBoxes(shippedFaces, covered);
      for (const box of uncoveredFaces) {
        details.push(
          `FACE COVERAGE: a face is still detectable in the shipped image at ` +
          `${Math.round(box.x)},${Math.round(box.y)} (${Math.round(box.width)}×${Math.round(box.height)}), ` +
          `outside every region PRY destroyed — a detection miss, not a weak mask.`,
        );
      }
    } catch {
      // Detector unavailable: the face half reports nothing rather than claiming
      // a clean frame it never probed.
    }
  }

  return { ran, reconstruction, uncoveredFaces, details };
}

/**
 * Last-resort rebuild: paint the ORIGINAL pixels again and destroy every
 * region with an opaque fill. Used when OCR proved a soft region was still
 * readable. Nothing here inspects the original content — the output carries no
 * signal about what was underneath, which is the whole point.
 */
async function rebuildWithOpaqueMasks(
  originalCanvas: OffscreenCanvas,
  regions: Array<{ x: number; y: number; width: number; height: number }>,
  width: number,
  height: number,
): Promise<{ blob: Blob; dataUrl: string }> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(originalCanvas, 0, 0);
  ctx.fillStyle = "#000000";
  for (const region of regions) {
    ctx.fillRect(region.x, region.y, region.width, region.height);
  }
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  return { blob, dataUrl: await blobToDataUrl(blob) };
}

/** Blob → data URL (used for the shipped JPEG and the OCR crop strip). */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Blob read failed"));
    reader.readAsDataURL(blob);
  });
}

// ─── Message Handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    message: {
      type: string;
      requestId?: string;
      dataUrl?: string;
      width?: number;
      height?: number;
      sensitiveRegions?: SensitiveRegion[];
      /** Values the DOM channel detected but could not place — see triageFrameText. */
      unlocatedValues?: string[];
      dpr?: number;
      regionScale?: number;
      regionOffsetY?: number;
      privacy?: {
        destroyFaces: boolean;
        maskCredentials: boolean;
        showRedactionLabels: boolean;
        scanFrameText?: boolean;
      };
      /** NER spans already found on the page, for in-image name triage. */
      knownSpans?: string[];
      text?: string;
    },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: any) => void,
  ) => {
    if (
      message.type === "process-screenshot" &&
      message.dataUrl &&
      message.width &&
      message.height
    ) {
      const reqId = message.requestId;
      processScreenshot(
        message.dataUrl,
        message.width,
        message.height,
        message.sensitiveRegions ?? [],
        message.dpr ?? 1,
        message.privacy,
        message.regionScale ?? message.dpr ?? 1,
        message.regionOffsetY ?? 0,
        message.knownSpans ?? [],
        message.unlocatedValues ?? [],
      )
        .then((result) => {
          // Send result back via sendMessage, NOT sendResponse.
          chrome.runtime.sendMessage({
            type: "screenshot-processed",
            requestId: reqId,
            result,
          });
          sendResponse({ received: true });
        })
        .catch((error) => {
          chrome.runtime.sendMessage({
            type: "screenshot-processed",
            requestId: reqId,
            error: error.message,
          });
          sendResponse({ received: true, error: error.message });
        });
      return true;
    }

    // ─── ML inference (Tier 0) — runs here, never in the service worker ───
    if (message.type === "ml-ner" && typeof message.text === "string") {
      detectSpans(message.text)
        .then((spans) => sendResponse({ ok: true, spans }))
        .catch((err) => sendResponse({ ok: false, spans: [], error: String(err) }));
      return true; // async
    }

    if (message.type === "ml-guard" && typeof message.text === "string") {
      classifyInjection(message.text)
        .then((verdict) => sendResponse({ ok: true, verdict }))
        .catch((err) => sendResponse({ ok: false, verdict: null, error: String(err) }));
      return true; // async
    }

    // ─── Warm the OCR worker ───
    // Fire-and-forget: the self-test below warms the MODELS, but Tesseract was
    // never warmed anywhere, so the first capture of every run paid ~10.5 s of
    // cold start inside the user's first action. See warmOcrWorker.
    if (message.type === "warm-ocr") {
      warmOcrWorker();
      sendResponse({ ok: true, warming: true });
      return false;
    }

    // ─── On-device ML self-test ───
    // Loads each model AND runs one real inference, so the transcript can
    // report "the model works" from evidence rather than from the presence of
    // a file on disk. BlazeFace is reported from the same channel that the
    // redaction path uses.
    if (message.type === "ml-self-test") {
      (async () => {
        const out: Record<string, unknown> = {};
        try {
          out.ner = await warmUpNer();
        } catch (err) {
          out.ner = { ready: false, reason: err instanceof Error ? err.message : String(err) };
        }
        try {
          out.guard = await warmUpGuard();
        } catch (err) {
          out.guard = { ready: false, reason: err instanceof Error ? err.message : String(err) };
        }
        let face = false;
        try {
          face = (await getBlazeFace()) !== null;
        } catch {
          face = false;
        }
        out.face = { ready: face };
        sendResponse({ ok: true, result: out });
      })();
      return true; // async
    }

    return false;
  },
);

console.log("[PRY] Offscreen document initialized — DOM-guided privacy pipeline ready.");
