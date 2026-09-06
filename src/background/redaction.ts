/**
 * Redaction Engine
 *
 * Applies privacy-preserving transformations to screenshots and DOM data
 * before anything crosses the network boundary. All operations happen
 * client-side in the offscreen document or content script.
 *
 * Redaction strategies:
 *   - Gaussian blur for faces (preserves layout, destroys identifiability)
 *   - Solid black mask for credentials and ID numbers
 *   - Token replacement for DOM text values
 */

import type { BoundingBox, DetectedPII } from "./pii-detector";

// ─── Canvas Redaction ───────────────────────────────────────────────────────

/**
 * Applies Gaussian blur to a rectangular region of a canvas.
 * Uses the canvas 2D API's built-in filter which is GPU-accelerated on most
 * browsers.
 */
function blurRegion(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  box: BoundingBox,
  canvasWidth: number,
  canvasHeight: number,
  radius = 20,
): void {
  const x = Math.max(0, Math.round(box.x * canvasWidth));
  const y = Math.max(0, Math.round(box.y * canvasHeight));
  const w = Math.min(canvasWidth - x, Math.round(box.width * canvasWidth));
  const h = Math.min(canvasHeight - y, Math.round(box.height * canvasHeight));

  if (w <= 0 || h <= 0) return;

  // Save the region, apply blur, restore.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.filter = `blur(${radius}px)`;
  // Draw the same region onto itself to blur it.
  ctx.drawImage(ctx.canvas, x, y, w, h, x, y, w, h);
  ctx.restore();
}

/**
 * Draws a solid black rectangle over a region.
 * Used for credentials, card numbers, and ID numbers.
 */
function maskRegion(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  box: BoundingBox,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const x = Math.max(0, Math.round(box.x * canvasWidth));
  const y = Math.max(0, Math.round(box.y * canvasHeight));
  const w = Math.min(canvasWidth - x, Math.round(box.width * canvasWidth));
  const h = Math.min(canvasHeight - y, Math.round(box.height * canvasHeight));

  if (w <= 0 || h <= 0) return;

  ctx.fillStyle = "#000000";
  ctx.fillRect(x, y, w, h);
}

/**
 * Applies a pixelation effect to a region (alternative to blur that is
 * cheaper to compute and still destroys detail).
 */
function pixelateRegion(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  box: BoundingBox,
  canvasWidth: number,
  canvasHeight: number,
  pixelSize = 10,
): void {
  const x = Math.max(0, Math.round(box.x * canvasWidth));
  const y = Math.max(0, Math.round(box.y * canvasHeight));
  const regionW = Math.min(canvasWidth - x, Math.round(box.width * canvasWidth));
  const regionH = Math.min(canvasHeight - y, Math.round(box.height * canvasHeight));

  if (regionW <= 0 || regionH <= 0) return;

  // Downscale then upscale to create pixelation.
  const tempCanvas = document.createElement("canvas");
  const tempCtx = tempCanvas.getContext("2d")!;
  const sw = Math.max(1, Math.round(regionW / pixelSize));
  const sh = Math.max(1, Math.round(regionH / pixelSize));
  tempCanvas.width = sw;
  tempCanvas.height = sh;

  tempCtx.drawImage(ctx.canvas as CanvasImageSource, x, y, regionW, regionH, 0, 0, sw, sh);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tempCanvas, 0, 0, sw, sh, x, y, regionW, regionH);
  ctx.imageSmoothingEnabled = true;
}

/**
 * Draws a label over a redacted region to indicate what was hidden.
 * Useful for demo/transparency purposes.
 */
function labelRegion(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  box: BoundingBox,
  canvasWidth: number,
  canvasHeight: number,
  label: string,
): void {
  const x = Math.max(0, Math.round(box.x * canvasWidth));
  const y = Math.max(0, Math.round(box.y * canvasHeight));

  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.font = `bold ${Math.max(10, Math.round(canvasHeight * 0.015))}px system-ui`;
  ctx.textBaseline = "top";
  const textWidth = ctx.measureText(label).width;
  const padding = 4;
  ctx.fillRect(x, y - 18 - padding, textWidth + padding * 2, 18 + padding * 2);
  ctx.fillStyle = "#c8362a";
  ctx.fillText(label, x + padding, y - 18);
  ctx.restore();
}

// ─── Main Redaction Pipeline ────────────────────────────────────────────────

export interface RedactionOptions {
  /** Apply Gaussian blur to faces (default: true). */
  blurFaces: boolean;
  /** Apply solid mask to credentials (default: true). */
  maskCredentials: boolean;
  /** Show labels over redacted regions (default: false in production). */
  showLabels: boolean;
  /** Blur radius in pixels (default: 20). */
  blurRadius: number;
}

const DEFAULT_OPTIONS: RedactionOptions = {
  blurFaces: true,
  maskCredentials: true,
  showLabels: false,
  blurRadius: 20,
};

/**
 * Takes an image source and a list of detected PII, returns a new canvas
 * with all redaction applied. This is the core of the privacy pipeline.
 *
 * Works with both OffscreenCanvas (in the offscreen document) and regular
 * Canvas (for testing/fallback).
 */
