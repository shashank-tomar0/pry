/**
 * Fetch ML models into models/ so the extension ships with an on-device brain.
 *
 * Everything is best-effort and honest: a model that cannot be downloaded is
 * reported and the corresponding feature degrades at runtime (regex/checksum
 * detection, skin-color faces, regex injection guard). Nothing here is
 * required for the extension to work.
 *
 *   node scripts/fetch-models.mjs
 *
 * Sources:
 *   - BlazeFace short-range: Google MediaPipe storage (stable public URL).
 *   - NER (token-classification) and injection guard (text-classification):
 *     Hugging Face ONNX builds. Repos are probed first; a 404 is not an
 *     error, it is "this model is not available anonymously" — reported and
 *     skipped. Files are mirrored in the exact layout transformers.js
 *     expects for local loading: models/<slug>/{config,tokenizer}.json +
 *     onnx/model_quantized.onnx.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const ROOT = "models";
// Some networks 401 anonymous Hugging Face traffic; a free HF token in
// HF_TOKEN (or .env-style env) fixes the resolve calls.
const HF_TOKEN = process.env.HF_TOKEN ?? "";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

async function download(url, dest, headers = {}) {
  const res = await fetch(url, { headers: { "user-agent": UA, ...headers }, redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
  await writeFile(dest, buf);
  return buf.length;
}

/**
 * Download one Hugging Face model into models/<slug>/.
 *
 * `files` maps a path INSIDE the repo to a path inside models/<slug>/. Repos
 * disagree on layout: some ship onnx/model.onnx, others put model.onnx at the
 * root with no onnx/ directory. transformers.js only ever looks in onnx/, so
 * the mapping normalizes the layout instead of hoping the repo matches.
 */
const DEFAULT_FILES = [
  ["config.json", "config.json"],
  ["tokenizer.json", "tokenizer.json"],
  ["tokenizer_config.json", "tokenizer_config.json"],
  ["special_tokens_map.json", "special_tokens_map.json"],
  ["onnx/model_quantized.onnx", "onnx/model_quantized.onnx"],
];

async function fetchHfModel(repo, slug, files = DEFAULT_FILES) {
  const auth = HF_TOKEN ? { authorization: `Bearer ${HF_TOKEN}` } : {};
  const probe = await fetch(`https://huggingface.co/api/models/${repo}`, { headers: auth, redirect: "follow" });
  if (!probe.ok) {
    console.log(`SKIP ${slug}: ${repo} not reachable (${probe.status}${HF_TOKEN ? "" : "; try HF_TOKEN=<your hf token>"}). Feature degrades gracefully.`);
    return false;
  }
  const base = `https://huggingface.co/${repo}/resolve/main/`;
  for (const [from, to] of files) {
    const dest = `${ROOT}/${slug}/${to}`;
    if (existsSync(dest)) {
      console.log(`  = ${dest} (cached)`);
      continue;
    }
    try {
      const bytes = await download(base + from, dest, auth);
      console.log(`  + ${dest} (${Math.round(bytes / 1024)} KB)`);
    } catch (err) {
      console.log(`  ! ${from} unavailable (${err.message})`);
    }
  }
  console.log(`OK  ${slug} ready`);
  return true;
}

console.log("== BlazeFace (face detection, ~1 MB) ==");
try {
  const bytes = await download(
    "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
    `${ROOT}/blazeface/face_detection_short_range.tflite`,
  );
  console.log(`OK  blazeface ready (${Math.round(bytes / 1024)} KB)`);
} catch (err) {
  console.log(`SKIP blazeface: ${err.message}. Skin-color fallback remains active.`);
}

