/**
 * NER detection (Tier 0, Detection v2).
 *
 * A token-classification model (ConLL-style PER/ORG/LOC) runs fully local
 * from models/ner/. Its spans give the detector RECALL — names, organizations
 * and locations in any casing or language family the model covers — while the
 * regex + checksum layer stays the PRECISION validator for structured IDs.
 *
 * Degradation contract: if the model is missing, fails to load, or throws,
 * detectSpans returns [] and remembers the failure so later calls do not
 * retry on every snapshot. The detector falls back to regex-only, which is
 * exactly the v1.0 behavior.
 */

import { pipeline } from "@huggingface/transformers";
import { configureMlEnv } from "./env";

export interface NerSpan {
  text: string;
  /** Model label: PER, ORG, LOC (normalized). */
  label: string;
  score: number;
}

let pipelinePromise: Promise<unknown> | null = null;
/** Hard memory of a failed load — no retry storms on every snapshot. */
let unavailable = false;

async function getPipeline(): Promise<{ (t: string, o?: unknown): Promise<unknown> } | null> {
  if (unavailable) return null;
  if (!pipelinePromise) {
    configureMlEnv();
    pipelinePromise = pipeline("token-classification", "ner", { dtype: "q8" } as never).catch(() => {
      unavailable = true;
      pipelinePromise = null;
      return null;
    });
  }
  const p = (await pipelinePromise) as { (t: string, o?: unknown): Promise<unknown> } | null;
  return p;
}

import { keepLabel } from "../shared/ner-labels";

/**
 * Detect person/organization/location spans in free text.
 * Aggregates subword tokens into whole spans. Never throws.
 */
export async function detectSpans(text: string): Promise<NerSpan[]> {
  if (!text || text.length < 8) return [];
  const extractor = await getPipeline();
  if (!extractor) return [];
  try {
    // Cap the text so a huge page cannot turn one NER pass into a stall.
    const out = (await extractor(text.slice(0, 4000), {
      aggregation_strategy: "simple",
    })) as Array<{ entity_group?: string; word?: string; score?: number }>;
    return (out ?? [])
      .map((e) => ({
        text: String(e.word ?? "").trim(),
        label: String(e.entity_group ?? "").toUpperCase(),
        score: Number(e.score ?? 0),
      }))
      .filter((s) => s.text.length >= 3 && keepLabel(s.label) && s.score > 0.5);
  } catch {
    unavailable = true;
    return [];
  }
}
