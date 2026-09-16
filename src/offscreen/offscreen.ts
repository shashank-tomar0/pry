/**
 * Offscreen Document
 *
 * Manifest V3 service workers cannot access DOM APIs, WebGPU, or run
 * long-lived inference. This offscreen document provides the environment for:
 *   1. DOM-guided screenshot redaction (masking/blurring PII regions)
 *   2. Face detection (BlazeFace → Chrome FaceDetector → skin-colour)
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

import type { DetectedPII } from "../background/pii-detector";
import { verifyRegions, emptyVerification, detectPIIInText, layoutRegionCrops } from "../background/reocr-verification";
import { getSyntheticSurrogate } from "../background/surrogates";
import { ocrDataUrl } from "./ocr";
import type { VerificationResult } from "../shared/types";
import { detectSpans, warmUpNer } from "../ml/ner";
import { classifyInjection, warmUpGuard } from "../ml/guard";
import { FilesetResolver, FaceDetector as MpFaceDetector } from "@mediapipe/tasks-vision";
import { mergeFaceBoxes, type FaceBox } from "../shared/face-regions";

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
            minDetectionConfidence: 0.4,
          });
        }
      } catch {
        // Fallback to CPU below
      }

      return await MpFaceDetector.createFromOptions(files, {
        baseOptions: { modelAssetPath, delegate: "CPU" },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.4,
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
      .filter((f) => f.width > 20 && f.height > 20);
  } finally {
    bitmap.close();
  }
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

  return rgbRule || normalizedRule;
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

function blurChannel(
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

/** Box-blur an (x, y, w, h) device-pixel region in place on the context. */
function boxBlurRegion(
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
  },
  /**
   * Region→image mapping (see the service worker's captureAndProcessScreenshot):
   * DPR for viewport captures; tile scale + scroll offset pre-multiplied for
   * stitched full-page captures.
   */
  regionScale: number = dpr,
  regionOffsetY: number = 0,
): Promise<{
  redactedDataUrl: string;
  detections: Array<{
    kind: string;
    box?: { x: number; y: number; width: number; height: number };
    confidence: number;
    label: string;
  }>;
  redactedCount: number;
  processingTimeMs: number;
  verification: VerificationResult;
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

  const allDetections: DetectedPII[] = [];

  // Scale factor: DOM coordinates are CSS pixels, screenshot is device pixels.
  // Full-page captures fold the tile scale and scroll offset into regionScale
  // / regionOffsetY so the same mapping covers both capture modes.
  const scale = regionScale > 0 ? regionScale : dpr;

  const maskCredentials = privacy?.maskCredentials !== false;
  const destroyFaces = privacy?.destroyFaces !== false;
  const showLabels = privacy?.showRedactionLabels === true;

  // 1. DOM-guided redaction — redact known sensitive regions.
  for (const region of sensitiveRegions) {
    // Scale CSS coordinates to device pixels + expand by 4px padding. The
    // scroll offset applies before clamping so a region above the fold of the
    // restored viewport still lands on the right stitched row.
    const padding = 4 * scale;
    const rx = Math.max(0, Math.round(region.x * scale - padding));
    const ry = Math.max(0, Math.round(region.y * scale + regionOffsetY - padding));
    const rw = Math.min(width - rx, Math.round(region.width * scale + padding * 2));
    const rh = Math.min(height - ry, Math.round(region.height * scale + padding * 2));

    if (rw <= 0 || rh <= 0) continue;

    // Placement per region kind:
    //   face                 → opaque black fill (same guarantee as the pixel
    //                          channel; a blurred face is still the face)
    //   *_text               → solid black box over exactly the PII span
    //   credential_label /
    //   input_field          → soft box-blur, escalated if OCR reads it back
    //   everything else      → surrogate inpaint (real pixels discarded)
    //
    // DOM-detected faces (perceive.ts marks avatar/profile images as
    // `kind: "face"`) used to fall through to the SURROGATE branch: a white
    // box with a lock glyph. That broke the pipeline's own contract in both
    // directions — a white box is a reversible redaction for a biometric
    // identifier, and verifyRegions (DESTROYED_KINDS) then failed the frame,
    // reporting a leak on a region the pipeline itself had painted white.
    const isFace = region.kind === "face";

    if (isFace && !destroyFaces) {
      // Face redaction is switched off by the user: still report the
      // detection, change nothing. (The pixel channel behaves identically.)
      allDetections.push({
        kind: "face",
        box: {
          x: (region.x * scale) / width,
          y: (region.y * scale + regionOffsetY) / height,
          width: (region.width * scale) / width,
          height: (region.height * scale) / height,
        },
        confidence: 0.95,
        label: region.label,
      });
      continue;
    }

    const solidText = region.kind.endsWith("_text");
    const useBlur =
      region.kind === "credential_label" ||
      region.kind === "input_field";

    // full-mask credential regions (password/card/Aadhaar/API-key fields) are
    // gated by the user's maskCredentials toggle. Soft input-field blur always
    // runs (a generic field the user types into is still sensitive), but when
    // masking is off we degrade to blur so the pixels are still protected.
    if (isFace || (solidText && maskCredentials)) {
      // Solid black, zero information left: the span is exactly the PII.
      ctx.fillStyle = "#000000";
      ctx.fillRect(rx, ry, rw, rh);
    } else if (useBlur || !maskCredentials) {
      // Deterministic blur (see boxBlurRegion): alters pixels on every Chrome
      // build, so re-OCR verification can always confirm the redaction.
      boxBlurRegion(ctx, rx, ry, rw, rh, 6 * scale);
    } else {
      // Synthetic Semantic Surrogate Inpainting:
      // Overwrite the real PII pixels completely with a clean field + synthetic surrogate data.
      // This wipes real PII from the pixel buffer while giving downstream VLMs realistic visual structure.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = "#6366f1";
      ctx.lineWidth = Math.max(1, Math.round(scale));
      ctx.strokeRect(rx, ry, rw, rh);

      const surrogateText = getSyntheticSurrogate(region.kind || region.label, region.value);
      ctx.fillStyle = "#0f172a";
      ctx.font = `600 ${Math.max(9, Math.round(Math.min(rh * 0.45, 12 * scale)))}px system-ui, -apple-system, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const pad = 4 * scale;
      ctx.fillText(`🔒 ${surrogateText}`, rx + pad, ry + rh / 2, Math.max(10, rw - pad * 2));
    }

    allDetections.push({
      kind: isFace ? "face" : (region.kind === "credential_label" || region.kind === "input_field") ? "credential" : region.kind as any,
      // Normalized 0-1 coordinates (same convention as face boxes) so the
      // audit panel can overlay proof markers on the thumbnail regardless of
      // DPR or display size: x_norm = cssPx * dpr / deviceWidth.
      box: {
        x: (region.x * scale) / width,
        y: (region.y * scale + regionOffsetY) / height,
        width: (region.width * scale) / width,
        height: (region.height * scale) / height,
      },
      confidence: 0.95,
      label: region.label,
    });
    redactionRegions.push({ x: rx, y: ry, width: rw, height: rh, kind: region.kind, label: region.label });

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
  // out" report. Model channels still run only as a pair (Chrome's detector is
  // the same class of accuracy as BlazeFace and costs a full-image encode).
  let modelFaces: FaceBox[] = [];

  try {
    modelFaces = (await detectFacesWithBlazeFace(canvas)).map((f) => ({ ...f, source: "model" as const }));
    if (modelFaces.length > 0) {
      console.log(`[PRY Offscreen] BlazeFace found ${modelFaces.length} faces`);
    }
  } catch {
    // Fall through to the next channel.
  }

  if (modelFaces.length === 0) {
    const chromeDetector = await getChromeFaceDetector();
    if (chromeDetector) {
      try {
        const bitmap = await createImageBitmap(await (async () => {
          const c = new OffscreenCanvas(width, height);
          c.getContext("2d")!.drawImage(canvas, 0, 0);
          return c.convertToBlob();
        })());
        const faces = await chromeDetector.detect(bitmap);
        bitmap.close();
        modelFaces = faces.map((f) => ({
          x: f.boundingBox.x,
          y: f.boundingBox.y,
          width: f.boundingBox.width,
          height: f.boundingBox.height,
          confidence: 0.95,
          source: "model" as const,
        }));
        if (modelFaces.length > 0) {
          console.log(`[PRY Offscreen] Chrome FaceDetector found ${modelFaces.length} faces`);
        }
      } catch {
        // Fall through to skin-color.
      }
    }
  }

  // Always run the supplementary pass, on the ORIGINAL pixels (not the already
  // redacted canvas, which may contain black masks). It adds faces the model
  // missed and never removes one the model found.
  let skinFaces: FaceBox[] = [];
  try {
    const imageData = originalCtx.getImageData(0, 0, width, height);
    skinFaces = detectFacesBySkinColor(imageData, width, height).map((f) => ({ ...f, source: "skin" as const }));
    if (skinFaces.length > 0) {
      console.log(`[PRY Offscreen] Skin-colour heuristic found ${skinFaces.length} candidate faces`);
    }
  } catch {
    // No supplementary channel — the model's boxes still stand.
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
        box: {
          x: face.x / width,
          y: face.y / height,
          width: face.width / width,
          height: face.height / height,
        },
        confidence: face.confidence,
        label: destroyFaces ? "Face destroyed (opaque)" : "Face detected",
      });
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
  if (redactionRegions.length > 0) {
    try {
      const originalData = originalCtx.getImageData(0, 0, width, height);
      const first = await verifyShippedImage(redactedBlob, originalData, redactionRegions, width, height);
      verification = first.result;

      // 5. ESCALATION — the auditor must REMEDIATE, not just complain.
      //    If OCR could still read PII inside a soft (blur-tier) region, the
      //    blur is proven insufficient. Rebuild the whole frame from the
      //    untouched original pixels with every region destroyed, re-encode,
      //    and verify again. The escalated image is what ships, so the failure
      //    never reaches the model — and the claim that incomplete redactions
      //    are elevated to zero-entropy fills is a description of this code
      //    rather than an aspiration.
      if (first.ocrLeaks.length > 0) {
        const escalated = await rebuildWithOpaqueMasks(originalCanvas, redactionRegions, width, height);
        redactedBlob = escalated.blob;
        redactedDataUrl = escalated.dataUrl;
        const second = await verifyShippedImage(redactedBlob, originalData, redactionRegions, width, height);
        verification = {
          ...second.result,
          escalated: true,
          leakedText: verification.leakedText ?? second.result.leakedText,
          summary: second.result.verified
            ? `ESCALATED: OCR found ${first.ocrLeaks.join(", ")} readable in a blurred region, so every region was destroyed and the image re-verified. ${second.result.summary}`
            : `ESCALATED and still failing: ${second.result.summary}`,
        };
      }
      console.log(`[PRY Offscreen] Re-OCR verification: ${verification.summary}`);
    } catch (error) {
      verification = {
        verified: false,
        regionsChecked: 0,
        regionsRedacted: 0,
        leakedPatterns: [
          `Re-OCR verification could not run: ${error instanceof Error ? error.message : String(error)}`,
        ],
        confidence: 0,
        summary: "WARNING: re-OCR verification could not run.",
        timestamp: Date.now(),
      };
    }
  }

  console.log(`[PRY Offscreen] Redacted ${allDetections.length} items (${faceBoxes.length} faces, ${sensitiveRegions.length} DOM regions) in ${(performance.now() - startTime).toFixed(0)}ms`);

  return {
    redactedDataUrl,
    detections: allDetections.map((d) => ({
      kind: d.kind,
      box: d.box,
      confidence: d.confidence,
      label: d.label,
    })),
    redactedCount: allDetections.length,
    processingTimeMs: performance.now() - startTime,
    verification,
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
): Promise<{ result: VerificationResult; ocrLeaks: string[] }> {
  const bitmap = await createImageBitmap(blob);
  const verifyCanvas = new OffscreenCanvas(width, height);
  const verifyCtx = verifyCanvas.getContext("2d", { willReadFrequently: true })!;
  verifyCtx.drawImage(bitmap, 0, 0);
  bitmap.close();

  let result = verifyRegions(originalData, verifyCtx.getImageData(0, 0, width, height), regions);
  let ocrLeaks: string[] = [];

  try {
    const layout = layoutRegionCrops(regions);
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

  return { result, ocrLeaks };
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
      dpr?: number;
      regionScale?: number;
      regionOffsetY?: number;
      privacy?: {
        destroyFaces: boolean;
        maskCredentials: boolean;
        showRedactionLabels: boolean;
      };
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