console.log("== NER (token-classification) ==");
// Preferred: ONNX build of a PII-capable token classifier that transformers.js
// runs natively. Candidates in priority order; first available wins.
//
// Why not GLiNER (gliner-pii / gliner_base)? Two hard blockers as of today:
//   1. transformers.js (v4.2, latest) has NO GLiNER architecture — the span-
//      pair scoring head is not a standard token-classification head, so the
//      token-classification pipeline cannot run it. The only JS GLiNER
//      runtime (npm @lmoe/gliner-onnx) depends on onnxruntime-NODE and cannot
//      run in the extension's offscreen document.
//   2. GLiNER-PII's quantized ONNX is 197 MB — 4x the entire current package.
// GLiNER remains the Tier-1 NER upgrade path; the loader below is label-
// agnostic, so swapping in a GLiNER-backed runtime later needs zero changes
// to the fusion/detection layer.
const NER_CANDIDATES = [
  "onnx-community/distilbert-NER",
  "Xenova/distilbert-base-uncased-finetuned-conll03-english",
];
// The bundled checkpoint is a quantized token classifier whose output is
// repaired by src/shared/ner-spans.ts (BIO prefixes stripped, WordPiece
// fragments merged). Pin the repair with `npm run verify`; score a replacement
// against the real weights with `node scripts/eval-ner.mjs`.
let nerDone = false;
for (const repo of NER_CANDIDATES) {
  try {
    nerDone = await fetchHfModel(repo, "ner");
    if (nerDone) break;
  } catch (err) {
    console.log(`  ${repo}: ${err.message}`);
  }
}
if (!nerDone) console.log("SKIP ner: no candidate available. Detection falls back to regex + checksums.");

console.log("== Injection guard (text-classification) ==");
// NO DEFAULT CANDIDATE, ON PURPOSE.
//
// Every small ONNX prompt-injection checkpoint reachable from this project was
// downloaded and scored against a labeled benign/attack set
// (scripts/eval-guard.mjs) and every one failed the shipping bar:
//
//   testsavantai/prompt-injection-defender-tiny-v0-onnx  17 MB  recall 40%
//       + flags "Please ignore the previous section of this document" as an
//         attack
//   testsavantai/prompt-injection-defender-small-v0-onnx 110 MB  recall 87%
//       + flags a Terms-of-Service page and a profile page as attacks (20% FP)
//   protectai/deberta-v3-base-prompt-injection-v2        none ONNX-compatible
//   sinatras/Llama-Prompt-Guard-2-86M-ONNX                303 MB  too large to
//         bundle (int8 of a much bigger graph than the name suggests)
//   protectai/deberta-v3-base-injection-onnx            738 MB  recall 100%
//       + flags 14/15 BENIGN pages as INJECTION at 0.94-1.00 confidence —
//         sign-in forms, download instructions, ToS, order-tracking text.
//         Structural, not fixable by a threshold: prompt-injection classifiers
//         are trained on LLM input streams where ANY instruction-like text is
//         hostile, but a web page is MADE of instructions. Whole-page
//         classification is the wrong shape for this job; a usable semantic
//         guard needs a model fine-tuned ON page content (benign DOM text vs
//         injected DOM text) — no public checkpoint does that today.
//
// A guard that flags ordinary pages manufactures false alarms on a feature
// whose whole value is that its warnings can be trusted. Shipping nothing and
// saying so is the honest choice until a checkpoint clears the bar.
//
// To evaluate a replacement before adopting it:
//   1. node scripts/fetch-models.mjs --guard=<hf-repo>
//   2. node scripts/eval-guard.mjs
// Only wire it in as the default once that passes.
const guardArg = process.argv.find((a) => a.startsWith("--guard="));
if (guardArg) {
  const repo = guardArg.slice("--guard=".length);
  console.log(`Evaluating candidate guard: ${repo}`);
  // Root-level layout: model.onnx with no onnx/ directory.
  const ok = await fetchHfModel(repo, "guard", [
    ["config.json", "config.json"],
    ["tokenizer.json", "tokenizer.json"],
    ["tokenizer_config.json", "tokenizer_config.json"],
    ["special_tokens_map.json", "special_tokens_map.json"],
    ["vocab.txt", "vocab.txt"],
    ["model.onnx", "onnx/model.onnx"],
  ]).catch((err) => {
    console.log(`SKIP ${repo}: ${err.message}`);
    return false;
  });
  if (ok) console.log("Now score it: node scripts/eval-guard.mjs");
} else {
  console.log("SKIP guard: no checkpoint meets the accuracy bar — the regex heuristic is the guard.");
  console.log("     Score a candidate with: node scripts/fetch-models.mjs --guard=<hf-repo> && node scripts/eval-guard.mjs");
}

console.log("\nDone. Missing models are fine — every ML feature degrades to the\nnon-ML path at runtime when its files are absent.");