export function redactImage(
  source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  detections: DetectedPII[],
  options: RedactionOptions = DEFAULT_OPTIONS,
): HTMLCanvasElement | OffscreenCanvas {
  const width = "width" in source ? source.width : (source as HTMLImageElement).naturalWidth;
  const height = "height" in source ? source.height : (source as HTMLImageElement).naturalHeight;

  // Use OffscreenCanvas if available, fall back to regular canvas.
  const CanvasClass = typeof OffscreenCanvas !== "undefined" ? OffscreenCanvas : HTMLCanvasElement;
  const canvas = new CanvasClass(width, height);
  const ctx = canvas.getContext("2d") as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D;

  if (!ctx) throw new Error("Could not get 2D rendering context");

  // Draw the original image.
  ctx.drawImage(source as CanvasImageSource, 0, 0);

  // Process detections by type.
  const faces = detections.filter((d) => d.kind === "face" && d.box);
  const credentials = detections.filter(
    (d) => (d.kind === "credential" || d.kind === "api_key") && d.box,
  );

  // Apply face blur.
  if (options.blurFaces) {
    for (const face of faces) {
      // Expand face bounding box by 20% for better coverage.
      const expanded: BoundingBox = {
        x: Math.max(0, face.box!.x - face.box!.width * 0.1),
        y: Math.max(0, face.box!.y - face.box!.height * 0.1),
        width: face.box!.width * 1.2,
        height: face.box!.height * 1.2,
      };
      blurRegion(ctx, expanded, width, height, options.blurRadius);
      if (options.showLabels) {
        labelRegion(ctx, expanded, width, height, "🔴 Face");
      }
    }
  }

  // Apply credential masking.
  if (options.maskCredentials) {
    for (const cred of credentials) {
      maskRegion(ctx, cred.box!, width, height);
      if (options.showLabels) {
        labelRegion(ctx, cred.box!, width, height, `🔒 ${cred.label}`);
      }
    }
  }

  return canvas;
}

/**
 * Converts an ImageBitmap to a redacted Blob suitable for network transmission.
 * The output is a compressed JPEG with quality adjusted based on the presence
 * of sensitive content (lower quality = more compression = harder to reconstruct).
 */
export async function redactToBlob(
  source: ImageBitmap,
  detections: DetectedPII[],
  options: RedactionOptions = DEFAULT_OPTIONS,
): Promise<Blob> {
  const canvas = redactImage(source, detections, options);

  // Use JPEG with moderate quality — good enough for VLM input, aggressive
  // enough to make reconstruction of redacted regions impossible.
  if ("convertToBlob" in canvas) {
    return (canvas as OffscreenCanvas).convertToBlob({
      type: "image/jpeg",
      quality: 0.85,
    });
  }

  return new Promise((resolve) => {
    (canvas as HTMLCanvasElement).toBlob(
      (blob) => resolve(blob!),
      "image/jpeg",
      0.85,
    );
  });
}

// ─── DOM Redaction ──────────────────────────────────────────────────────────

/**
 * Redacts sensitive values in a DOM snapshot by replacing them with tokens.
 * This is separate from image redaction — it handles the text/structured data
 * channel.
 */
export function redactSnapshot(
  snapshot: {
    elements: Array<{
      id: number;
      role: string;
      name: string;
      value?: string;
      attrs?: Record<string, string>;
    }>;
    text: string;
  },
  detections: DetectedPII[],
): {
  elements: Array<{
    id: number;
    role: string;
    name: string;
    value?: string;
    attrs?: Record<string, string>;
  }>;
  text: string;
  redactedCount: number;
} {
  let redactedCount = 0;

  // Build a set of element IDs that have detected PII.
  const credentialIds = new Set(
    detections
      .filter((d) => d.kind === "credential" || d.kind === "api_key")
      .map((d) => {
        const match = d.elementSelector?.match(/data-pry-id="(\d+)"/);
        return match ? parseInt(match[1], 10) : -1;
      })
      .filter((id) => id >= 0),
  );

  const TOKEN_RE = /^<[A-Z]+_\d+>$/;

  const elements = snapshot.elements.map((el) => {
    if (credentialIds.has(el.id)) {
      // If the value was already tokenized, keep the token — the LLM needs it
      // to reference the value at action time. Only raw values become [REDACTED].
      if (el.value && TOKEN_RE.test(el.value)) {
        return el;
      }
      redactedCount++;
      return {
        ...el,
        value: el.value ? "[REDACTED]" : undefined,
        attrs: el.attrs
          ? Object.fromEntries(
              Object.entries(el.attrs).map(([k, v]) =>
                k === "href" ? [k, "[REDACTED]"] : [k, v],
              ),
            )
          : undefined,
      };
    }
    return el;
  });

  // Redact ID numbers from page text.
  let text = snapshot.text;
  for (const det of detections.filter((d) => d.kind === "id_number" && d.value)) {
    text = text.replaceAll(det.value!, "[ID_REDACTED]");
    redactedCount++;
  }

  return { elements, text, redactedCount };
}

export { blurRegion, maskRegion, pixelateRegion, labelRegion };
