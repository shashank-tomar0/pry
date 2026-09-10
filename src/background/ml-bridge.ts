/**
 * Service-worker side of the ML runtime.
 *
 * The models run in the offscreen document (DOM APIs + a real event loop for
 * wasm inference); this bridge is the SW's only contact with them. Every call
 * is timeout-bounded and degrades to the non-ML answer on ANY failure — the
 * detector must never stall because a model is cold, missing, or slow.
 */

import type { NerSpanInput } from "./detector-v2";

const ML_TIMEOUT_MS = 8000;

async function callOffscreen<T>(
  message: { type: string; text: string },
  fallback: T,
  signal?: AbortSignal,
): Promise<T> {
  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage(message) as Promise<T | undefined>,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ML_TIMEOUT_MS)),
      new Promise<undefined>((resolve) => {
        signal?.addEventListener("abort", () => resolve(undefined), { once: true });
      }),
    ]);
    return response ?? fallback;
  } catch {
    // Offscreen document not running / listener gone — degrade.
    return fallback;
  }
}

export interface MlFlags {
  ner: boolean;
  guard: boolean;
}

/** NER spans for page text; [] when disabled, missing, or slow. */
export async function requestMlNer(
  text: string,
  flags: MlFlags,
  signal?: AbortSignal,
): Promise<NerSpanInput[]> {
  if (!flags.ner || !text || text.length < 8) return [];
  const res = await callOffscreen<{ ok?: boolean; spans?: NerSpanInput[] }>(
    { type: "ml-ner", text },
    { spans: [] },
    signal,
  );
  return res.spans ?? [];
}

export interface MlVerdict {
  injection: boolean;
  score: number;
  label: string;
}

/** Injection verdict for page text; null when disabled, missing, or slow. */
export async function requestMlGuard(
  text: string,
  flags: MlFlags,
  signal?: AbortSignal,
): Promise<MlVerdict | null> {
  if (!flags.guard || !text || text.length < 12) return null;
  const res = await callOffscreen<{ ok?: boolean; verdict?: MlVerdict | null }>(
    { type: "ml-guard", text },
    { verdict: null },
    signal,
  );
  return res.verdict ?? null;
}
