/**
 * OCR (Tesseract.js, fully local)
 *
 * The offscreen document re-reads the EXACT redacted JPEG it ships and OCRs it,
 * so verification can claim "no PII text remains in the pixels" based on actual
 * text recognition — not just pixel-region checks.
 *
 * Everything is loaded from bundled local assets (dist/vendor) via
 * chrome.runtime.getURL, so no CDN fetch, works offline, and satisfies MV3 CSP
 * (`'wasm-unsafe-eval'` is declared for extension pages).
 *
 * OCR is strictly best-effort: any failure or timeout returns null and the
 * privacy pipeline falls back to the pixel-region verification. It must never
 * block or break redaction.
 */

import { createWorker } from "tesseract.js";
import type { Worker } from "tesseract.js";

let workerPromise: Promise<Worker> | null = null;

function vendorUrl(path: string): string {
  return chrome.runtime.getURL(`vendor/${path}`);
}

async function getWorker(): Promise<Worker> {
  if (workerPromise) return workerPromise;

  workerPromise = createWorker("eng", 1, {
    workerPath: vendorUrl("worker.min.js"),
    corePath: vendorUrl("tesseract-core/tesseract-core-simd-lstm.wasm.js"),
    langPath: vendorUrl("lang"),
    gzip: true,
    workerBlobURL: false,
    logger: () => undefined,
  });

  // A failed worker must not wedge the pipeline forever — reset so the next
  // screenshot can retry once.
  workerPromise.catch(() => {
    workerPromise = null;
  });

  return workerPromise;
}

/**
 * OCR a data URL (redacted screenshot) and return its recognized text.
 * Returns null on any failure or timeout — the caller falls back to the
 * pixel-region verification result.
 */
export async function ocrDataUrl(
  dataUrl: string,
  timeoutMs: number = 8000,
): Promise<string | null> {
  let worker: Worker;
  try {
    worker = await getWorker();
  } catch {
    return null;
  }

  try {
    const result = await Promise.race([
      worker.recognize(dataUrl),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("OCR timeout")), timeoutMs),
      ),
    ]);
    const text = result?.data?.text ?? "";
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}