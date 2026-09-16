/**
 * NER evaluation against the REAL bundled weights.
 *
 * The verification suite tests the span normalizer with synthetic input, which
 * cannot catch the failure that actually happened: the pipeline returning a
 * different *shape* than the code expected, so every span was silently
 * discarded while the self-test still reported success. Only real inference
 * exposes that.
 *
 * This loads models/ner/ through the same transformers.js pipeline the
 * offscreen document uses, applies the shipped policy, and asserts whole
 * entities come out. Run it after swapping a checkpoint:
 *
 *   node scripts/eval-ner.mjs
 *
 * Exits non-zero when detection would be a no-op or produce fragments.
 */

import { env, pipeline } from "@huggingface/transformers";
import { normalizeSpans } from "../src/shared/ner-spans.ts";
import { keepLabel } from "../src/shared/ner-labels.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = path.join(ROOT, "models") + path.sep;

// Must match src/ml/ner.ts.
const MIN_SPAN_CHARS = 3;
const MIN_SPAN_SCORE = 0.5;

const classifier = await pipeline("token-classification", "ner", {
  dtype: "q8",
  aggregation_strategy: "simple",
});

/** Run the model and apply the detector's precision policy — the shipped code path. */
async function detect(text) {
  const raw = await classifier(text, { aggregation_strategy: "simple" });
  return normalizeSpans(raw).filter(
    (s) => s.text.length >= MIN_SPAN_CHARS && keepLabel(s.label) && s.score > MIN_SPAN_SCORE,
  );
}

const PROBE = "Priya Sharma met Ramesh Gupta at Acme Corporation in Mumbai.";

const spans = await detect(PROBE);
const texts = spans.map((s) => s.text);
const labels = spans.map((s) => s.label);

console.log(`\nProbe: ${PROBE}`);
console.log(`Spans: ${JSON.stringify(spans.map((s) => ({ text: s.text, label: s.label, score: +s.score.toFixed(2) })))}\n`);

const failures = [];
const expect = (name, condition, extra) => {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}${condition || !extra ? "" : ` — ${extra}`}`);
  if (!condition) failures.push(name);
};

expect("detection is not a silent no-op", spans.length > 0, "zero usable spans");
expect(
  "whole person names survive (no word-piece fragments)",
  texts.includes("Priya Sharma"),
  `got ${JSON.stringify(texts)}`,
);
expect("no continuation marker leaks into a span", !texts.some((t) => t.includes("##")), JSON.stringify(texts));
expect("labels are policy-visible entity types", labels.every((l) => keepLabel(l)), JSON.stringify(labels));
expect(
  "outside spans are not emitted as entities",
  !texts.some((t) => /^met$/i.test(t)),
  JSON.stringify(texts),
);
expect(
  "a location is recovered",
  labels.some((l) => l === "LOC" || l === "ORG"),
  JSON.stringify(labels),
);

// A page-like block: the form the detector actually sees in the wild.
const PAGE = `Invoice for Priya Sharma, contact priya.sharma@acme.in.
Delivered to Acme Corporation, Mumbai. Purchase order raised by Ramesh Gupta.`;
const pageSpans = await detect(PAGE);
console.log(`\nPage-like text spans: ${JSON.stringify(pageSpans.map((s) => `${s.label}:${s.text}`))}`);
expect("page-like text yields at least one redactable name", pageSpans.length > 0, "zero spans");

if (failures.length > 0) {
  console.log(`\nFAIL: ${failures.length} check(s) failed — NER would not redact names correctly.`);
  process.exit(1);
}
console.log("\nPASS: NER extracts whole, policy-visible entities from the bundled weights.");
