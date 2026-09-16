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
import { keepLabel } from "../shared/ner-labels";
import { normalizeSpans, type NerRawSpan, type NerSpan } from "../shared/ner-spans";

export type { NerSpan };

let pipelinePromise: Promise<unknown> | null = null;
/** Hard memory of a failed load — no retry storms on every snapshot. */
let unavailable = false;
/** Why the load failed, for the honest self-test line. Empty when it worked. */
let loadError = "";

async function getPipeline(): Promise<{ (t: string, o?: unknown): Promise<unknown> } | null> {
  if (unavailable) return null;
  if (!pipelinePromise) {
    configureMlEnv();
    pipelinePromise = pipeline("token-classification", "ner", { dtype: "q8" } as never).catch((err: unknown) => {
      unavailable = true;
      loadError = err instanceof Error ? err.message : String(err);
      pipelinePromise = null;
      return null;
    });
  }
  const p = (await pipelinePromise) as { (t: string, o?: unknown): Promise<unknown> } | null;
  return p;
}

/** Sentence used by the self-test: unambiguous PER/ORG/LOC entities. */
const SELF_TEST_PROBE = "Priya Sharma met Ramesh Gupta at Acme Corporation in Mumbai.";

/** A span must clear all three bars to be worth redacting. */
const MIN_SPAN_CHARS = 3;
const MIN_SPAN_SCORE = 0.5;

/**
 * The detector's precision policy, applied in one place.
 *
 * warmUpNer reports through this same filter on purpose. When the self-test
 * listed raw model output instead, it advertised entities that the policy then
 * discarded — the transcript said "NER model loaded, found 4 entities" while
 * detection quietly returned nothing. A self-test that cannot disagree with
 * the pipeline it is testing is not a self-test.
 */
function usableSpans(raw: NerRawSpan[] | null | undefined): NerSpan[] {
  return normalizeSpans(raw).filter(
    (s) => s.text.length >= MIN_SPAN_CHARS && keepLabel(s.label) && s.score > MIN_SPAN_SCORE,
  );
}

/**
 * Force the model to load and run one real inference.
 *
 * File-presence probes are not evidence: a model can be present and still
 * fail to load (version-mismatched wasm, bad config), and that failure is
 * swallowed by the degradation contract. This is how the extension can state
 * whether the on-device brain actually works instead of implying it.
 */
export async function warmUpNer(): Promise<{
  ready: boolean;
  reason?: string;
  /** Spans that survived the detector's own policy — what it would redact. */
  sample?: string[];
  /** How many such spans the probe sentence produced. */
  kept?: number;
}> {
  const extractor = await getPipeline();
  if (!extractor) return { ready: false, reason: loadError || "model not available" };
  try {
    const out = (await extractor(SELF_TEST_PROBE, { aggregation_strategy: "simple" })) as NerRawSpan[];
    const kept = usableSpans(out);
    return {
      ready: true,
      kept: kept.length,
      sample: kept.map((s) => s.text).slice(0, 4),
    };
  } catch (err) {
    unavailable = true;
    return { ready: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

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
    })) as NerRawSpan[];
    return usableSpans(out);
  } catch {
    unavailable = true;
    return [];
  }
}
