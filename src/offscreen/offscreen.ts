/**
 * Offscreen Document
 *
 * Manifest V3 service workers cannot access DOM APIs, WebGPU, or run
 * long-lived inference. This offscreen document provides the environment for:
 *   1. DOM-guided screenshot redaction (blurring/masking PII regions)
 *   2. Face detection (Chrome FaceDetector API → skin-color fallback)
 *   3. Canvas-based redaction engine
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
import { detectSpans } from "../ml/ner";
import { classifyInjection } from "../ml/guard";
import { FilesetResolver, FaceDetector as MpFaceDetector } from "@mediapipe/tasks-vision";

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
      return MpFaceDetector.createFromOptions(files, {
        baseOptions: {
          modelAssetPath: chrome.runtime.getURL("models/blazeface/face_detection_short_range.tflite"),
          delegate: "CPU",
        },
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
        // real faces in thumbnails while dropping tiny avatar icons, and the
        // cap below stops YouTube-style grids of 14+ thumbnails from turning
        // the whole page into one giant blur (each also earns a "Face" chip).
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

  // Merge overlapping regions, then cap the count — a thumbnail grid should
  // not produce an unbounded wall of face blurs.
  return mergeOverlappingRegions(regions).slice(0, 8);
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
    blurFaces: boolean;
    maskCredentials: boolean;
    showRedactionLabels: boolean;
  },
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
  const scale = dpr;

  const maskCredentials = privacy?.maskCredentials !== false;
  const blurFaces = privacy?.blurFaces !== false;
  const showLabels = privacy?.showRedactionLabels === true;

  // 1. DOM-guided redaction — redact known sensitive regions.
  for (const region of sensitiveRegions) {
    // Scale CSS coordinates to device pixels + expand by 4px padding.
    const padding = 4 * scale;
    const rx = Math.max(0, Math.round(region.x * scale - padding));
    const ry = Math.max(0, Math.round(region.y * scale - padding));
    const rw = Math.min(width - rx, Math.round(region.width * scale + padding * 2));
    const rh = Math.min(height - ry, Math.round(region.height * scale + padding * 2));

    if (rw <= 0 || rh <= 0) continue;

    // Solid black box for PII found in plain text (email/phone/id *_text
    // spans from the pixel channel): the exact-span redaction users expect,
    // trivially verified by re-OCR, and it reads unambiguously as "this was
    // redacted". Labels and plain input fields still blur (over-covering a
    // whole field with a black box destroys layout context). Everything
    // else — credential/ID *fields* — gets the surrogate inpaint treatment.
    const solidText = region.kind.endsWith("_text");
    const useBlur =
      region.kind === "credential_label" ||
      region.kind === "input_field";

    // full-mask credential regions (password/card/Aadhaar/API-key fields) are
    // gated by the user's maskCredentials toggle. Soft input-field blur always
    // runs (a generic field the user types into is still sensitive), but when
    // masking is off we degrade to blur so the pixels are still protected.
    if (solidText && maskCredentials) {
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

      const surrogateText = getSyntheticSurrogate(region.kind || region.label);
      ctx.fillStyle = "#0f172a";
      ctx.font = `600 ${Math.max(9, Math.round(Math.min(rh * 0.45, 12 * scale)))}px system-ui, -apple-system, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const pad = 4 * scale;
      ctx.fillText(`🔒 ${surrogateText}`, rx + pad, ry + rh / 2, Math.max(10, rw - pad * 2));
    }

    allDetections.push({
      kind: (region.kind === "credential_label" || region.kind === "input_field") ? "credential" : region.kind as any,
      // Normalized 0-1 coordinates (same convention as face boxes) so the
      // audit panel can overlay proof markers on the thumbnail regardless of
      // DPR or display size: x_norm = cssPx * dpr / deviceWidth.
      box: {
        x: (region.x * scale) / width,
        y: (region.y * scale) / height,
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

  // 2. Face detection — BlazeFace (real model) first, Chrome FaceDetector
  // second, skin-color heuristic as the last-resort fallback.
  let faceBoxes: Array<{ x: number; y: number; width: number; height: number; confidence: number }> = [];

  try {
    faceBoxes = await detectFacesWithBlazeFace(canvas);
    if (faceBoxes.length > 0) {
      console.log(`[PRY Offscreen] BlazeFace found ${faceBoxes.length} faces`);
    }
  } catch {
    // Fall through to the next channel.
  }

  if (faceBoxes.length === 0) {
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
        faceBoxes = faces.map((f) => ({
          x: f.boundingBox.x,
          y: f.boundingBox.y,
          width: f.boundingBox.width,
          height: f.boundingBox.height,
          confidence: 0.95,
        }));
        if (faceBoxes.length > 0) {
          console.log(`[PRY Offscreen] Chrome FaceDetector found ${faceBoxes.length} faces`);
        }
      } catch {
        // Fall through to skin-color.
      }
    }
  }

  if (faceBoxes.length === 0) {
    // Fallback: skin-color heuristic on the ORIGINAL pixels (not the already
    // redacted canvas, which may contain black masks).
    const imageData = originalCtx.getImageData(0, 0, width, height);
    faceBoxes = detectFacesBySkinColor(imageData, width, height);
    if (faceBoxes.length > 0) {
      console.log(`[PRY Offscreen] Skin-color heuristic found ${faceBoxes.length} faces`);
    }
  }

  for (const face of faceBoxes) {
    // Expand face box by 20% for better coverage.
    const expandX = face.width * 0.1;
    const expandY = face.height * 0.1;
    const rx = Math.max(0, Math.round(face.x - expandX));
    const ry = Math.max(0, Math.round(face.y - expandY));
    const rw = Math.min(width - rx, Math.round(face.width + expandX * 2));
    const rh = Math.min(height - ry, Math.round(face.height + expandY * 2));

    if (rw > 10 && rh > 10) {
      if (blurFaces) {
        // Apply blur to face region (deterministic, verifiable).
        boxBlurRegion(ctx, rx, ry, rw, rh, 10 * scale);

        redactionRegions.push({ x: rx, y: ry, width: rw, height: rh, kind: "face", label: "Face detected" });
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
        label: "Face detected",
      });
    }
  }

  // 3. Convert to Blob.
  const redactedBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  const redactedDataUrl = await blobToDataUrl(redactedBlob);

  // 4. Re-OCR verification — decode the EXACT bytes that will be shipped (the
  // post-JPEG image) and re-scan every redacted region to prove the redaction
  // actually worked at the pixel level.
  let verification: VerificationResult = emptyVerification();
  if (redactionRegions.length > 0) {
    try {
      const redactedBitmap = await createImageBitmap(redactedBlob);
      const verifyCanvas = new OffscreenCanvas(width, height);
      const verifyCtx = verifyCanvas.getContext("2d", { willReadFrequently: true })!;
      verifyCtx.drawImage(redactedBitmap, 0, 0);
      redactedBitmap.close();
      const redactedData = verifyCtx.getImageData(0, 0, width, height);
      const originalData = originalCtx.getImageData(0, 0, width, height);
      verification = verifyRegions(originalData, redactedData, redactionRegions);

      // 5. Real OCR pass scoped to the redacted regions ONLY. The regions are
      //    composited into one strip (crop layout is pure, in reocr-verification)
      //    and OCR re-reads that strip. Scanning the whole shipped image would
      //    flag PII that is legitimately visible elsewhere on the page (an email
      //    in an inbox row), so leaks are only meaningful inside regions the
      //    pipeline claimed to redact. Any failure here keeps the pixel result
      //    — OCR must never discard or downgrade the pixel verification.
      try {
        const layout = layoutRegionCrops(redactionRegions);
        if (layout.slots.length > 0) {
          const ocrCanvas = new OffscreenCanvas(layout.width, layout.height);
          const ocrCtx = ocrCanvas.getContext("2d")!;
          ocrCtx.fillStyle = "#ffffff";
          ocrCtx.fillRect(0, 0, layout.width, layout.height);
          const regionBitmap = await createImageBitmap(redactedBlob);
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
            const ocrLeaks = detectPIIInText(ocrText);
            verification = {
              ...verification,
              ocrRan: true,
              leakedText: ocrLeaks.length > 0 ? ocrText.slice(0, 300) : undefined,
            };
            if (ocrLeaks.length > 0) {
              verification.verified = false;
              verification.leakedPatterns = [
                ...verification.leakedPatterns,
                ...ocrLeaks.map((l) => `OCR: ${l} still readable inside a redacted region`),
              ];
              verification.confidence = Math.min(verification.confidence, 0.3);
              verification.summary =
                `WARNING: OCR found ${ocrLeaks.join(", ")} still readable inside a redacted region. ` +
                `Pixel regions: ${verification.regionsRedacted}/${verification.regionsChecked} confirmed.`;
            } else {
              verification.summary =
                `${verification.summary} OCR re-read the redacted regions and found no readable PII.`;
            }
          }
        }
      } catch {
        // OCR is corroboration only — the pixel result above stands.
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
      privacy?: {
        blurFaces: boolean;
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

    return false;
  },
);

console.log("[PRY] Offscreen document initialized — DOM-guided privacy pipeline ready.");
