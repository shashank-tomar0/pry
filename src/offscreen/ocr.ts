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
import type { Page, Worker } from "tesseract.js";
import { correctOcrText } from "./ocr-correct";
import type { OcrLine, OcrWord } from "../shared/ocr-pii-triage";

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
 * Run one recognition and hand back the raw page, or null on failure/timeout.
 *
 * Single choke point for the worker so the text and word-box callers share
 * exactly one warm-up, one timeout policy and one recovery path.
 */
/** Resolve `promise`, or null once `timeoutMs` has passed. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function recognize(dataUrl: string, timeoutMs: number): Promise<Page | null> {
  let worker: Worker;
  try {
    // The worker's own COLD START is inside this call's budget now. It used to be
    // unbounded — only `worker.recognize(...)` was raced — so the first capture of
    // a run could sit ~10.5 s in createWorker before its timeout had even started,
    // which is how a frame blew the 15 s audit wait with neither an OCR result nor
    // an OCR failure to show for it. A timed-out acquisition returns null for THIS
    // call and deliberately leaves the in-flight promise in place: the warm-up is
    // still useful, and the next capture starts from a worker that is already up.
    const acquired = await withTimeout(getWorker(), timeoutMs);
    if (!acquired) return null;
    worker = acquired;
  } catch {
    return null;
  }

  try {
    const result = await Promise.race([
      // `blocks: true` is what carries per-word bounding boxes; `text` keeps the
      // existing text callers unchanged.
      worker.recognize(dataUrl, {}, { text: true, blocks: true }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("OCR timeout")), timeoutMs),
      ),
    ]);
    return (result?.data as Page) ?? null;
  } catch {
    // A timed-out recognize leaves the single worker busy forever — every
    // later screenshot would queue behind the wedged job and time out in
    // turn. Terminate and rebuild so the next call starts clean.
    try {
      await worker.terminate();
    } catch {
      // Already dead — nothing to terminate.
    }
    workerPromise = null;
    return null;
  }
}

/**
 * Start the Tesseract worker early, without waiting for it.
 *
 * WHY: the worker is built lazily on the first recognition, and that first
 * recognition is expensive — measured at ~10.5 s here (WASM core + eng trained
 * data + engine init), before any page work. It used to be paid inside the
 * first capture of every run, on the user's critical path, right after their
 * first action. Warming it while the opening perception and the first planner
 * turn are in flight moves that cost into time the run is already spending.
 *
 * Best-effort by design: a failure here must not surface as a run error, since
 * `recognize` resets and retries the worker itself.
 */
export function warmOcrWorker(): void {
  void getWorker().catch(() => undefined);
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
  const page = await recognize(dataUrl, timeoutMs);
  if (!page) return null;
  const text = page.text ?? "";
  const { correctedText } = correctOcrText(text);
  return correctedText.trim().length > 0 ? correctedText : null;
}

/**
 * OCR a frame and return its text as LINES OF BOXED WORDS.
 *
 * This is what makes PII triage possible: text alone can say "there is an email
 * in this frame", but only boxes say WHERE, and the boxes are what gets painted
 * over. Grouping follows the engine's own line structure rather than a
 * y-proximity guess, so a wrapped paragraph is not merged into one line whose
 * union box would cover the whole paragraph.
 *
 * Best-effort by design: null on any failure or timeout, never throws.
 */
export async function ocrWordLines(
  dataUrl: string,
  timeoutMs: number = 12_000,
): Promise<OcrLine[] | null> {
  const page = await recognize(dataUrl, timeoutMs);
  if (!page) return null;
  const lines: OcrLine[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block?.paragraphs ?? []) {
      for (const line of paragraph?.lines ?? []) {
        const words: OcrWord[] = [];
        for (const word of line?.words ?? []) {
          const value = (word?.text ?? "").trim();
          const bbox = word?.bbox;
          if (!value || !bbox) continue;
          const width = bbox.x1 - bbox.x0;
          const height = bbox.y1 - bbox.y0;
          if (width <= 0 || height <= 0) continue;
          words.push({
            text: value,
            x: bbox.x0,
            y: bbox.y0,
            width,
            height,
            confidence: word.confidence,
          });
        }
        if (words.length > 0) lines.push({ words });
      }
    }
  }
  // Empty successful recognition is distinct from unavailable OCR. Text with
  // no locatable words cannot be used as evidence of a completed boxed scan.
  return lines.length > 0 ? lines : (page.text?.trim() ? null : []);
}