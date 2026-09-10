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

async function fetchHfModel(repo, slug, onnxFile = "model_quantized.onnx") {
  const auth = HF_TOKEN ? { authorization: `Bearer ${HF_TOKEN}` } : {};
  const probe = await fetch(`https://huggingface.co/api/models/${repo}`, { headers: auth, redirect: "follow" });
  if (!probe.ok) {
    console.log(`SKIP ${slug}: ${repo} not reachable (${probe.status}${HF_TOKEN ? "" : "; try HF_TOKEN=<your hf token>"}). Feature degrades gracefully.`);
    return false;
  }
  const base = `https://huggingface.co/${repo}/resolve/main/`;
  const files = ["config.json", "tokenizer.json", "tokenizer_config.json", `onnx/${onnxFile}`];
  for (const file of files) {
    const dest = `${ROOT}/${slug}/${file}`;
    if (existsSync(dest)) {
      console.log(`  = ${dest} (cached)`);
      continue;
    }
    const bytes = await download(base + file, dest, auth);
    console.log(`  + ${dest} (${Math.round(bytes / 1024)} KB)`);
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
// Preferred: ONNX build of a ConLL-style NER (PER/ORG/LOC) that transformers.js
// runs natively. Candidates in priority order; first available wins.
const NER_CANDIDATES = [
  "onnx-community/distilbert-NER",
  "Xenova/distilbert-base-uncased-finetuned-conll03-english",
];
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
const GUARD_CANDIDATES = [
  "onnx-community/Llama-Prompt-Guard-2-22M",
  "protectai/deberta-v3-small-prompt-injection-v2",
];
let guardDone = false;
for (const repo of GUARD_CANDIDATES) {
  try {
    guardDone = await fetchHfModel(repo, "guard");
    if (guardDone) break;
  } catch (err) {
    console.log(`  ${repo}: ${err.message}`);
  }
}
if (!guardDone) console.log("SKIP guard: no candidate available. Regex injection detector remains the only guard.");

console.log("\nDone. Missing models are fine — every ML feature degrades to the\nnon-ML path at runtime when its files are absent.");
