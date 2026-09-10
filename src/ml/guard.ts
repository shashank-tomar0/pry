/**
 * Prompt-injection guard (Tier 0).
 *
 * A text-classification model (Prompt-Guard style) runs fully local from
 * models/guard/ and scores page text for injection/jailbreak intent BEFORE
 * the planner sees it. The regex detector ("ignore previous instructions")
 * stays as the cheap first pass; this is the semantic layer that catches
 * paraphrases the regexes never will.
 *
 * Degradation contract: missing model or any failure returns null, and the
 * caller falls back to the regex detector. Failures are remembered so the
 * offscreen runtime is not hammered on every turn.
 */

import { pipeline } from "@huggingface/transformers";
import { configureMlEnv } from "./env";

export interface InjectionVerdict {
  /** True when the model's injection/jailbreak class scored above threshold. */
  injection: boolean;
  score: number;
  /** Raw model label, for the transcript warning. */
  label: string;
}

let pipelinePromise: Promise<unknown> | null = null;
let unavailable = false;

async function getPipeline(): Promise<{ (t: string, o?: unknown): Promise<unknown> } | null> {
  if (unavailable) return null;
  if (!pipelinePromise) {
    configureMlEnv();
    pipelinePromise = pipeline("text-classification", "guard", { dtype: "q8" } as never).catch(() => {
      unavailable = true;
      pipelinePromise = null;
      return null;
    });
  }
  const p = (await pipelinePromise) as { (t: string, o?: unknown): Promise<unknown> } | null;
  return p;
}

/** Above this the page text is treated as hostile with high confidence. */
const INJECTION_THRESHOLD = 0.7;

/**
 * Classify page text for injection/jailbreak intent. Returns null when the
 * guard is unavailable (caller falls back to the regex detector). Never throws.
 */
export async function classifyInjection(text: string): Promise<InjectionVerdict | null> {
  if (!text || text.length < 12) return null;
  const classifier = await getPipeline();
  if (!classifier) return null;
  try {
    const out = (await classifier(text.slice(0, 3000))) as Array<{ label?: string; score?: number }>;
    const top = (out ?? [])[0];
    if (!top) return null;
    const label = String(top.label ?? "");
    const score = Number(top.score ?? 0);
    // Label conventions differ per model ("INJECTION"/"SAFE", "toxic"/"healthy").
    // A safe-labeled top hit is never an injection regardless of score; any
    // other label above the threshold is.
    const safeLabel = /safe|benign|healthy|normal/i.test(label);
    const injection = !safeLabel && score >= INJECTION_THRESHOLD;
    return { injection, score, label };
  } catch {
    unavailable = true;
    return null;
  }
}
