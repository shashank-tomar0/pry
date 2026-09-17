/**
 * Service-worker side of the ML runtime.
 *
 * The models run in the offscreen document (DOM APIs + a real event loop for
 * wasm inference); this bridge is the SW's only contact with them. Every call
 * is timeout-bounded and degrades to the non-ML answer on ANY failure — the
 * detector must never stall because a model is cold, missing, or slow.
 */

import type { NerSpanInput } from "./detector-v2";
import { ensureOffscreenDocument } from "./offscreen-doc";
import { sanitizePiiTargets, type PiiTarget } from "../shared/redaction-reconciliation";

export type { PiiTarget };

/**
 * Budget for one offscreen ML round trip (timer starts once the document
 * exists, so a cold document start is not counted).
 *
 * 8 s was optimistic: the FIRST inference after a cold load has to page the
 * quantized token-classification weights into wasm memory, which can exceed
 * it. A timeout here degrades silently to the non-ML answer — the exact
 * failure mode that made the wire log report names as LEAKs while the
 * self-test claimed the model was loaded.
 */
const ML_TIMEOUT_MS = 15_000;

/**
 * ML_TIMEOUT_MS starts counting only once the document exists, so a cold
 * start cannot be mistaken for a model timeout.
 */
async function callOffscreen<T>(
  message: { type: string; text: string },
  fallback: T,
  signal?: AbortSignal,
): Promise<T> {
  await ensureOffscreenDocument().catch(() => undefined);
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

// ─── NER span state (the NER→pixel bridge) ──────────────────────────────────
// runTask stores the spans the model found on the current snapshot; the
// screenshot path reads them to black-box those exact names in the pixels.
// Without this, a NER detection is tokenized in the text channel but the
// name stays readable on screen — the two-channel bug, model edition.

let activeNerSpans: string[] = [];

// Hygiene for the cross-message channel: dedupe, trim, drop sub-3-char noise,
// and cap at 12 so the locate-spans message stays small even if the model
// returns a huge span list. Mirrors the guards locateSpans applies again on
// the content side — defense in depth.
export function setActiveNerSpans(spans: string[]): void {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const s of spans ?? []) {
    const t = (s ?? "").trim();
    if (t.length < 3 || seen.has(t) || clean.length >= 12) continue;
    seen.add(t);
    clean.push(t);
  }
  activeNerSpans = clean;
}

export function getActiveNerSpans(): string[] {
  // Copy: callers (the capture path) must never be able to mutate the state
  // that the next turn's screenshot depends on.
  return [...activeNerSpans];
}

// ─── Detector → pixel bridge ────────────────────────────────────────────────
// The same disconnect the NER bridge closed, for the detectors' own findings.
// The text channels read MORE than rendered text nodes: accessible names,
// element values and attributes. An email sitting in an account chip's
// aria-label was therefore detected, tokenized for the model — and left fully
// readable in the screenshot, because the pixel channel only knew how to box
// text nodes and form fields. On a real Gmail inbox that showed up as
// "2 PII detected / 0 items redacted / nothing to verify" while the raw address
// was plainly visible in the BEFORE/AFTER proof image.
//
// Values are located as literal text; selectors resolve to the element's box.
// Either channel may be empty.

// `PiiTarget` and the target hygiene live in shared/redaction-reconciliation
// so the policy is unit-testable without chrome or a DOM.
let activePiiTargets: PiiTarget[] = [];

/**
 * Remember what the text channels just found, so the next capture can box it.
 * Values are length-bounded and selectors must match the `[data-pry-id="N"]`
 * shape our own detectors emit — nothing else is forwarded to a page.
 */
export function setActivePiiTargets(targets: PiiTarget[] = []): void {
  activePiiTargets = sanitizePiiTargets(targets);
}

export function getActivePiiTargets(): PiiTarget[] {
  return activePiiTargets.map((t) => ({ ...t }));
}

export interface MlSelfTest {
  ner: { ready: boolean; reason?: string; sample?: string[]; kept?: number };
  guard: { ready: boolean; reason?: string; label?: string };
  face: { ready: boolean };
}

/**
 * Load every on-device model and run one real inference on each.
 *
 * Returns null when the offscreen document could not answer in time (the
 * caller then falls back to the file-presence probe). This is the difference
 * between "a model file exists" and "the model works" — only the latter is
 * worth telling the user.
 */
export async function selfTestMl(): Promise<MlSelfTest | null> {
  await ensureOffscreenDocument().catch(() => undefined);
  try {
    const response = (await Promise.race([
      chrome.runtime.sendMessage({ type: "ml-self-test" }) as Promise<
        { ok?: boolean; result?: MlSelfTest } | undefined
      >,
      // The self-test pays the one-time cost of every model's first load
      // (wasm init + a cold disk read of the NER checkpoint, possibly under
      // antivirus scanning). 30s lost that race on real installs and downgraded
      // the status line to "present on disk (unverified)" even though the
      // model works — the weaker claim, shown as if it were the honest one.
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 60_000)),
    ])) as { ok?: boolean; result?: MlSelfTest } | undefined;
    return response?.result ?? null;
  } catch {
    return null;
  }
}

/** Probe which model files actually shipped (cheap HEAD on package URLs). */
export async function probeMlFiles(): Promise<{ ner: boolean; guard: boolean; face: boolean }> {
  const probe = async (path: string): Promise<boolean> => {
    try {
      const res = await fetch(chrome.runtime.getURL(path), { method: "HEAD" });
      return res.ok;
    } catch {
      return false;
    }
  };
  const [ner, guard, face] = await Promise.all([
    probe("models/ner/onnx/model_quantized.onnx"),
    probe("models/guard/onnx/model_quantized.onnx"),
    probe("models/blazeface/face_detection_short_range.tflite"),
  ]);
  return { ner, guard, face };
}
