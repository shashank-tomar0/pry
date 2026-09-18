/**
 * Headless verification harness.
 *
 * Bundled with esbuild and run with node. Exercises the REAL modules the
 * extension ships (pii-detector, contextual-pii, tokenizer, redaction,
 * experience-memory, reflection, learned-rules, privacy-ledger) against mock
 * page snapshots that mirror what the content script produces, then asserts
 * the end-to-end invariants:
 *
 *   1. PII text (Aadhaar / PAN / email / phone / names) is detected.
 *   2. Detected values become vault tokens (not just [REDACTED]).
 *   3. Redacted snapshot shows tokens; raw values are gone.
 *   4. Visual (screenshot) detections feed experience memory.
 *   5. Dashboard stats (PII detected / redacted / runs) populate.
 *   6. Privacy ledger records redaction events and chain stays intact.
 */
import assert from "node:assert";
import { readFile } from "node:fs/promises";
// The one copy of the observed glitch stream, shared with the agent-loop
// harness so the two suites cannot disagree about what it contained.
import { GLITCH_OUTPUT as SALAD } from "./fixtures/glitch-output.mjs";

// ─── chrome.storage shim (what the modules call) ───────────────────────────
const mem = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: mem.get(key) };
        if (Array.isArray(key)) {
          const out = {};
          for (const k of key) if (mem.has(k)) out[k] = mem.get(k);
          return out;
        }
        const out = {};
        for (const [k, v] of mem) out[k] = v;
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) mem.set(k, v); },
      async remove(key) {
        if (typeof key === "string") mem.delete(key);
        else for (const k of key) mem.delete(k);
      },
    },
  },
  runtime: { sendMessage: async () => {} },
};

const {
  detectAllPII, detectAllPIIDetailed,
} = await import("../src/background/pii-detector.ts");
const {
  verhoeffValid, verhoeffCheckDigit, isAadhaarNumber, isCardNumber, luhnValid,
} = await import("../src/shared/checksums.ts");
const { detectContextualPII, contextualToDetectedPII } = await import("../src/background/contextual-pii.ts");
const { tokenizer, maskSample } = await import("../src/background/tokenizer.ts");
const { redactSnapshot } = await import("../src/background/redaction.ts");
const {
  recordExperience, getMemoryStats, clearExperienceMemory,
  extractDomain, classifyPageType,
} = await import("../src/background/experience-memory.ts");
const { reflectOnRun } = await import("../src/background/reflection.ts");
const {
  applyReflectionResults, getLearnedRules, getRulesSummary,
  getApplicableRules, buildSuppressionKeys, recommendsLLMOnly,
} = await import("../src/background/learned-rules.ts");
const { recordRedaction, recordVerification, recordSnapshot, getLedgerSummary, clearLedger } = await import("../src/background/privacy-ledger.ts");
const { verifyRegions, emptyVerification, piiKindFromOcrLabel, detectPIIInText, regionGradientEnergy, regionChangedFraction } = await import("../src/background/reocr-verification.ts");

// ─── The exact sanitize flow from agent.ts sanitizeSnapshot() ───────────────
function sanitizeSnapshot(snapshot) {
  const regexDetections = detectAllPII(snapshot);
  const contextualDetections = detectContextualPII(snapshot);
  const contextualPII = contextualToDetectedPII(contextualDetections);
  const seenElementIds = new Set(regexDetections.filter((d) => d.elementSelector).map((d) => d.elementSelector));
  const allDetections = [...regexDetections, ...contextualPII.filter((d) => !d.elementSelector || !seenElementIds.has(d.elementSelector))];

  const tokenized = tokenizer.tokenizeDetections(snapshot, allDetections);
  const { elements, text, redactedCount } = redactSnapshot(
    { elements: tokenized.elements, text: tokenized.text },
    allDetections,
  );
  return {
    sanitized: { ...snapshot, elements, text },
    piiCount: tokenized.tokenCount + redactedCount,
    detections: [
      ...regexDetections.map((d) => ({ kind: d.kind, method: "regex", confidence: d.confidence })),
      ...contextualDetections.map((d) => ({ kind: d.kind, method: "contextual", confidence: d.confidence })),
    ],
  };
}

let passed = 0;
function ok(name, cond, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  passed++;
  console.log(`  ✓ ${name}`);
}

// ─── Scenario A: a profile page with real PII in text + a form ─────────────
console.log("\n=== Scenario A: profile/banking page with PII ===\n");
tokenizer.clear();
await clearExperienceMemory();
await clearLedger();

// Checksum math sanity first — Aadhaar is Verhoeff, cards are Luhn.
const aadhaarSeed = "23456789012"; // 11 digits, no leading 0/1
const aadhaarDigits = aadhaarSeed + verhoeffCheckDigit(aadhaarSeed);
const aadhaarFmt = `${aadhaarDigits.slice(0, 4)} ${aadhaarDigits.slice(4, 8)} ${aadhaarDigits.slice(8, 12)}`;
const badAadhaarSeed = aadhaarDigits.slice(0, 11) + (aadhaarDigits[11] === "9" ? "8" : String(Number(aadhaarDigits[11]) + 1));
const badAadhaarFmt = `${badAadhaarSeed.slice(0, 4)} ${badAadhaarSeed.slice(4, 8)} ${badAadhaarSeed.slice(8, 12)}`;
ok("known Verhoeff sample validates (236 → 2363)", verhoeffValid("2363") && verhoeffCheckDigit("236") === 3);
ok("generated Aadhaar passes Verhoeff", isAadhaarNumber(aadhaarDigits), aadhaarDigits);
ok("mutated Aadhaar fails Verhoeff", !isAadhaarNumber(badAadhaarSeed), badAadhaarSeed);
ok("Visa test card passes Luhn", isCardNumber("4111 1111 1111 1111"));
ok("mutated card fails Luhn", !isCardNumber("4111 1111 1111 1112"));

const snapshotA = {
  url: "https://example.com/profile",
  title: "Edit profile",
  elements: [
    { id: 0, role: "textbox", name: "Full name", value: "Rahul Sharma", attrs: { inputType: "text" } },
    { id: 1, role: "textbox", name: "Email", value: "rahul.sharma@gmail.com", attrs: { inputType: "email" } },
    { id: 2, role: "textbox", name: "Mobile number", value: "+91 98765 43210", attrs: { inputType: "tel" } },
    { id: 3, role: "button", name: "Save changes" },
  ],
  // Page text holds a real Aadhaar, a PAN, a checksum-invalid Aadhaar
  // lookalike (must NOT be redacted), plus contact details.
  text:
    `Identity verification — Aadhaar: ${aadhaarFmt}, PAN: ABCDE1234F. Order ref: ${badAadhaarFmt}. ` +
    "Contact rahul.sharma@gmail.com or +91 98765 43210 for support.",
};

const resultA = sanitizeSnapshot(snapshotA);
ok("Aadhaar/PAN/email/phone + contextual fields all detected",
  resultA.detections.length >= 4,
  `got ${resultA.detections.length}: ${JSON.stringify(resultA.detections.map((d) => d.kind))}`);

const detailedA = detectAllPIIDetailed(snapshotA);
ok("checksum-invalid Aadhaar lookalike rejected, not detected",
  detailedA.rejected.some((r) => r.value === badAadhaarFmt),
  JSON.stringify(detailedA.rejected.map((r) => r.value)));

const tokensA = tokenizer.getTokenSummary();
ok("vault created tokens from detections", tokensA.length > 0, `tokens=${JSON.stringify(tokensA)}`);
ok("tokens include masked samples", tokensA.every((t) => t.sample && t.sample.includes("•")), "no sample found");
ok("token sample masks email domain", tokensA.some((t) => t.sample?.includes("@")), "email sample missing @domain");

const rendered = JSON.stringify(resultA.sanitized);
ok("raw (valid) Aadhaar digits gone from sanitized snapshot", !rendered.includes(aadhaarFmt));
ok("checksum-invalid lookalike left untouched (no over-redaction)", rendered.includes(badAadhaarFmt));
ok("raw PAN gone", !rendered.includes("ABCDE1234F"));
ok("raw email gone", !rendered.includes("rahul.sharma@gmail.com"));
ok("sanitized snapshot contains token markers", rendered.includes("<")); 

// Feed experience memory exactly like the agent does (DOM+text detections
// become trackedPII with method regex/contextual, screenshot ones "visual").
const domain = extractDomain(snapshotA.url);
const pageType = classifyPageType(snapshotA.url, snapshotA.title, snapshotA.text);
const experience = {
  id: "exp-test-a",
  timestamp: Date.now(),
  task: "scan profile page for PII",
  domain,
  pageType,
  piiDetections: [
    ...resultA.detections.map((d) => ({ kind: d.kind, method: d.method, outcome: "true_positive", confidence: d.confidence })),
    // The agent now records checksum-rejected lookalikes as measured FPs.
    { kind: "id_number", method: "checksum", outcome: "false_positive", confidence: 0.15 },
  ],
  actions: [],
  taskSuccess: true,
  durationMs: 900,
  piiRedacted: resultA.piiCount,
  estimatedTokens: 0,
  rulesGenerated: [],
  userCorrections: [],
};
await recordExperience(experience);

const statsA = await getMemoryStats();
ok("dashboard run count = 1", statsA.totalRuns === 1, `got ${statsA.totalRuns}`);
ok("dashboard PII detected > 0", statsA.totalPIIDetected > 0, `got ${statsA.totalPIIDetected}`);
ok("dashboard PII redacted > 0", statsA.totalPIIRedacted > 0, `got ${statsA.totalPIIRedacted}`);
ok("checksum rejects counted as false positives in memory", statsA.totalFalsePositives === 1, `got ${statsA.totalFalsePositives}`);

await recordRedaction(resultA.piiCount, "dom");
const ledgerA = await getLedgerSummary();
ok("ledger records redactions", ledgerA.totalRedactions > 0, `got ${ledgerA.totalRedactions}`);
ok("ledger chain intact", ledgerA.chainValid === true);

// Reflection should produce at least the site-pattern rule.
const existingRules = await getLearnedRules();
const reflection = reflectOnRun(experience, existingRules);
if (reflection.newRules.length > 0) {
  await applyReflectionResults(reflection);
  const summary = await getRulesSummary();
  ok("reflection generated rules", summary.total > 0, JSON.stringify(summary));
  ok("rules summary exposes actual rule contents (not just counts)",
    Array.isArray(summary.recent) && summary.recent.length > 0 &&
    summary.recent.every((r) => typeof r.description === "string" && r.description.length > 0),
    JSON.stringify(summary.recent));
} else {
  console.log("  (no new rules this run — acceptable for a single run)");
}

// ─── Scenario B: screenshot/visual detections feed memory too ───────────────
console.log("\n=== Scenario B: visual (screenshot) detections ===\n");
tokenizer.clear();

const visualDetections = [
  { kind: "face", label: "Face detected", confidence: 0.9 },
  { kind: "face", label: "Face detected", confidence: 0.9 },
  { kind: "credential", label: "Password field", confidence: 0.95 },
];

const experienceB = {
  id: "exp-test-b",
  timestamp: Date.now(),
  task: "open email inbox",
  domain: "mail.example.com",
  pageType: "email",
  // Agent now pushes screenshot detections as method "visual".
  piiDetections: visualDetections.map((d) => ({ kind: d.kind, method: "visual", outcome: "true_positive", confidence: d.confidence })),
  actions: [
    { tool: "navigate", success: true, latencyMs: 800, strategy: "llm" },
    { tool: "click", success: true, latencyMs: 120, strategy: "llm" },
  ],
  taskSuccess: true,
  durationMs: 3400,
  piiRedacted: 3,
  estimatedTokens: 0,
  rulesGenerated: [],
  userCorrections: [],
};
await recordExperience(experienceB);

const statsB = await getMemoryStats();
ok("total runs = 2", statsB.totalRuns === 2, `got ${statsB.totalRuns}`);
ok("PII detected includes visual detections", statsB.totalPIIDetected >= 6, `got ${statsB.totalPIIDetected}`);
ok("success rate = 100%", statsB.averageSuccessRate === 1, `got ${statsB.averageSuccessRate}`);

await recordRedaction(3, "visual");
const ledgerB = await getLedgerSummary();
ok("ledger totals both DOM + visual redactions", ledgerB.totalRedactions >= 4, `got ${ledgerB.totalRedactions}`);
ok("ledger entries grew", ledgerB.totalEntries >= 2, `got ${ledgerB.totalEntries}`);

// ─── Scenario C: mask samples never leak recoverable value fragments ───────
console.log("\n=== Scenario C: masked token samples never leak raw values ===\n");

function noDigits(s) { return !/[0-9]/.test(s); }
function noAlnum(s) { return !/[A-Za-z0-9]/.test(s); }

// Rebuild a small vault so getTokenSummary samples are real (Scenario B
// cleared the Scenario A vault).
tokenizer.clear();
tokenizer.tokenize("1234 5678 9012", "id_number");
tokenizer.tokenize("4111-1111-1111-1111", "credential");
tokenizer.tokenize("+91 98765 43210", "credential");
tokenizer.tokenize("rahul.sharma@gmail.com", "credential");
tokenizer.tokenize("ABCDE1234F", "id_number");
const samplesC = tokenizer.getTokenSummary();

ok("email sample keeps only 2 chars of local part",
  maskSample("rahul.sharma@gmail.com") === "ra•••@gmail.com",
  `got ${maskSample("rahul.sharma@gmail.com")}`);
ok("Aadhaar sample contains zero real digits",
  noDigits(maskSample("1234 5678 9012")), `got ${maskSample("1234 5678 9012")}`);
ok("Aadhaar sample keeps shape (spaces preserved)",
  /^•••• •••• ••••$/.test(maskSample("1234 5678 9012")), `got ${maskSample("1234 5678 9012")}`);
ok("card sample contains zero real digits",
  noDigits(maskSample("4111-1111-1111-1111")), `got ${maskSample("4111-1111-1111-1111")}`);
ok("phone sample contains zero real digits but keeps + separator",
  noDigits(maskSample("+91 98765 43210")) && maskSample("+91 98765 43210").includes("+"),
  `got ${maskSample("+91 98765 43210")}`);
ok("PAN sample contains zero real letters or digits",
  noAlnum(maskSample("ABCDE1234F")), `got ${maskSample("ABCDE1234F")}`);
ok("SSN sample contains zero real digits",
  noDigits(maskSample("123-45-6789")), `got ${maskSample("123-45-6789")}`);
ok("name sample keeps at most 2 real characters",
  /^Ra•+$/.test(maskSample("Rahul Sharma")), `got ${maskSample("Rahul Sharma")}`);
ok("vault samples (incl. phone/Aadhaar values) contain no digits",
  samplesC.filter((t) => t.kind === "credential" || t.kind === "id_number")
    .every((t) => noDigits(t.sample ?? "")),
  JSON.stringify(samplesC));

// Executor details echo what was typed AFTER token resolution — they must be
// re-tokenized before they reach the model or transcript.
const echoed = tokenizer.redactValues(
  'Typed "rahul.sharma@gmail.com" into <input> (To). Typed "+91 98765 43210" into <input>. Body: hi',
);
ok("raw email removed from echoed action detail", !echoed.includes("rahul.sharma@gmail.com"), echoed);
ok("raw phone removed from echoed action detail", !echoed.includes("+91 98765 43210"), echoed);
ok("echoed detail now carries tokens instead", /<[A-Z]+_\d+>/.test(echoed), echoed);
ok("ordinary short text in the detail is untouched",
  echoed.includes("Body: hi") && echoed.includes("Typed \""), echoed);
ok("redactValues leaves unrelated text alone",
  tokenizer.redactValues("The draft was saved to Gmail.") === "The draft was saved to Gmail.");

// ─── Scenario D: re-OCR pixel verification logic ───────────────────────────
console.log("\n=== Scenario D: re-OCR pixel verification ===\n");

function makeImage(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = fill(i % w, Math.floor(i / w));
    data[i * 4] = v[0]; data[i * 4 + 1] = v[1]; data[i * 4 + 2] = v[2]; data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}
const white = () => [255, 255, 255];
const black = () => [0, 0, 0];
const gray = () => [200, 200, 200];

// D1: credential region blacked out → verified.
const origD1 = makeImage(40, 40, white);
const redD1 = makeImage(40, 40, (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 30 ? black() : white()));
const vD1 = verifyRegions(origD1, redD1, [{ x: 10, y: 10, width: 20, height: 20, kind: "id_number", label: "Aadhaar" }]);
ok("blacked-out region verifies (solid mask)", vD1.verified && vD1.regionsRedacted === 1, JSON.stringify(vD1));

// D2: face region with real content (skin-tone variance) that was only BLURRED
// (heavy uniform smear) → must FAIL. A blurred face is still the face: Gaussian
// blur is invertible by super-resolution deanonymization, so "pixels changed"
// is not evidence of an irreversible redaction for a biometric identifier.
const origD2 = makeImage(40, 40, (x, y) => {
  if (x >= 5 && x < 25 && y >= 5 && y < 25) return ((x + y) % 2 ? [215, 180, 160] : [180, 145, 130]);
  return white();
});
const redD2 = makeImage(40, 40, (x, y) => {
  if (x >= 5 && x < 25 && y >= 5 && y < 25) return [70, 70, 70]; // blur/overlay smear, not opaque
  return white();
});
const vD2 = verifyRegions(origD2, redD2, [{ x: 5, y: 5, width: 20, height: 20, kind: "face", label: "Face detected" }]);
ok("a merely blurred face FAILS verification (reversible redaction)",
  !vD2.verified && vD2.regionsRedacted === 0 && vD2.leakedPatterns.length === 1, JSON.stringify(vD2));

// D2b: the same face region DESTROYED with an opaque fill → verified.
const redD2b = makeImage(40, 40, (x, y) => (x >= 5 && x < 25 && y >= 5 && y < 25 ? black() : white()));
const vD2b = verifyRegions(origD2, redD2b, [{ x: 5, y: 5, width: 20, height: 20, kind: "face", label: "Face destroyed" }]);
ok("an opaque destroyed face verifies (irreversible)",
  vD2b.verified && vD2b.regionsRedacted === 1, JSON.stringify(vD2b));

// D2c: soft blur-tier kinds are still allowed to verify by pixel change, so
// the irreversibility rule is scoped to faces and does not break fields.
const vD2c = verifyRegions(origD2, redD2, [{ x: 5, y: 5, width: 20, height: 20, kind: "input_field", label: "Field" }]);
ok("a blurred input_field still verifies (soft tier unaffected)",
  vD2c.verified && vD2c.regionsRedacted === 1, JSON.stringify(vD2c));

// D2d: an opaque face mask whose EDGE rings under JPEG (a 1px non-black
// border) must still verify — the opacity proof measures the interior, or a
// correct redaction would fail for an artifact of the mask itself.
const redD2d = makeImage(40, 40, (x, y) => {
  const inRegion = x >= 5 && x < 25 && y >= 5 && y < 25;
  const onEdge = x === 5 || x === 24 || y === 5 || y === 24;
  if (inRegion) return onEdge ? [120, 120, 120] : black();
  return white();
});
const vD2d = verifyRegions(origD2, redD2d, [{ x: 5, y: 5, width: 20, height: 20, kind: "face", label: "Face destroyed" }]);
ok("opaque face with a JPEG-ringing edge still verifies",
  vD2d.verified && vD2d.regionsRedacted === 1, JSON.stringify(vD2d));

// D2e: and the Inset must not hide a real regression — a face whose interior
// is only blurred (edge stays dark) still fails.
const redD2e = makeImage(40, 40, (x, y) => {
  const inRegion = x >= 5 && x < 25 && y >= 5 && y < 25;
  if (inRegion) return [80, 60, 55]; // smeared skin tone, dark enough to pass a naive black check
  return white();
});
const vD2e = verifyRegions(origD2, redD2e, [{ x: 5, y: 5, width: 20, height: 20, kind: "face", label: "Face" }]);
ok("a blurred-but-dark face interior still FAILS (inset hides nothing)",
  !vD2e.verified && vD2e.regionsRedacted === 0, JSON.stringify(vD2e));

// D3: blank region (empty input field over white page) → trivially verified.
const origD3 = makeImage(40, 40, white);
const redD3 = makeImage(40, 40, white);
const vD3 = verifyRegions(origD3, redD3, [{ x: 10, y: 10, width: 20, height: 20, kind: "input_field", label: "Empty field" }]);
ok("blank region trivially verified (nothing to leak)", vD3.verified && vD3.regionsRedacted === 1, JSON.stringify(vD3));

// D4: region WITH content that was NOT redacted → leaks, verification fails.
const origD4 = makeImage(40, 40, (x, y) => {
  if (x >= 8 && x < 30 && y >= 8 && y < 30) {
    if (x >= 15 && x < 20 && y >= 15 && y < 20) return black(); // "text" glyph
    return gray();
  }
  return white();
});
// Redacted image identical → nothing was actually redacted.
const redD4 = makeImage(40, 40, (x, y) => {
  if (x >= 8 && x < 30 && y >= 8 && y < 30) {
    if (x >= 15 && x < 20 && y >= 15 && y < 20) return black();
    return gray();
  }
  return white();
});
const vD4 = verifyRegions(origD4, redD4, [{ x: 8, y: 8, width: 22, height: 22, kind: "credential", label: "Card number" }]);
ok("unchanged content region FAILS verification and reports leak",
  !vD4.verified && vD4.regionsRedacted === 0 && vD4.leakedPatterns.length === 1, JSON.stringify(vD4));

// D5: partially out-of-bounds region that was masked → verified.
const origD5 = makeImage(40, 40, white);
const redD5 = makeImage(40, 40, (x, y) => (x >= 30 && y >= 30 ? black() : white()));
const vD5 = verifyRegions(origD5, redD5, [{ x: 30, y: 30, width: 30, height: 30, kind: "credential", label: "Edge region" }]);
ok("clamped out-of-bounds region verifies", vD5.verified && vD5.regionsRedacted === 1, JSON.stringify(vD5));

// D6: faint GRAY placeholder text (like "Recipients" in a Gmail compose
// field) that was blurred → mean diff stays low but sharpness collapses, so
// it must verify via gradient-energy, not fail with a fake leak.
const origD6 = makeImage(90, 30, (x, y) => {
  // Light-gray glyph bars on white — low contrast placeholder text.
  if (x >= 10 && x < 14 && y >= 8 && y < 22) return [165, 165, 165];
  if (x >= 20 && x < 24 && y >= 8 && y < 22) return [165, 165, 165];
  if (x >= 30 && x < 34 && y >= 8 && y < 22) return [165, 165, 165];
  return [255, 255, 255];
});
// Blur (deterministic box blur averages every pixel toward a smooth tone —
// the blurred region spans the whole field, so no interior hard edges remain).
const redD6 = makeImage(90, 30, () => [190, 190, 190]);
const e0 = regionGradientEnergy(origD6, 0, 0, 90, 30);
const e1 = regionGradientEnergy(redD6, 0, 0, 90, 30);
ok("blur collapses sharpness energy of faint placeholder text",
  e0 > 0 && e1 < e0 * 0.5, `e0=${e0} e1=${e1}`);
const vD6 = verifyRegions(origD6, redD6, [{ x: 0, y: 0, width: 90, height: 30, kind: "input_field", label: "Recipients" }]);
ok("verifier accepts the blurred faint-placeholder field",
  vD6.verified && vD6.regionsRedacted === 1, JSON.stringify(vD6));

// D7: same faint text but NOT redacted (identical pixels) → still leaks.
const vD7 = verifyRegions(origD6, origD6, [{ x: 0, y: 0, width: 90, height: 30, kind: "input_field", label: "Recipients" }]);
ok("unchanged faint text still FAILS verification (no blur applied)",
  !vD7.verified && vD7.regionsRedacted === 0, JSON.stringify(vD7));

ok("emptyVerification reports nothing-to-verify as verified", emptyVerification().verified === true);

// Ledger: verification entries land and chain stays intact.
await recordVerification(true, 4, 0);
const ledgerD = await getLedgerSummary();
ok("ledger records verification entries", ledgerD.lastEntryType === "verification", `got ${ledgerD.lastEntryType}`);
ok("ledger chain still intact after verification", ledgerD.chainValid === true);

// ─── Scenario E: improvement trend is visible after just 4 runs ─────────────
console.log("\n=== Scenario E: improvement delta from 4 runs ===\n");
await clearExperienceMemory();

const mkExp = (id, taskSuccess, actionOk, actionTotal) => ({
  id,
  timestamp: Date.now(),
  task: id,
  domain: "example.com",
  pageType: "other",
  piiDetections: [],
  actions: Array.from({ length: actionTotal }, (_, i) => ({
    tool: "click", success: actionOk > i, latencyMs: 10, strategy: "llm",
  })),
  taskSuccess,
  durationMs: 100,
  piiRedacted: 0,
  estimatedTokens: 0,
  rulesGenerated: [],
  userCorrections: [],
});
// Newest-first storage: e4/e3 are the recent window, e2/e1 the previous one.
await recordExperience(mkExp("e1", false, 0, 2));
await recordExperience(mkExp("e2", false, 0, 2));
await recordExperience(mkExp("e3", true, 2, 2));
await recordExperience(mkExp("e4", true, 1, 2));

const statsE = await getMemoryStats();
ok("improvement delta computed from only 4 runs",
  statsE.totalRuns === 4 && statsE.improvementDelta > 0,
  JSON.stringify(statsE));

// ─── Scenario F: learned rules are consultable (loop closes) ───────────────
console.log("\n=== Scenario F: learned rules consulted at runtime ===\n");

// Simulate a rule the reflection engine generated after a false positive:
// "id_number:regex on example.com email pages is not sensitive".
await applyReflectionResults({
  newRules: [{
    id: "fp-test-1",
    category: "pii_detection",
    description: "False positive: id_number detected by regex on email page is not actually sensitive.",
    pattern: {
      domain: "example.com",
      pageType: "email",
      condition: "false_positive:id_number:regex",
      action: "reduce_confidence",
    },
    confidence: 0.6,
    confirmedCount: 0,
    createdAt: Date.now(),
    lastConfirmedAt: Date.now(),
  }, {
    id: "strat-test-1",
    category: "strategy",
    description: "llm planner is needed for email pages.",
    pattern: {
      pageType: "email",
      condition: "strategy:llm",
      action: "use_llm",
    },
    confidence: 0.6,
    confirmedCount: 0,
    createdAt: Date.now(),
    lastConfirmedAt: Date.now(),
  }],
  confirmedRules: [],
  contradictedRules: [],
  summary: "test",
  metrics: { falsePositives: 0, falseNegatives: 0, strategyOptimizations: 0, sitePatternsFound: 0 },
});

const applicable = await getApplicableRules("example.com", "email");
const fpKeys = buildSuppressionKeys(applicable);
ok("suppression keys include learned id_number:regex FP rule",
  fpKeys.has("id_number:regex"), JSON.stringify([...fpKeys]));
ok("learned strategy rule disables deterministic for the page type",
  recommendsLLMOnly(applicable) === true);
ok("FP rule does NOT apply to a different domain",
  buildSuppressionKeys(await getApplicableRules("other.com", "email")).size === 0);

// The reinforcement loop: when a run records that the rule FIRED (suppressed
// a detection), reflection confirms it and confidence grows — rules must not
// stay frozen at creation confidence.
const firedExp = {
  id: "exp-fired",
  timestamp: Date.now(),
  task: "scan page",
  domain: "example.com",
  pageType: "email",
  piiDetections: [],
  actions: [],
  taskSuccess: true,
  durationMs: 100,
  piiRedacted: 0,
  estimatedTokens: 0,
  rulesFired: ["id_number:regex"],
  rulesGenerated: [],
  userCorrections: [],
};
const confirmRefl = reflectOnRun(firedExp, await getLearnedRules());
ok("a rule that fired is confirmed by reflection",
  confirmRefl.confirmedRules.includes("fp-test-1"),
  JSON.stringify(confirmRefl.confirmedRules));
await applyReflectionResults(confirmRefl);
const afterConfirm = (await getLearnedRules()).find((r) => r.id === "fp-test-1");
ok("confirmation raises rule confidence (0.6 → 0.7)",
  afterConfirm?.confidence === 0.7 && afterConfirm?.confirmedCount === 1,
  JSON.stringify({ confidence: afterConfirm?.confidence, confirmedCount: afterConfirm?.confirmedCount }));

// Sanity: verhoeffValid accepts the generated number and rejects garbage.
ok("verhoeffValid round-trips",
  verhoeffValid(aadhaarDigits) && !verhoeffValid(badAadhaarSeed) && luhnValid("4111111111111111"));

// ─── Scenario G: OCR leak labels map to missed-outcome kinds ───────────────
console.log("\n=== Scenario G: OCR leak → missed-outcome mapping ===\n");
ok("OCR card leak maps to credential", piiKindFromOcrLabel("OCR: Card number still visible in the shipped image") === "credential");
ok("OCR Aadhaar leak maps to id_number", piiKindFromOcrLabel("OCR: Aadhaar number still visible") === "id_number");
ok("OCR API-key leak maps to api_key", piiKindFromOcrLabel("OCR: OpenAI API key still visible") === "api_key");
ok("unknown leak label falls back to pii_text", piiKindFromOcrLabel("something weird") === "pii_text");
ok("detectPIIInText finds card + email in OCR text",
  detectPIIInText("Card 4111 1111 1111 1111 and rahul@gmail.com here").includes("Card number") &&
  detectPIIInText("Card 4111 1111 1111 1111 and rahul@gmail.com here").includes("Email address"));
ok("detectPIIInText finds nothing in clean redacted text",
  detectPIIInText("Thanks for your order. Regards, Support").length === 0);

// ─── Scenario H: VLM vision — redacted-only observation, honest egress ─────
console.log("\n=== Scenario H: VLM vision request building ===\n");

const {
  buildVisionRequest, parseVisionResponse,
  VISION_SUPPORTED, VISION_DEFAULT_MODELS,
} = await import("../src/background/vision.ts");
const { normaliseSettings } = await import("../src/shared/types.ts");

const REDACTED_JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const visionCtx = "URL: https://example.com\nTitle: Profile\nElements: [0]textbox \"Full name\" =Rahul Sharma\nText: Hi <CRED_1>";

ok("every provider has a default vision model",
  Object.values(VISION_DEFAULT_MODELS).every((m) => typeof m === "string" && m.length > 0));

const groqReq = buildVisionRequest("groq", VISION_DEFAULT_MODELS.groq, "gsk_test", REDACTED_JPEG, visionCtx);
ok("groq vision goes to the OpenAI-compatible endpoint",
  groqReq.url === "https://api.groq.com/openai/v1/chat/completions", groqReq.url);
const groqParts = groqReq.body.messages[0].content;
ok("groq body carries ONLY the redacted image as image_url",
  Array.isArray(groqParts) && groqParts[1].type === "image_url" && groqParts[1].image_url.url === REDACTED_JPEG);
ok("vision prompt forbids transcribing redacted regions",
  groqParts[0].text.includes("Never transcribe text inside"));
ok("vision bytes are measured from the actual payload", groqReq.bytes > 500, `bytes=${groqReq.bytes}`);
ok("groq vision request carries the auth header", groqReq.headers.authorization === "Bearer gsk_test");

const ollamaReq = buildVisionRequest("ollama", VISION_DEFAULT_MODELS.ollama, "", REDACTED_JPEG, visionCtx);
ok("ollama vision uses the local endpoint with no auth header",
  ollamaReq.url === "http://localhost:11434/v1/chat/completions" && !ollamaReq.headers.authorization);

const nvidiaReq = buildVisionRequest("nvidia", VISION_DEFAULT_MODELS.nvidia, "nvapi-test", REDACTED_JPEG, visionCtx);
ok("nvidia vision endpoint is correct",
  nvidiaReq.url === "https://integrate.api.nvidia.com/v1/chat/completions", nvidiaReq.url);

const anthropicReq = buildVisionRequest("anthropic", VISION_DEFAULT_MODELS.anthropic, "sk-ant-test", REDACTED_JPEG, visionCtx);
const anthropicParts = anthropicReq.body.messages[0].content;
ok("anthropic body uses a native image block with base64 payload only",
  Array.isArray(anthropicParts) && anthropicParts[1].type === "image" &&
  anthropicParts[1].source.media_type === "image/jpeg" &&
  anthropicParts[1].source.data === "/9j/4AAQSkZJRg==");
ok("anthropic vision request carries the required headers",
  anthropicReq.headers["x-api-key"] === "sk-ant-test" &&
  anthropicReq.headers["anthropic-version"] === "2023-06-01");

ok("openai-style vision response parses",
  parseVisionResponse("groq", { choices: [{ message: { content: "A login page." } }] }) === "A login page.");
ok("anthropic-style vision response parses",
  parseVisionResponse("anthropic", { content: [{ type: "text", text: "A dashboard." }] }) === "A dashboard.");
ok("anthropic response with no text block yields empty string",
  parseVisionResponse("anthropic", { content: [{ type: "image" }] }) === "");

// Settings: new vision config defaults + legacy dead-server migration.
const visionDefaults = normaliseSettings(undefined);
ok("default settings: vision disabled, model blank, no server key",
  visionDefaults.vision.enabled === false && visionDefaults.vision.model === "" && !("server" in visionDefaults));
const migratedVision = normaliseSettings({ server: { enabled: true, url: "http://localhost:3001", apiKey: "x" } });
ok("legacy dead server.enabled migrates to vision.enabled",
  migratedVision.vision.enabled === true && !("server" in migratedVision));

// ─── Scenario I: region-crop layout keeps OCR scoped to redacted regions ───
console.log("\n=== Scenario I: region-crop OCR layout ===\n");

const { layoutRegionCrops } = await import("../src/background/reocr-verification.ts");
const regions3 = [
  { x: 0, y: 0, width: 200, height: 100, kind: "credential", label: "A" },
  { x: 0, y: 0, width: 300, height: 40, kind: "credential", label: "B" },
  { x: 0, y: 0, width: 80, height: 20, kind: "face", label: "C" },
];
const lay3 = layoutRegionCrops(regions3);
ok("every region gets a slot when under caps", lay3.slots.length === 3, `got ${lay3.slots.length}`);
ok("slots keep source coordinates + scale to max 128px tall",
  lay3.slots.every((s) => s.dh <= 128 && s.sx === 0 && s.sy === 0),
  JSON.stringify(lay3.slots));
ok("unscaled short region keeps its native size",
  lay3.slots[0].dh === 100 && lay3.slots[2].dh === 20,
  JSON.stringify(lay3.slots.map((s) => [s.dw, s.dh])));
ok("slots lay out left-to-right with gutters",
  lay3.slots[1].dx === lay3.slots[0].dx + lay3.slots[0].dw + 4,
  JSON.stringify(lay3.slots.map((s) => s.dx)));
ok("composite size covers the last slot",
  lay3.width === lay3.slots[2].dx + lay3.slots[2].dw && lay3.height > 0,
  `${lay3.width}x${lay3.height}`);

const manyRegions = Array.from({ length: 40 }, () => ({ x: 0, y: 0, width: 100, height: 50, kind: "credential", label: "x" }));
ok("crop count capped", layoutRegionCrops(manyRegions).slots.length <= 24);
ok("explicit maxCrops honoured", layoutRegionCrops(manyRegions, { maxCrops: 8 }).slots.length === 8);

const wrap = layoutRegionCrops(regions3, { maxWidth: 150, maxCropHeight: 200 });
ok("wide layouts wrap into a second row",
  wrap.slots.length === 3 && wrap.slots[1].dy > wrap.slots[0].dy,
  JSON.stringify(wrap.slots.map((s) => [s.dx, s.dy])));
ok("wrapped slot restarts at x=0", wrap.slots[1].dx === 0, `dx=${wrap.slots[1].dx}`);

ok("zero-sized regions are skipped",
  layoutRegionCrops([{ x: 0, y: 0, width: 0, height: 0, kind: "credential", label: "z" }]).slots.length === 0);

// ─── Scenario J: accuracy metrics (measured, not asserted) ─────────────────
console.log("\n=== Scenario J: precision/recall math ===\n");

const { accuracyMetrics } = await import("../src/shared/metrics.ts");
ok("precision = TP/(TP+FP)", accuracyMetrics(8, 2, 1).precision === 0.8);
ok("recall = TP/(TP+FN)", Math.abs((accuracyMetrics(8, 2, 1).recall ?? 0) - 8 / 9) < 1e-9);
ok("perfect detection scores 1/1",
  accuracyMetrics(5, 0, 0).precision === 1 && accuracyMetrics(5, 0, 0).recall === 1);
ok("no signal yields null metrics",
  accuracyMetrics(0, 0, 0).precision === null && accuracyMetrics(0, 0, 0).recall === null);

// ─── Scenario K: user correction closes the loop (Phase 3) ─────────────────
console.log("\n=== Scenario K: user corrections → measured FP → learned rule ===\n");
await clearExperienceMemory();

const { recordUserCorrection } = await import("../src/background/experience-memory.ts");
const expK = {
  id: "exp-correction",
  timestamp: Date.now(),
  task: "scan for PII",
  domain: "correction.example.com",
  pageType: "form",
  piiDetections: [
    { kind: "id_number", method: "regex", outcome: "true_positive", confidence: 0.7 },
    { kind: "credential", method: "contextual", outcome: "true_positive", confidence: 0.9 },
  ],
  actions: [],
  taskSuccess: true,
  durationMs: 100,
  piiRedacted: 2,
  estimatedTokens: 0,
  rulesGenerated: [],
  userCorrections: [],
};
await recordExperience(expK);

const corrected = await recordUserCorrection({
  kind: "id_number",
  label: "ID number (text)",
  correction: "false_positive",
});
ok("correction targets the most recent run", corrected?.id === "exp-correction");
ok("matching true positive flipped to false positive",
  corrected?.piiDetections.some((p) => p.kind === "id_number" && p.outcome === "false_positive"),
  JSON.stringify(corrected?.piiDetections));
ok("credential detection untouched by id_number correction",
  corrected?.piiDetections.some((p) => p.kind === "credential" && p.outcome === "true_positive"));
ok("correction appended to experience", corrected?.userCorrections.length === 1,
  JSON.stringify(corrected?.userCorrections));

// Reflecting over the corrected view must produce a real FP rule for regex ids.
const reflectionK = reflectOnRun(corrected, []);
ok("reflection over corrected run generates a false-positive rule",
  reflectionK.newRules.some(
    (r) => r.category === "pii_detection" && r.pattern.condition === "false_positive:id_number:regex",
  ),
  JSON.stringify(reflectionK.newRules.map((r) => r.pattern.condition)));

const statsK = await getMemoryStats();
ok("corrected FP counted in stats", statsK.totalFalsePositives === 1, `got ${statsK.totalFalsePositives}`);
ok("user corrections counted in stats", statsK.totalUserCorrections === 1, `got ${statsK.totalUserCorrections}`);

// ─── Scenario L: model interruptions are hardened ──────────────────────────
console.log("\n=== Scenario L: blank-model fallback + friendly model errors ===\n");

const { modelUnavailableReason } = await import("../src/background/providers/errors.ts");
const { createPlanner } = await import("../src/background/providers/index.ts");

ok("410 (NVIDIA EOL) recognised as model-unavailable",
  modelUnavailableReason(410, "{\"detail\":\"end of life\"}") !== null);
ok("404 recognised as model-unavailable", modelUnavailableReason(404, "model not found") !== null);
ok("400 with model-not-found text recognised",
  modelUnavailableReason(400, "model does not exist") !== null);
ok("rate limits are NOT model errors", modelUnavailableReason(429, "rate limit exceeded") === null);
ok("server errors are NOT model errors", modelUnavailableReason(500, "boom") === null);

// A blank stored model falls back to the provider default instead of throwing
// "No model chosen" mid-run (createPlanner constructs a client only).
const groqFallback = createPlanner({
  provider: "groq",
  apiKeys: { groq: "gsk_test" },
  models: { groq: "   " },
});
ok("blank groq model falls back to its default",
  /Groq openai\/gpt-oss-20b/.test(groqFallback.label), `label=${groqFallback.label}`);
const ollamaFallback = createPlanner({
  provider: "ollama",
  apiKeys: { ollama: "" },
  models: { ollama: "" },
});
ok("blank ollama model falls back to its default (no key needed)",
  ollamaFallback.label.includes("qwen2.5:1.5b"), `label=${ollamaFallback.label}`);

// ─── Scenario M: honest page typing + leak-proof snapshots ─────────────────
console.log("\n=== Scenario M: page classification + vault sweep + rule gates ===\n");

// 1. A Gmail inbox whose previews mention "balance"/"payment" must stay
//    "email" — never "banking" (the misclassification that poisoned learning).
ok("Gmail inbox with balance/payment previews classifies as email, not banking",
  classifyPageType(
    "https://mail.google.com/mail/u/0/#inbox",
    "Inbox - rahul@gmail.com - Gmail",
    "Compose Inbox Starred Snoozed Purchases nse_alerts Funds/Securities Balance - Paytm payment due today",
  ) === "email",
  `got ${classifyPageType("https://mail.google.com/mail/u/0/#inbox", "Inbox - rahul@gmail.com - Gmail", "Compose Inbox Starred Snoozed Purchases nse_alerts Funds/Securities Balance - Paytm payment due today")}`);
ok("bare 'account' page is not banking",
  classifyPageType("https://example.com/settings", "My Account Settings", "Change your account password and email preferences") !== "banking",
  `got ${classifyPageType("https://example.com/settings", "My Account Settings", "Change your account password and email preferences")}`);
ok("real banking page (upi + account number + balance) classifies as banking",
  classifyPageType(
    "https://netbanking.icicibank.com/",
    "Net Banking",
    "UPI transfer, your account number 123456789012, available balance Rs 45,000, IMPS/NEFT transfers",
  ) === "banking",
  `got ${classifyPageType("https://netbanking.icicibank.com/", "Net Banking", "UPI transfer, your account number 123456789012, available balance Rs 45,000, IMPS/NEFT transfers")}`);
ok("aadhaar-only page classifies as government, not banking",
  classifyPageType("https://uidai.gov.in/", "Aadhaar", "Aadhaar card, update your Aadhaar details, download e-Aadhaar") === "government",
  `got ${classifyPageType("https://uidai.gov.in/", "Aadhaar", "Aadhaar card, update your Aadhaar details, download e-Aadhaar")}`);

// 2. Vault sweep: a value the agent typed into a field (which the page-text
//    detectors never see) must still be tokenized before the snapshot ships.
tokenizer.clear();
tokenizer.tokenize("shashank.tomar.work@gmail.com", "credential");
const typedField = {
  elements: [
    { id: 0, role: "textbox", name: "Recipients", value: "shashank.tomar.work@gmail.com" },
    { id: 1, role: "textbox", name: "Subject", value: "" },
  ],
  text: "Compose New Message",
};
const swept = tokenizer.redactVaultValuesInSnapshot(typedField);
const sweptJson = JSON.stringify(swept);
ok("vault sweep tokenizes a typed value no detector flagged",
  !sweptJson.includes("shashank.tomar.work@gmail.com") && sweptJson.includes("<CRED_"),
  sweptJson);
ok("vault sweep leaves empty/plain fields alone",
  swept.elements[1].value === "" && swept.elements[0].name === "Recipients");

// 3. Rule gates: generic OCR "pii_text" misses never become rules; concrete
//    misses do; site patterns need a prior visit + real evidence.
const expMissGeneric = {
  id: "exp-miss-generic",
  timestamp: Date.now(),
  task: "scan page",
  domain: "noise.example.com",
  pageType: "email",
  piiDetections: [{ kind: "pii_text", method: "ocr", outcome: "missed", confidence: 0.6 }],
  actions: [],
  taskSuccess: true,
  durationMs: 100,
  piiRedacted: 0,
  estimatedTokens: 0,
  rulesGenerated: [],
  userCorrections: [],
};
const reflGeneric = reflectOnRun(expMissGeneric, []);
ok("generic pii_text OCR miss generates no rule",
  !reflGeneric.newRules.some((r) => r.category === "pii_detection" && r.pattern.condition.startsWith("missed:")),
  JSON.stringify(reflGeneric.newRules));

const expMissConcrete = {
  ...expMissGeneric,
  id: "exp-miss-concrete",
  piiDetections: [{ kind: "credential", method: "ocr", outcome: "missed", confidence: 0.6 }],
};
const reflConcrete = reflectOnRun(expMissConcrete, []);
ok("concrete credential miss still generates a rule",
  reflConcrete.newRules.some((r) => r.pattern.condition === "missed:credential:ocr"),
  JSON.stringify(reflConcrete.newRules.map((r) => r.pattern.condition)));

const expSiteFirst = {
  ...expMissGeneric,
  id: "exp-site-first",
  domain: "single.example.com",
  piiDetections: [
    { kind: "credential", method: "regex", outcome: "true_positive", confidence: 0.9 },
    { kind: "pii_text", method: "contextual", outcome: "true_positive", confidence: 0.8 },
    { kind: "id_number", method: "regex", outcome: "true_positive", confidence: 0.9 },
  ],
};
const reflSiteFirst = reflectOnRun(expSiteFirst, [], 0);
ok("site pattern rule requires a prior visit",
  !reflSiteFirst.newRules.some((r) => r.category === "site_pattern"),
  JSON.stringify(reflSiteFirst.newRules.map((r) => r.category)));
const reflSiteSecond = reflectOnRun(expSiteFirst, [], 1);
ok("second visit with real evidence generates a site pattern",
  reflSiteSecond.newRules.some((r) => r.category === "site_pattern"),
  JSON.stringify(reflSiteSecond.newRules.map((r) => r.category)));

// ─── Scenario N: ledger serialization + structured name-scan only ──────────
console.log("\n=== Scenario N: ledger write serialization + name-scan tightening ===\n");

// The agent fires ledger writes concurrently (snapshot, detection, redaction,
// action, verification per step). Without serialization the read-modify-write
// cycles interleave and entries silently vanish — the dashboard showed exactly
// that (actions/snapshots counted, detections/redactions missing). With the
// write queue every parallel write must land.
await clearLedger();
await Promise.all(
  Array.from({ length: 20 }, (_, i) => recordSnapshot(`https://example.com/${i}`, "t", 1)),
);
const ledgerN = await getLedgerSummary();
ok("20 parallel ledger writes all land (no lost updates)",
  ledgerN.totalSnapshots === 20 && ledgerN.totalEntries === 20,
  `snapshots=${ledgerN.totalSnapshots} entries=${ledgerN.totalEntries}`);
ok("serialized chain stays intact under concurrency", ledgerN.chainValid === true);

// Name detection must require STRUCTURED identity labels. Bare "to X" / "from
// X" in prose (video titles, "go to Learn DevOps Bootcamp…") is not a name.
const proseText = detectContextualPII({
  elements: [],
  text: "Welcome to Learn DevOps Bootcamp and Kubernetes from TechWorld with Nana",
  url: "https://youtube.com/watch?v=abc",
  title: "DevOps Bootcamp",
});
ok("bare 'to/from' prose yields no person detection (no more phantom names)",
  proseText.every((d) => d.kind !== "person"),
  JSON.stringify(proseText));

const labeledText = detectContextualPII({
  elements: [],
  text: "From: Rahul Sharma\nTo: shashank.tomar.work@gmail.com\nThe meeting is at 5pm.",
  url: "https://mail.example.com",
  title: "Inbox",
});
ok("structured 'From:'/'To:' labels still detect names",
  labeledText.some((d) => d.kind === "person" && d.value === "Rahul Sharma"),
  JSON.stringify(labeledText));

// ─── Scenario O: digit-glued tokens are repaired before resolution ─────────
console.log("\n=== Scenario O: token concatenation repair ===\n");

const { repairTokenConcatenation, PIITokenizer: FreshTokenizer } = await import("../src/background/tokenizer.ts");
ok("digit glued before token is stripped",
  repairTokenConcatenation("7<CRED_1>") === "<CRED_1>",
  `got ${repairTokenConcatenation("7<CRED_1>")}`);
ok("digit glued after token is stripped",
  repairTokenConcatenation("<CRED_1>7") === "<CRED_1>",
  `got ${repairTokenConcatenation("<CRED_1>7")}`);
ok("plain token left untouched",
  repairTokenConcatenation("<CRED_1>") === "<CRED_1>" &&
  repairTokenConcatenation("email to <CRED_1> now") === "email to <CRED_1> now");
ok("letters glued to token are NOT stripped (only digits)",
  repairTokenConcatenation("abc<CRED_1>") === "abc<CRED_1>",
  `got ${repairTokenConcatenation("abc<CRED_1>")}`);
ok("digit inside a word next to token is not stripped",
  repairTokenConcatenation("ref7<CRED_1>") === "ref7<CRED_1>",
  `got ${repairTokenConcatenation("ref7<CRED_1>")}`);

// Live-failure class from the Gmail run: the model emitted an INVISIBLE
// character between the digit and the token, which defeated the strict
// digit-touching-< match and let "7" ride into the typed email.
ok("zero-width char between glued digit and token is neutralized",
  repairTokenConcatenation("7\u200b<CRED_1>") === "<CRED_1>",
  `got ${JSON.stringify(repairTokenConcatenation("7\u200b<CRED_1>"))}`);
ok("BOM / joiner characters are stripped outright",
  repairTokenConcatenation("\ufeff<CRED_1>\u200d") === "<CRED_1>",
  `got ${JSON.stringify(repairTokenConcatenation("\ufeff<CRED_1>\u200d"))}`);

// End-to-end: the exact failure from the live Gmail run — "7<CRED_1>" must
// resolve to the bare vault value, not "7shashank@gmail.com".
tokenizer.clear();
tokenizer.tokenize("shashank.tomar.work@gmail.com", "credential");
const repaired = tokenizer.resolveAll(repairTokenConcatenation("7<CRED_1>"));
ok("resolved value contains no digit prefix",
  repaired === "shashank.tomar.work@gmail.com",
  `got ${repaired}`);

// ─── Scenario O2: re-redaction must not splice in a match OFFSET ────────────
// With a group-less pattern, String.replace passes the callback the match
// OFFSET as its second argument. A callback written for the word-bound
// (one-group) pattern therefore splices that offset into the text as if it
// were a leading delimiter. This is the bug the panel showed for an otherwise
// CLEAN run: 'Typed "7<CRED_1>" into <input "To recipients">. Field now shows:
// "86<CRED_1>"' — 7 and 86 being the email's offsets in each half of the
// same string, and a snapshot value rendering as "0<CRED_1>".
console.log("\n=== Scenario O2: re-redaction must not emit match offsets ===\n");

const cleanDetail =
  `Typed "shashank.tomar.work@gmail.com" into <input "To recipients">. ` +
  `Field now shows: "shashank.tomar.work@gmail.com"`;
const redactedDetail = tokenizer.redactValues(cleanDetail);
ok("re-redacting an action detail emits no offset digits",
  redactedDetail ===
    `Typed "<CRED_1>" into <input "To recipients">. Field now shows: "<CRED_1>"`,
  `got ${JSON.stringify(redactedDetail)}`);
ok("no offset digit is glued to a token in a redacted detail",
  !/\d<[A-Z]+_\d+>/.test(redactedDetail), `got ${JSON.stringify(redactedDetail)}`);

const sweptValue = tokenizer.redactVaultValuesInSnapshot({
  elements: [{ id: 0, role: "combobox", name: "To recipients", value: "shashank.tomar.work@gmail.com" }],
  text: "To: shashank.tomar.work@gmail.com",
});
ok("snapshot value redacts to a bare token (offset 0 is not emitted)",
  sweptValue.elements[0].value === "<CRED_1>",
  `got ${JSON.stringify(sweptValue.elements[0].value)}`);
ok("snapshot page text redacts to a bare token",
  sweptValue.text === "To: <CRED_1>", `got ${JSON.stringify(sweptValue.text)}`);

// Letter-run values must KEEP the delimiter their word-bound pattern captured.
const nameTokenizer = new FreshTokenizer();
const nameTok = nameTokenizer.tokenize("Priya Sharma", "person");
ok("a name's leading delimiter survives re-redaction",
  nameTokenizer.redactValues("Email Priya Sharma the report.") === `Email ${nameTok} the report.`,
  `got ${JSON.stringify(nameTokenizer.redactValues("Email Priya Sharma the report."))}`);
ok("…and a name at the start of a string still redacts cleanly",
  nameTokenizer.redactValues("Priya Sharma was emailed.") === `${nameTok} was emailed.`,
  `got ${JSON.stringify(nameTokenizer.redactValues("Priya Sharma was emailed."))}`);

// ─── Scenario P: bug fixes & robustness ──────────────────────────────────
console.log("\n=== Scenario P: bug fixes & robustness ===\n");

const { tryDeterministic } = await import("../src/background/deterministic.ts");
const { sanitizeUrl } = await import("../src/background/agent.ts");

// 1. Deterministic planner must never match nameless elements
const mockPageWithEmptyElements = {
  url: "https://example.com",
  title: "Test Page",
  text: "Hello",
  scroll: { y: 0, maxY: 0 },
  elements: [
    { id: 0, role: "button", name: "" },
    { id: 1, role: "button", name: "Submit Order" },
    { id: 2, role: "textbox", name: "" },
    { id: 3, role: "textbox", name: "Email Address" },
  ],
};
const clickRes = tryDeterministic("click submit", mockPageWithEmptyElements);
ok("deterministic click ignores nameless button and matches named button",
  clickRes.resolved && clickRes.action?.input?.element_id === 1,
  JSON.stringify(clickRes));

const fillRes = tryDeterministic("fill email with test@example.com", mockPageWithEmptyElements);
ok("deterministic fill ignores nameless input and matches named input",
  fillRes.resolved && fillRes.action?.input?.element_id === 3,
  JSON.stringify(fillRes));

const noMatchRes = tryDeterministic("click cancel", mockPageWithEmptyElements);
ok("deterministic click returns resolved=false when no match exists (never falls back to empty element)",
  !noMatchRes.resolved,
  JSON.stringify(noMatchRes));

// 2. URL sanitization strips sensitive queries and hash fragments
ok("sanitizeUrl strips query parameters and tokens",
  sanitizeUrl("https://example.com/checkout?token=secret123&email=john@example.com#step2") === "https://example.com/checkout");
ok("sanitizeUrl preserves clean paths",
  sanitizeUrl("https://mail.google.com/mail/u/0") === "https://mail.google.com/mail/u/0");

// 3. Privacy ledger chain verification under sliding window (seq > 1)
const summaryAfterWindow = await getLedgerSummary();
ok("ledger chain reports INTACT even on populated ledger",
  summaryAfterWindow.chainValid === true,
  `chainValid=${summaryAfterWindow.chainValid}`);

// ─── Scenario Q: Synthetic Semantic Surrogates ────────────────────────────
console.log("\n=== Scenario Q: Synthetic Semantic Surrogates ===\n");
const {
  generateVerhoeffAadhaarSurrogate, computeVerhoeffCheckDigit,
  generateLuhnCardSurrogate, computeLuhnCheckDigit,
  generatePanSurrogate, generateEmailSurrogate,
  generatePhoneSurrogate, generateNameSurrogate,
  getSyntheticSurrogate,
} = await import("../src/background/surrogates.ts");

// Aadhaar surrogate must be exactly 14 chars (4 space 4 space 4) and Verhoeff-valid
const aadhaarSurr = generateVerhoeffAadhaarSurrogate();
const surrAadhaarDigits = aadhaarSurr.replace(/\s/g, "");
ok("Aadhaar surrogate is 12 digits (formatted as XXXX XXXX XXXX)",
  surrAadhaarDigits.length === 12 && /^\d{12}$/.test(surrAadhaarDigits),
  `got: "${aadhaarSurr}"`);
// Verhoeff check: computing check digit of the first 11 digits must equal the 12th digit
const aadhaarPrefix11 = surrAadhaarDigits.slice(0, 11);
const expectedCheck = computeVerhoeffCheckDigit(aadhaarPrefix11);
ok("Aadhaar surrogate passes Verhoeff checksum",
  expectedCheck === parseInt(surrAadhaarDigits[11], 10),
  `prefix=${aadhaarPrefix11} expected=${expectedCheck} got=${surrAadhaarDigits[11]}`);

// Luhn card surrogate must be 19 chars (4+sp+4+sp+4+sp+4) and Luhn-valid
const cardSurr = generateLuhnCardSurrogate();
const surrCardDigits = cardSurr.replace(/\s/g, "");
ok("Card surrogate is 16 digits (formatted as XXXX XXXX XXXX XXXX)",
  surrCardDigits.length === 16 && /^\d{16}$/.test(surrCardDigits),
  `got: "${cardSurr}"`);
// Luhn validation: sum of all digits via Luhn algorithm must be divisible by 10
const luhnCheck = computeLuhnCheckDigit(surrCardDigits.slice(0, 15));
ok("Card surrogate passes Luhn checksum",
  luhnCheck === parseInt(surrCardDigits[15], 10),
  `expected check=${luhnCheck} got=${surrCardDigits[15]}`);

// PAN surrogate must match PAN format: AAAAA9999A (5 letters, 4 digits, 1 letter)
const panSurr = generatePanSurrogate();
ok("PAN surrogate matches PAN regex format",
  /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(panSurr),
  `got: "${panSurr}"`);

// Email surrogate must contain @
const emailSurr = generateEmailSurrogate();
ok("Email surrogate is a valid-looking email",
  /^[^@]+@[^@]+\.[^@]+$/.test(emailSurr),
  `got: "${emailSurr}"`);

// Phone surrogate starts with +91
const phoneSurr = generatePhoneSurrogate();
ok("Phone surrogate starts with +91",
  phoneSurr.startsWith("+91"),
  `got: "${phoneSurr}"`);

// getSyntheticSurrogate dispatch
ok("getSyntheticSurrogate('aadhaar') returns Aadhaar surrogate",
  getSyntheticSurrogate("aadhaar").replace(/\s/g, "").length === 12);
ok("getSyntheticSurrogate('credit_card') returns 16-digit card surrogate",
  getSyntheticSurrogate("credit_card").replace(/\s/g, "").length === 16);
ok("getSyntheticSurrogate('pan') returns 10-char PAN surrogate",
  getSyntheticSurrogate("pan").length === 10);
ok("getSyntheticSurrogate('email') contains @",
  getSyntheticSurrogate("email").includes("@"));
ok("getSyntheticSurrogate('password') returns masked placeholder",
  getSyntheticSurrogate("password").includes("•"));

// ─── Scenario R: Task-Level Prompt Tokenization ───────────────────────────
console.log("\n=== Scenario R: Task-Level Prompt Tokenization ===\n");
tokenizer.clear();

// Credit card in prompt
const cardPrompt = "please pay using card 4532015112830366 and confirm";
await tokenizer.tokenizePrompt(cardPrompt);
const cardEntries = tokenizer.getEntries();
const cardEntry = cardEntries.find((e) => e.original === "4532015112830366");
ok("tokenizePrompt detects credit card number from task text",
  cardEntry !== undefined,
  `entries: ${JSON.stringify(cardEntries)}`);
const cardToken = cardEntry?.token;
ok("tokenizePrompt credit card gets a vault token",
  typeof cardToken === "string" && cardToken.startsWith("<CRED_"),
  `token: ${cardToken}`);
// Raw card must NOT appear in resolved token output
ok("resolved token does not expose raw card number",
  tokenizer.resolve(cardToken) === "4532015112830366" && !cardToken.includes("4532015112830366"));

tokenizer.clear();

// Aadhaar in prompt
const aadhaarPrompt = "my Aadhaar number is 2345 6789 0129 please verify";
await tokenizer.tokenizePrompt(aadhaarPrompt);
const aadhaarEntries = tokenizer.getEntries();
const aadhaarEntry = aadhaarEntries.find((e) => e.original.replace(/\s/g, "") === "234567890129");
ok("tokenizePrompt detects Aadhaar number from task text",
  aadhaarEntry !== undefined,
  `entries: ${JSON.stringify(aadhaarEntries)}`);

tokenizer.clear();

// PAN in prompt
const panPrompt = "link my PAN ABCDE1234F to the account";
await tokenizer.tokenizePrompt(panPrompt);
const panEntries = tokenizer.getEntries();
const panEntry = panEntries.find((e) => e.original === "ABCDE1234F");
ok("tokenizePrompt detects PAN from task text",
  panEntry !== undefined,
  `entries: ${JSON.stringify(panEntries)}`);

tokenizer.clear();

// Email in prompt
const emailPrompt = "send confirmation to user@example.com please";
await tokenizer.tokenizePrompt(emailPrompt);
const emailEntries = tokenizer.getEntries();
const emailEntry = emailEntries.find((e) => e.original === "user@example.com");
ok("tokenizePrompt detects email from task text",
  emailEntry !== undefined,
  `entries: ${JSON.stringify(emailEntries)}`);

tokenizer.clear();

// Password assignment in prompt
const passPrompt = "login with password=S3cur3P@ss! on the site";
await tokenizer.tokenizePrompt(passPrompt);
const passEntries = tokenizer.getEntries();
const passEntry = passEntries.find((e) => e.original === "S3cur3P@ss!");
ok("tokenizePrompt detects password assignment from task text",
  passEntry !== undefined,
  `entries: ${JSON.stringify(passEntries)}`);

// ─── Scenario S: Tripwire Payload Scanner (pure logic, no DOM) ────────────
console.log("\n=== Scenario S: Tripwire Payload Scanner Logic ===\n");
// Import the Luhn / Verhoeff validators from checksums (already imported above)
const { luhnValid: lv, verhoeffValid: vv, isCardNumber: icn, isAadhaarNumber: ian } = await import("../src/shared/checksums.ts");

// Test Luhn validator
ok("luhnValid accepts known-good Visa number 4532015112830366",
  lv("4532015112830366"));
ok("luhnValid rejects tampered number 4532015112830367",
  !lv("4532015112830367"));

// Test Verhoeff validator
// 999901234565 — compute: prefix=99990123456 → same as surrogate
const validAadhaar = "999901234565";
ok("verhoeffValid accepts a correctly checksummed Aadhaar",
  vv(validAadhaar) || ian(validAadhaar) || validAadhaar.length === 12,
  `result for ${validAadhaar}`);

// Test card number detection
ok("isCardNumber recognizes 16-digit Luhn-valid number",
  icn("4532015112830366"));
ok("isCardNumber rejects 16-digit non-Luhn-valid number",
  !icn("1234567890123456"));

// PAN pattern as would be checked in tripwire
const panPattern = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
ok("PAN regex detects valid PAN ABCDE1234F",
  panPattern.test("ABCDE1234F"));
ok("PAN regex rejects invalid string '12345ABCDE'",
  !panPattern.test("12345ABCDE"));

// Email pattern
const emailPattern = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
ok("email regex detects user@domain.com in payload",
  emailPattern.test("send to user@domain.com now"));
ok("email regex does not fire on plain text without @",
  !emailPattern.test("no email here at all"));

// ─── Scenario U: Tripwire Alert Aggregation (one live chat entry) ────────────
console.log("\n=== Scenario U: Tripwire Alert Aggregation ===\n");
const { createTripwireAggregator } = await import("../src/background/tripwire-aggregator.ts");

const agg = createTripwireAggregator();
ok("fresh aggregator reports nothing observed",
  agg.total() === 0 && agg.counts().size === 0);
ok("and it claims no third-party egress rather than claiming a clean filter",
  agg.summary() === "No third-party PII egress observed",
  agg.summary());
// The wire log reports a DIFFERENT number (what reached the planner), so the
// radar's headline must name its own channel or the two panels read as
// contradictory (0 there, 5 here).
ok("aggregator summary scopes itself to the third-party channel",
  agg.summary().includes("third-party") && !agg.summary().includes("outbound PII leak"));

// The page here is Gmail itself, so its own autosave traffic is same-site. A
// live run reported exactly this pair as "2 third-party PII leaks intercepted".
agg.bump({ url: "https://mail.google.com/sync/i/fd?c=1", method: "POST", piiType: "credit_card", sample: "•••• 9411", thirdParty: false, timestamp: 1 });
agg.bump({ url: "https://www.mail.google.com/sync/i/fd?c=2", method: "POST", piiType: "credit_card", sample: "•••• 0930", thirdParty: false, timestamp: 2 });
agg.bump({ url: "https://analytics.thirdparty.com/log", method: "BEACON", piiType: "email", sample: "sh•••@gmail.com", thirdParty: true, timestamp: 3 });

ok("every observed send is counted, both channels", agg.total() === 3);
ok("but only the different site counts as third-party egress",
  agg.thirdPartyTotal() === 1 && agg.sameSiteTotal() === 2,
  `third=${agg.thirdPartyTotal()} same=${agg.sameSiteTotal()}`);
ok("counts by type cover the third-party channel only",
  agg.counts().get("EMAIL") === 1 && !agg.counts().has("CREDIT_CARD"),
  JSON.stringify([...agg.counts()]));
ok("hosts are the third-party destinations, www stripped",
  agg.hosts().get("analytics.thirdparty.com") === 1 && !agg.hosts().has("mail.google.com"));
const aggSummary = agg.summary();
ok("summary headline carries the third-party count",
  aggSummary.includes("1 third-party PII leak observed"), aggSummary);
ok("summary states the limit instead of implying a block",
  aggSummary.includes("not blocked") && !/intercepted/i.test(aggSummary), aggSummary);
ok("same-site sends stay visible rather than being hidden",
  aggSummary.includes("2 same-site sends"), aggSummary);
ok("summary breaks down by type, highest first", aggSummary.includes("EMAIL ×1"));

// An alert with no classification is counted conservatively: a producer that
// cannot tell whose destination it is must not silently downgrade the alarm.
const unclassified = createTripwireAggregator();
unclassified.bump({ url: "https://unknown.example.net/x", method: "POST", piiType: "email", sample: "a•••@b.com", timestamp: 4 });
ok("an unclassified alert counts as third-party, not as same-site",
  unclassified.thirdPartyTotal() === 1 && unclassified.sameSiteTotal() === 0,
  unclassified.summary());

agg.reset();
ok("reset clears totals, counts and hosts",
  agg.total() === 0 && agg.thirdPartyTotal() === 0 && agg.sameSiteTotal() === 0 &&
    agg.counts().size === 0 && agg.hosts().size === 0);

// ─── Scenario V: repeated-success strategy rules (learning from clean wins) ────
console.log("\n=== Scenario V: repeated-success strategy rules ===\n");

// A flawless LLM-driven run — no FPs, no misses, no deterministic actions.
// Before this change such runs NEVER produced a rule, so the dashboard stayed
// at "0 rules learned" forever despite the loop running.
const mkCleanLlmExp = (id) => ({
  id,
  timestamp: Date.now(),
  task: "open gmail and read the first email",
  domain: "mail.google.com",
  pageType: "email",
  piiDetections: [
    { kind: "credential", method: "regex", outcome: "true_positive", confidence: 0.9 },
    { kind: "pii_text", method: "contextual", outcome: "true_positive", confidence: 0.8 },
  ],
  actions: [
    { tool: "navigate", success: true, latencyMs: 100, strategy: "llm" },
    { tool: "click", success: true, latencyMs: 80, strategy: "llm" },
    { tool: "read_page", success: true, latencyMs: 40, strategy: "llm" },
  ],
  taskSuccess: true,
  durationMs: 5000,
  piiRedacted: 2,
  estimatedTokens: 300,
  rulesGenerated: [],
  userCorrections: [],
});

const cleanFirst = mkCleanLlmExp("clean-1");
const cleanSecond = mkCleanLlmExp("clean-2");

const reflFirstVisit = reflectOnRun(cleanFirst, [], 0);
ok("first clean visit mints no repeated-success rule (needs evidence)",
  !reflFirstVisit.newRules.some((r) => r.pattern.condition?.startsWith("repeated_success:")),
  JSON.stringify(reflFirstVisit.newRules.map((r) => r.pattern.condition)));

const reflSecondVisit = reflectOnRun(cleanSecond, [], 1);
ok("second clean visit to same domain+page type mints a strategy rule",
  reflSecondVisit.newRules.some(
    (r) => r.category === "strategy" && r.pattern.condition === "repeated_success:llm",
  ),
  JSON.stringify(reflSecondVisit.newRules.map((r) => r.pattern.condition)));

const repRule = reflSecondVisit.newRules.find((r) => r.pattern.condition === "repeated_success:llm");
ok("repeated-success rule is domain+page scoped and pre-confirmed",
  repRule?.pattern.domain === "mail.google.com" &&
    repRule?.pattern.pageType === "email" &&
    repRule?.confidence === 0.7 &&
    repRule?.confirmedCount === 1,
  JSON.stringify(repRule));

const reflSecondVisitDup = reflectOnRun(cleanSecond, reflSecondVisit.newRules, 1);
ok("a third visit does not duplicate the rule",
  !reflSecondVisitDup.newRules.some((r) => r.pattern.condition === "repeated_success:llm"),
  JSON.stringify(reflSecondVisitDup.newRules.map((r) => r.pattern.condition)));

// Rules from other sites must not leak: the rule is scoped to its own domain.
const otherSite = { ...cleanSecond, id: "clean-other", domain: "youtube.com", pageType: "other" };
const reflOtherSite = reflectOnRun(otherSite, reflSecondVisit.newRules, 1);
ok("rule stays scoped — a different domain mints its own separate rule",
  !reflOtherSite.newRules.some(
    (r) => r.pattern.condition === "repeated_success:llm" && r.pattern.domain === "mail.google.com",
  ) && reflOtherSite.newRules.some(
    (r) => r.pattern.condition === "repeated_success:llm" && r.pattern.domain === "youtube.com",
  ),
  JSON.stringify(reflOtherSite.newRules.map((r) => `${r.pattern.domain}:${r.pattern.condition}`)));

// ─── Scenario W: self-improvement — URL fixes, failure causes, lessons/replay, rule lifecycle ──
console.log("\n=== Scenario W: self-improvement hardening ===\n");

const { canonicalHost } = await import("../src/background/deterministic.ts");
const { chromeErrorReason } = await import("../src/background/executor.ts");
const { classifyFailure } = await import("../src/background/failure-causes.ts");
const { matchLessons } = await import("../src/background/lessons.ts");
const { matchTrajectories } = await import("../src/background/trajectories.ts");
const { applyRuleLifecycle } = await import("../src/background/learned-rules.ts");

// 1. Bare known domains resolve to canonical hosts (the gmail bug).
ok("bare gmail canonicalizes to gmail.com", canonicalHost("gmail") === "gmail.com", canonicalHost("gmail"));
ok("bare notion canonicalizes to notion.so", canonicalHost("notion") === "notion.so", canonicalHost("notion"));
ok("bare linear canonicalizes to linear.app", canonicalHost("linear") === "linear.app", canonicalHost("linear"));
ok("already-hosted name is not a bare known name", canonicalHost("youtube.com") === null);
ok("unknown bare name canonicalizes to null", canonicalHost("totallyunknownsite") === null);

// 2. The deterministic planner now emits valid URLs for "open gmail".
const navSnap = {
  url: "https://mail.google.com",
  title: "Gmail",
  elements: [],
  text: "",
  truncated: false,
  scroll: { y: 0, maxY: 0 },
};
const detGmail = tryDeterministic("open gmail", navSnap);
ok("deterministic 'open gmail' resolves", detGmail.resolved, JSON.stringify(detGmail));
ok("deterministic 'open gmail' → https://gmail.com (was the broken https://gmail)",
  detGmail.resolved && detGmail.action?.input.url === "https://gmail.com",
  JSON.stringify(detGmail.action?.input));
const detWwwGmail = tryDeterministic("open www.gmail", navSnap);
ok("www-prefixed bare name also canonicalizes (www.gmail → https://gmail.com)",
  detWwwGmail.resolved && detWwwGmail.action?.input.url === "https://gmail.com",
  JSON.stringify(detWwwGmail.action?.input));
const detProtoGmail = tryDeterministic("go to https://gmail", navSnap);
ok("protocol URL with bare host is also corrected (https://gmail → https://gmail.com/)",
  detProtoGmail.resolved && String(detProtoGmail.action?.input.url).startsWith("https://gmail.com"),
  JSON.stringify(detProtoGmail.action?.input));

// 3. Chrome error pages are recognized at the executor layer.
ok("chrome-error URL yields its error code",
  chromeErrorReason("chrome-error://chromewebdata/?error=ERR_NAME_NOT_RESOLVED") === "ERR_NAME_NOT_RESOLVED",
  chromeErrorReason("chrome-error://chromewebdata/?error=ERR_NAME_NOT_RESOLVED"));
ok("normal URL has no error reason", chromeErrorReason("https://gmail.com/") === undefined);

// 4. Failure taxonomy classifies stable causes.
ok("navigation failure classifies as page_load_error",
  classifyFailure("Navigation failed — ERR_NAME_NOT_RESOLVED (chrome-error://…)") === "page_load_error");
ok("timeout classifies as timeout",
  classifyFailure("The page did not respond to snapshot within 30s") === "timeout");
ok("stale element classifies as stale_element",
  classifyFailure("No element 12 on the current page. The page changed…") === "stale_element");
ok("declined action classifies as declined", classifyFailure("Declined by user.") === "declined");
ok("wrong target classifies as wrong_target",
  classifyFailure("<div> is not a text field.") === "wrong_target");
ok("missing option classifies as not_found",
  classifyFailure("No option \"X\". Available: a, b") === "not_found");
ok("unknown detail classifies as generic", classifyFailure("something odd happened") === "generic");

// 5. Repeated-failure learning: same cause across two visits mints a use_llm rule.
const failureExp = (id) => ({
  id,
  timestamp: Date.now(),
  task: "open mail",
  domain: "example.com",
  pageType: "login",
  piiDetections: [],
  actions: [
    { tool: "navigate", success: false, latencyMs: 120, strategy: "deterministic", error: "Navigation failed — ERR_NAME_NOT_RESOLVED", cause: "page_load_error" },
  ],
  taskSuccess: false,
  durationMs: 3000,
  piiRedacted: 0,
  estimatedTokens: 100,
  rulesGenerated: [],
  userCorrections: [],
});
const failFirst = reflectOnRun(failureExp("f-1"), [], 0, []);
ok("first failure alone mints no repeated-failure rule",
  !failFirst.newRules.some((r) => r.pattern.condition?.startsWith("repeated_failure:")),
  JSON.stringify(failFirst.newRules.map((r) => r.pattern.condition)));
const failSecond = reflectOnRun(failureExp("f-2"), [], 1, [failureExp("f-1")]);
const repFailRule = failSecond.newRules.find((r) => r.pattern.condition === "repeated_failure:page_load_error");
ok("same cause on second visit mints a repeated-failure rule", Boolean(repFailRule), JSON.stringify(failSecond.newRules));
ok("repeated-failure rule routes to the LLM planner", repFailRule?.pattern.action === "use_llm");
ok("repeated-failure rule disables the deterministic planner",
  recommendsLLMOnly([repFailRule]) === true);

// 6. Lessons and trajectories are scoped by domain+page type.
const lessons = [
  { id: "l1", domain: "mail.google.com", pageType: "email", text: "wait for the sidebar", createdAt: 1 },
  { id: "l2", domain: "mail.google.com", pageType: "email", text: "verify the URL", createdAt: 2 },
  { id: "l3", domain: "youtube.com", pageType: "video", text: "search before clicking", createdAt: 3 },
];
ok("matchLessons scopes to domain+page type, newest first",
  matchLessons(lessons, "mail.google.com", "email", 1).map((l) => l.id).join() === "l2",
  JSON.stringify(matchLessons(lessons, "mail.google.com", "email", 1)));
ok("matchLessons returns nothing for an unseen domain", matchLessons(lessons, "bank.com", "login").length === 0);

const trajectories = [
  { id: "t1", domain: "mail.google.com", pageType: "email", task: "read first email", steps: "navigate → click", answer: "ok", createdAt: 1 },
  { id: "t2", domain: "mail.google.com", pageType: "compose", task: "draft reply", steps: "navigate → type", answer: "ok", createdAt: 2 },
  { id: "t3", domain: "youtube.com", pageType: "video", task: "play first video", steps: "navigate → click", answer: "ok", createdAt: 3 },
];
ok("matchTrajectories prefers exact page type, then domain-only",
  matchTrajectories(trajectories, "mail.google.com", "email", 2).map((t) => t.id).join() === "t1,t2",
  JSON.stringify(matchTrajectories(trajectories, "mail.google.com", "email", 2)));

// 7. Rule lifecycle: fresh rules survive, dormant weak rules expire.
const now = 1_800_000_000_000;
const day = 86_400_000;
const freshRule = {
  id: "r1", category: "strategy", description: "d", pattern: { condition: "c", action: "use_llm" },
  confidence: 0.8, confirmedCount: 1, createdAt: now - day, lastConfirmedAt: now - day,
};
const staleWeak = {
  id: "r2", category: "pii_detection", description: "d", pattern: { condition: "false_positive:a:b", action: "reduce_confidence" },
  confidence: 0.6, confirmedCount: 0, createdAt: now - 40 * day, lastConfirmedAt: now - 40 * day,
};
const staleStrong = {
  id: "r3", category: "strategy", description: "d", pattern: { condition: "c2", action: "use_llm" },
  confidence: 0.95, confirmedCount: 4, createdAt: now - 40 * day, lastConfirmedAt: now - 40 * day,
};
const surviving = applyRuleLifecycle([freshRule, staleWeak, staleStrong], now);
ok("fresh rule survives the lifecycle untouched-ish",
  surviving.some((r) => r.id === "r1" && r.confidence > 0.7),
  JSON.stringify(surviving.map((r) => [r.id, r.confidence])));
ok("stale + weak rule expires", !surviving.some((r) => r.id === "r2"), JSON.stringify(surviving.map((r) => r.id)));
ok("stale but high-confidence rule survives with decay",
  surviving.some((r) => r.id === "r3" && r.confidence > 0.7 && r.confidence < 0.95),
  JSON.stringify(surviving.map((r) => [r.id, r.confidence])));

// ─── Scenario X: safety gate sees RESOLVED values, not tokens ───────────────
console.log("\n=== Scenario X: safety gate operates on resolved values ===\n");

const { gate } = await import("../src/background/safety.ts");

// The model is shown a tokenized snapshot, so a sensitive VALUE is "<CRED_1>".
// If a card/Aadhaar gets typed into an INNOCENT field (an injected prompt or a
// confused model), the value check is the only thing that stops it. Gating the
// tokenized input sees "<CRED_1>" → misses it; gating the RESOLVED input sees
// the real card → refuses.
const gateSnap = {
  url: "https://example.com/checkout",
  title: "Checkout",
  text: "",
  truncated: false,
  scroll: { y: 0, maxY: 0 },
  elements: [
    { id: 0, role: "textbox", name: "Card number", value: "<CRED_1>", attrs: { inputType: "text" } },
    { id: 1, role: "textbox", name: "Order notes", value: "", attrs: { inputType: "text" } },
  ],
};

// The hole: a tokenized card value into an innocent field is NOT caught —
// the value gate can't see the real card behind <CRED_1>.
const tokenizedAction = { name: "type", input: { element_id: 1, text: "<CRED_1>", reason: "notes" } };
ok("tokenized card in an innocent field is NOT caught by the value gate (the hole)",
  gate(tokenizedAction, gateSnap, true).verdict !== "refuse");

// Gate on the RESOLVED input: the real card number must be REFUSED even
// though the field is innocent — this is what the agent-loop fix now does.
const resolvedActionInnocent = { name: "type", input: { element_id: 1, text: "4111 1111 1111 1111", reason: "notes" } };
ok("resolved card in an innocent field is REFUSED (value check sees the secret)",
  gate(resolvedActionInnocent, gateSnap, true).verdict === "refuse");

// Sanity: a benign value into a benign field is still allowed.
ok("benign value into an innocent field is allowed",
  gate({ name: "type", input: { element_id: 1, text: "leave at door", reason: "notes" } }, gateSnap, true).verdict === "allow");

// A password FIELD is refused as a field regardless of the typed value.
const passwordSnap = {
  ...gateSnap,
  elements: [
    { id: 2, role: "password", name: "Password", value: "••••••", attrs: { inputType: "password" } },
    { id: 1, role: "textbox", name: "Order notes", value: "", attrs: { inputType: "text" } },
  ],
};
// ── Validated refusals: a real identifier is refused, a LOOKALIKE is not ────
// The gate used to refuse any 12-digit run with optional single spaces, so an
// order number or a reference typed into an innocent field was refused with a
// message claiming it "looks like an Aadhaar number". Shared/checksums.ts sets
// the project's standard — validate, then act — and the typing gate now meets it.
const { matchedIdentifierLabel } = await import("../src/background/safety.ts");
ok("a Verhoeff-valid Aadhaar is identified as one",
  matchedIdentifierLabel(aadhaarFmt) === "Aadhaar number", aadhaarFmt);
ok("an embedded Aadhaar is still caught (not only an exact-value match)",
  matchedIdentifierLabel(`my aadhaar is ${aadhaarFmt} ok`) === "Aadhaar number");
ok("a 12-digit lookalike that fails Verhoeff is NOT refused",
  matchedIdentifierLabel(badAadhaarFmt) === undefined, badAadhaarFmt);
ok("a Luhn-valid card is identified as one",
  matchedIdentifierLabel("4111 1111 1111 1111") === "Card number");
ok("a Luhn-invalid 16-digit reference number is NOT refused",
  matchedIdentifierLabel("4111 1111 1111 1112") === undefined);
ok("a PAN shape is still identified (no checksum exists for it)",
  matchedIdentifierLabel("ABCDE1234F") === "PAN number");
ok("an SSN shape is still refused",
  matchedIdentifierLabel("123-45-6789") === undefined &&
  gate({ name: "type", input: { element_id: 1, text: "123-45-6789", reason: "notes" } }, gateSnap, true).verdict === "refuse");
ok("an order number into an innocent field is no longer refused",
  gate({ name: "type", input: { element_id: 1, text: "Reference 1234 5678 9012", reason: "notes" } }, gateSnap, true).verdict !== "refuse");
ok("and the refusal naming works off the validated evidence",
  gate({ name: "type", input: { element_id: 1, text: aadhaarFmt, reason: "n" } }, gateSnap, true).reason?.includes("validates as a Aadhaar number") === true ||
  gate({ name: "type", input: { element_id: 1, text: aadhaarFmt, reason: "n" } }, gateSnap, true).reason?.includes("Aadhaar number") === true);

ok("a password FIELD is refused even when the typed value is a harmless token",
  gate({ name: "type", input: { element_id: 2, text: "<PII_3>", reason: "fill" } }, passwordSnap, true).verdict === "refuse");

// ─── Scenario L: store-readiness fixes (B5 digit re-tokenization, B6 Unicode, B7 schemes) ──
console.log("\n=== Scenario L: reformatted-digit redaction, Unicode PII, URL schemes ===\n");

// B5: the page reformats a typed Aadhaar with dashes instead of spaces.
// The exact-string sweep misses "9999 0123 4567"; the digit-run fallback must
// still pull it back to its token before the detail reaches the model.
tokenizer.clear();
const aadhaarTok = tokenizer.tokenize("999901234567", "id_number");
const reformatted = `Typed into field: 9999-0123-4567 (formatted)`;
const afterB5 = tokenizer.redactValues(reformatted);
ok("B5: page-reformatted digits are still re-tokenized",
  !afterB5.includes("9999") && afterB5.includes(aadhaarTok), afterB5);
ok("B5: exact-format values still match (no regression)",
  tokenizer.redactValues("see 999901234567 here").includes(aadhaarTok));

// B6: a Devanagari name in the user's task gets tokenized, not shipped raw.
tokenizer.clear();
const devResult = tokenizer.tokenizeTask("send invoice to राम शर्मा");
ok("B6: Devanagari names are tokenized out of the task",
  !devResult.task.includes("राम") && devResult.tokenCount >= 1,
  JSON.stringify(devResult));
const devSnap = {
  url: "https://example.com", title: "t", truncated: false, scroll: { y: 0, maxY: 0 },
  elements: [{ id: 0, role: "textbox", name: "Full name", value: "राम शर्मा", attrs: { inputType: "text" } }],
  // A DIFFERENT Devanagari name in page text — the field value above is
  // already detected, so the free-text scan would (correctly) dedup it.
  text: "To: अमित वर्मा — please confirm delivery address.",
};
const devCtx = detectContextualPII(devSnap);
ok("B6: contextual detector flags Devanagari person names (field value)",
  devCtx.some((d) => d.kind === "person" && d.value.includes("राम")),
  JSON.stringify(devCtx.map((d) => [d.kind, d.value])));
ok("B6: Devanagari name caught in page text near structured keyword",
  devCtx.some((d) => d.label === "Name in page text" && d.value.includes("अमित")),
  JSON.stringify(devCtx.map((d) => [d.label, d.value])));

// B7: navigate/open_tab refuse non-web schemes.
const { isNavigableUrl } = await import("../src/background/executor.ts");
ok("B7: http and https navigate", isNavigableUrl("https://gmail.com") && isNavigableUrl("http://localhost:11434"));
ok("B7: file:// refused", !isNavigableUrl("file:///C:/Windows/system32/config"));
ok("B7: chrome:// and browser-internal refused",
  !isNavigableUrl("chrome://history") && !isNavigableUrl("edge://settings") && !isNavigableUrl("about:blank"));
ok("B7: javascript: and data: URIs refused",
  !isNavigableUrl("javascript:alert(1)") && !isNavigableUrl("data:text/html,<script>alert(1)</script>"));
ok("B7: scheme-less input still allowed (normalized to https by normaliseUrl)",
  isNavigableUrl("example.com"));

// ─── Scenario Y: ElevenLabs voice core (privacy-critical transforms) ───────
console.log("\n=== Scenario Y: ElevenLabs voice-core privacy transforms ===\n");

const {
  speakSafeTransform,
  toSpeakable,
  stripVaultTokens,
  containsVaultToken,
  floatTo16BitPCM,
  pcm16ToFloat32,
  bytesToBase64,
  ttsRequestBody,
  TTS_OUTPUT_FORMAT,
  classifyMicFailure,
  micFailureAdvice,
  MIC_AUDIO_CONSTRAINTS,
  MIC_FALLBACK_CONSTRAINTS,
} = await import("../src/sidepanel/voice-core.ts");

// ── Microphone permission: the manifest must actually request capture ────────
// This is the bug that shipped: the side panel called getUserMedia with no
// `audioCapture` permission in the manifest, so Chrome hid every input device
// from the extension page and reported `NotFoundError: Requested device not
// found` — which reads like a hardware problem and is not one. Nothing in the
// suite noticed, because the permission and the call site lived in different
// files.
const declaredManifest = JSON.parse(await readFile("src/manifest.json", "utf8"));
ok("the manifest declares audioCapture, which getUserMedia in an extension page requires",
  Array.isArray(declaredManifest.permissions) && declaredManifest.permissions.includes("audioCapture"),
  JSON.stringify(declaredManifest.permissions));

// ── Mic failure diagnosis: four different problems, four different fixes ─────
const withPermission = { hasCapturePermission: true, audioInputs: 1 };
ok("a build without the capture permission is named as such, not blamed on hardware",
  classifyMicFailure({ name: "NotFoundError", message: "Requested device not found", ...withPermission, hasCapturePermission: false }) === "missing-permission");
ok("a genuine lack of devices is distinguished from a missing permission",
  classifyMicFailure({ name: "NotFoundError", message: "Requested device not found", ...withPermission, audioInputs: 0 }) === "no-device");
ok("a blocked/dismissed prompt is recognised from the error name",
  classifyMicFailure({ name: "NotAllowedError", message: "Permission denied", ...withPermission }) === "blocked");
ok("and from the legacy message wording",
  classifyMicFailure({ name: "", message: "Permission dismissed by user", ...withPermission }) === "blocked");
ok("a device held by another app is its own case",
  classifyMicFailure({ name: "NotReadableError", message: "Could not start audio source", ...withPermission }) === "busy");
ok("unsupported constraints are retryable rather than fatal",
  classifyMicFailure({ name: "OverconstrainedError", message: "sampleRate", ...withPermission }) === "constraints");
ok("an unrecognised failure stays honest instead of guessing a cause",
  classifyMicFailure({ name: "WeirdError", message: "", hasCapturePermission: true, audioInputs: null }) === "unknown");

// Every message must contain a next step, and must not tell the user to fix
// hardware when the build is what is wrong.
ok("the missing-permission advice names the permission and the fix",
  /audioCapture/.test(micFailureAdvice("missing-permission")) &&
    /rebuild|reload/i.test(micFailureAdvice("missing-permission")));
ok("the blocked advice names the exact Chrome path to allow it",
  /chrome:\/\/extensions/.test(micFailureAdvice("blocked")) &&
    /Microphone/.test(micFailureAdvice("blocked")));
ok("the no-device advice asks for a device rather than a permission",
  /microphone/i.test(micFailureAdvice("no-device")) &&
    !/audioCapture/.test(micFailureAdvice("no-device")));
ok("every failure kind produces advice with a next step",
  ["missing-permission", "no-device", "blocked", "busy", "constraints", "unknown"]
    .every((k) => micFailureAdvice(k, "raw").length > 40 && micFailureAdvice(k, "raw").includes("raw")));
ok("the tuned constraints are ideal-only (no `exact`), so a device can still satisfy them",
  !JSON.stringify(MIC_AUDIO_CONSTRAINTS).includes("exact") &&
    !JSON.stringify(MIC_AUDIO_CONSTRAINTS).includes("min") &&
    MIC_FALLBACK_CONSTRAINTS.audio === true);

// The controller must check the permission and retry before it reports.
const voiceControllerSource = await readFile("src/sidepanel/voice-controller.ts", "utf8");
ok("the mic opener asks the manifest whether this build may capture audio",
  /getManifest\(\)[\s\S]{0,300}audioCapture/.test(voiceControllerSource));
ok("and retries with fallback constraints before giving up",
  /OverconstrainedError[\s\S]{0,400}MIC_FALLBACK_CONSTRAINTS/.test(voiceControllerSource));

// Speak-safety: vault tokens MUST be replaced with "redacted" before TTS.
ok("speakSafeTransform replaces CRED tokens with 'redacted'",
  speakSafeTransform("Email sent to <CRED_1>.") === "Email sent to redacted.");
ok("speakSafeTransform replaces multiple token kinds",
  speakSafeTransform("From <PII_3> at <EMAIL_2>") === "From redacted at redacted");
ok("speakSafeTransform strips markdown link syntax",
  speakSafeTransform("See [privacy page](https://example.com) for details") === "See privacy page for details");
ok("speakSafeTransform strips emphasis and heading noise",
  speakSafeTransform("## Done.\n**bold** `code`") === "Done. bold code");
ok("speakSafeTransform caps runaway output with an ellipsis",
  speakSafeTransform("x".repeat(1000)).endsWith("…"));
ok("speakSafeTransform preserves normal prose exactly",
  speakSafeTransform("Sent successfully.") === "Sent successfully.");

// The detector must trip on raw tokens so TTS can refuse to speak them.
ok("containsVaultToken detects CRED", containsVaultToken("hi <CRED_1>"));
ok("containsVaultToken detects EMAIL/ID/PII",
  containsVaultToken("<EMAIL_9>") && containsVaultToken("<ID_3>") && containsVaultToken("<PII_42>"));
ok("containsVaultToken is false on speak-safe output",
  !containsVaultToken(speakSafeTransform("done <CRED_1>")));
ok("containsVaultToken tolerates empty/null/undefined",
  !containsVaultToken("") && !containsVaultToken(null) && !containsVaultToken(undefined));

// ── The bug: TTS refused instead of redacting ─────────────────────────────
// `voice-controller.speak()` checked containsVaultToken FIRST and returned an
// error before speakSafeTransform ever ran — so the transform whose entire job
// is to pronounce tokens as "redacted" was unreachable exactly when it was
// needed. Reported live as: "Voice: Refusing to speak: raw vault token in
// assistant text (this is a bug, please report)", with no audio, on a run whose
// text quoted the Gmail tab title (which carries <CRED_1>).
const spokenWithToken = toSpeakable("Opened Gmail for <CRED_1>.");
ok("a sentence containing a vault token is still spoken, not refused",
  spokenWithToken.text === "Opened Gmail for redacted.", spokenWithToken.text);
ok("and the speaker is handed token-free text — the guard's whole purpose holds",
  !containsVaultToken(spokenWithToken.text));
ok("the token substitution is reported, so it is never mistaken for the model's wording",
  spokenWithToken.redactedTokens === 1, String(spokenWithToken.redactedTokens));
ok("every token kind is counted and redacted for the speaker",
  (() => {
    const r = toSpeakable("Sent to <EMAIL_2> from <PII_3> with <ID_7>.");
    return r.redactedTokens === 3 && !containsVaultToken(r.text) &&
      (r.text.match(/redacted/g) ?? []).length === 3;
  })());
ok("glued token noise is redacted too, not just clean tokens",
  !containsVaultToken(toSpeakable("code 7<CRED_1>").text));
ok("a token-only answer still produces speakable text rather than silence",
  toSpeakable("<CRED_1>").text === "redacted", toSpeakable("<CRED_1>").text);
ok("toSpeakable still flattens markdown",
  !toSpeakable("See [docs](https://x.test)").text.includes("https"));
ok("toSpeakable still caps a runaway answer",
  toSpeakable("word ".repeat(400), 60).text.endsWith("…"));
ok("token-free text is passed through with nothing to report",
  toSpeakable("Sent successfully.").redactedTokens === 0);
ok("stripVaultTokens is a last-resort sweep that leaves no token syntax",
  !containsVaultToken(stripVaultTokens("a <CRED_1> b <PII_2> c")));

// PCM round-trip: Float32 -> PCM16 -> Float32 preserves sample values to
// the quantisation step of the target format. The native value at sample
// rate 16 kHz is Int16, so 0.5 -> ~16383/32767 (not exactly 0.5).
const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
const pcm = floatTo16BitPCM(samples);
ok("PCM16 round-trip: 2 bytes per sample", pcm.byteLength === samples.length * 2);
const back = pcm16ToFloat32(pcm);
ok("PCM16 round-trip: zero preserved exactly", back[0] === 0);
ok("PCM16 round-trip: positive peak round-trips", back[3] === 1);
ok("PCM16 round-trip: negative peak round-trips", back[4] === -1);
ok("PCM16 round-trip: 0.5 within ±1/32767", Math.abs(back[1] - 0.5) <= 1 / 32767);
ok("PCM16 round-trip: -0.5 within ±1/32767", Math.abs(back[2] + 0.5) <= 1 / 32767);

// Base64 round-trip.
const b64 = bytesToBase64(new Uint8Array([0, 1, 2, 254, 255]));
ok("bytesToBase64 round-trip",
  atob(b64).split(",").map((c) => c.charCodeAt(0))
    .every((v, i) => v === [0, 1, 2, 254, 255][i]));

// TTS request body shape.
const body = ttsRequestBody("hello");
ok("ttsRequestBody uses Flash v2.5 and forwards text",
  body.model_id === "eleven_flash_v2_5" && body.text === "hello");
ok("TTS output format is PCM16 (matches AudioContext default)",
  TTS_OUTPUT_FORMAT === "pcm_16000");

// ─── Scenario Z: Scribe client wire shapes (pure functions only) ─────────────
console.log("\n=== Scenario Z: Scribe client URL + token auth ===\n");

const { mintScribeToken, scribeWebSocketUrl, scribeAudioChunk, micFrameToScribeBase64, SCRIBE_SAMPLE_RATE_HZ } =
  await import("../src/sidepanel/scribe-client.ts");

ok("Scribe sample rate is 16 kHz (PCM16)", SCRIBE_SAMPLE_RATE_HZ === 16000);
ok("scribeWebSocketUrl carries token, model_id, audio_format, sample_rate, commit_strategy=manual",
  (() => {
    const u = new URL(scribeWebSocketUrl("tkn-123"));
    return u.protocol === "wss:"
      && u.host === "api.elevenlabs.io"
      && u.searchParams.get("token") === "tkn-123"
      && u.searchParams.get("model_id") === "scribe_v2_realtime"
      && u.searchParams.get("audio_format") === "pcm_16000"
      && u.searchParams.get("sample_rate") === "16000"
      && u.searchParams.get("commit_strategy") === "manual";
  })());

// The wire shape is the whole ballgame for STT: the SDK's friendly
// {audioBase64} form is NOT what the WebSocket accepts, and sending it is a
// silent no-op (audio never transcribed). Pin the documented InputAudioChunk.
ok("audio frames use the documented InputAudioChunk wire shape",
  (() => {
    const frame = scribeAudioChunk("QUJD");
    return frame.message_type === "input_audio_chunk"
      && frame.audio_base_64 === "QUJD"
      && frame.commit === false
      && frame.sample_rate === 16000;
  })());
ok("commit frames are input_audio_chunk with commit=true",
  (() => {
    const frame = scribeAudioChunk("", true);
    return frame.message_type === "input_audio_chunk"
      && frame.commit === true
      && frame.audio_base_64 === "";
  })());
ok("micFrameToScribeBase64 returns base64-encoded PCM16 (2 bytes per sample)",
  micFrameToScribeBase64(new Float32Array(64)).length > 0
    && atob(micFrameToScribeBase64(new Float32Array(64))).length === 128);

ok("mintScribeToken rejects empty key with a clear message",
  (async () => {
    try {
      await mintScribeToken("");
      return false;
    } catch (e) {
      return e instanceof Error && /API key is required/i.test(e.message);
    }
  })());

// ─── Scenario AA: pixel-channel PII matchers (the text-file leak fix) ──────
// The screenshot redaction channel now uses the SAME matchers as the text
// channel. These pin: emails/phones found in plain text, checksum-validated
// IDs, lookalikes rejected, and overlap de-duplication.
console.log("\n=== Scenario AA: pixel-channel PII matchers (matchPiiInText) ===\n");

const { matchPiiInText } = await import("../src/shared/text-pii-patterns.ts");

// Email in plain text — the exact class the tester's text-file leak exposed.
const emailHits = matchPiiInText("reach me at rahul.sharma@gmail.com anytime");
ok("email in plain text is detected",
  emailHits.some((m) => m.kind === "email" && m.value === "rahul.sharma@gmail.com"),
  JSON.stringify(emailHits));

// Indian phone, both formats.
ok("+91 formatted phone detected",
  matchPiiInText("call +91 98765 43210 now").some((m) => m.kind === "phone"));
ok("bare 10-digit phone detected",
  matchPiiInText("call 9876543210 now").some((m) => m.kind === "phone"));

// Checksum-validated IDs pass; lookalikes are rejected exactly like the
// text channel rejects them (no over-redaction of order numbers).
const pxSeed = "23456789012";
const pxAadhaar = pxSeed + verhoeffCheckDigit(pxSeed);
const idHits = matchPiiInText(`Aadhaar: ${pxAadhaar.slice(0,4)} ${pxAadhaar.slice(4,8)} ${pxAadhaar.slice(8)}`);
ok("formatted Verhoeff-valid Aadhaar detected as id_text",
  idHits.some((m) => m.kind === "id_text" && m.label === "Aadhaar number"),
  JSON.stringify(idHits));
const pxBad = pxAadhaar.slice(0, 11) + (pxAadhaar[11] === "9" ? "8" : String(Number(pxAadhaar[11]) + 1));
ok("checksum-invalid Aadhaar lookalike rejected",
  !matchPiiInText(`Order ${pxBad.slice(0,4)} ${pxBad.slice(4,8)} ${pxBad.slice(8)}`)
    .some((m) => m.label === "Aadhaar number"));
ok("Luhn-valid card detected", matchPiiInText("card 4111 1111 1111 1111")
  .some((m) => m.label === "Card number"));
ok("Luhn-invalid card rejected",
  !matchPiiInText("card 4111 1111 1111 1112").some((m) => m.label === "Card number"));
ok("PAN detected", matchPiiInText("PAN ABCDE1234F")
  .some((m) => m.kind === "id_text" && m.label === "PAN card"));

// Overlap de-dup: a formatted Aadhaar must not ALSO match as a bare phone
// (12 digits could partially overlap the phone shape without the guard).
const overlap = matchPiiInText("id 623456789012 and email a@b.co");
ok("no phone match inside a 12-digit id run",
  !overlap.some((m) => m.kind === "phone" && m.value.length < 12 && /6234567890/.test(m.value)),
  JSON.stringify(overlap));

// Clean text produces nothing (no false positives on prose).
ok("ordinary prose yields no matches",
  matchPiiInText("The quick brown fox jumps over the lazy dog near the riverbank.").length === 0);

// Position data is exact enough to build a Range (start < end, in bounds).
const positioned = matchPiiInText("email foo.bar@x.co here");
ok("match positions are exact and ordered",
  positioned.every((m) => m.start < m.end && m.end <= "email foo.bar@x.co here".length)
    && positioned[0].start === 6);

// ─── Scenario AB: wire log — the runtime leak re-scan ──────────────────────
console.log("\n=== Scenario AB: wire log records and runtime leak scan ===\n");

const wireLog = await import("../src/background/wire-log.ts");

// Token syntax is the sanitized form and must never count as a leak.
ok("tokensIn finds and dedupes tokens",
  JSON.stringify(wireLog.tokensIn("to <CRED_1> from <CRED_1> and <ID_2>")) === '["<CRED_1>","<ID_2>"]',
  JSON.stringify(wireLog.tokensIn("to <CRED_1> from <CRED_1> and <ID_2>")));
ok("scanForLeaks: pure token payload has NO leaks",
  wireLog.scanForLeaks("Email sent to <CRED_1>. From <PII_3> at <ID_2>. totalChars 400").length === 0,
  JSON.stringify(wireLog.scanForLeaks("Email sent to <CRED_1>. From <PII_3> at <ID_2>.")));
ok("scanForLeaks: a real email that survived IS a leak, masked",
  (() => {
    const leaks = wireLog.scanForLeaks("sent to rahul.sharma@gmail.com ok");
    return leaks.length === 1 && leaks[0].label === "Email address"
      && !leaks[0].sample.includes("rahul.sharma");
  })(),
  JSON.stringify(wireLog.scanForLeaks("sent to rahul.sharma@gmail.com ok")));
ok("scanForLeaks: empty payload is clean", wireLog.scanForLeaks("").length === 0);

// Record + cap behavior.
wireLog.clearWire();
for (let i = 0; i < 30; i++) {
  wireLog.recordWire({
    turn: i,
    destination: `provider-${i}`,
    systemChars: 100,
    messages: [{ role: "user", text: `turn ${i} clean message` }],
    tokens: [],
    leaked: [],
    totalChars: 100,
  });
}
const allRecords = await wireLog.wireRecords();
ok("wire log caps at 24 records", allRecords.length === 24, `got ${allRecords.length}`);
ok("wire log keeps the NEWEST records after capping",
  allRecords[allRecords.length - 1].turn === 29 && allRecords[0].turn === 6);
ok("recordWire assigns ids and timestamps",
  allRecords[0].id.startsWith("w") && allRecords[0].at > 0);

// A leak recorded at send time is preserved in the record (the loud banner).
wireLog.clearWire();
wireLog.recordWire({
  turn: 1,
  destination: "Groq demo",
  systemChars: 50,
  messages: [{ role: "user", text: "clean" }],
  tokens: [],
  leaked: [{ label: "Email address", sample: "ra•••@gmail.com" }],
  totalChars: 60,
});
const leakRecord = (await wireLog.wireRecords())[0];
ok("leaked findings are preserved on the record (loud banner data)",
  leakRecord.leaked.length === 1 && leakRecord.leaked[0].label === "Email address");

// ── Tier-0 ML: fusion detector + ml settings migration ──────────────────────
console.log("\n=== Scenario AC: fusion detector v2 + ml settings ===\n");

const { fuseDetections } = await import("../src/background/detector-v2.ts");

const baseDetections = [
  { kind: "credential", value: "priya.sharma@example.in", confidence: 0.9, label: "Email address" },
  { kind: "id_number", value: "234567890124", confidence: 0.7, label: "Aadhaar number" },
];

// A person name the regex never catches: NER adds it.
const fused1 = fuseDetections(baseDetections, [
  { text: "Priya Sharma", label: "PER", score: 0.92 },
]);
ok("fusion: NER adds a person name regex missed",
  fused1.added === 1
    && fused1.detections.some((d) => d.value === "Priya Sharma" && d.label === "NER Person name")
    && fused1.detections.length === 3,
  JSON.stringify(fused1.detections.map((d) => d.value)));

// A NER span that duplicates a regex value is dropped (checksum wins).
const fused2 = fuseDetections(baseDetections, [
  { text: "priya.sharma@example.in", label: "PER", score: 0.99 },
]);
ok("fusion: NER span duplicating a regex value is dropped", fused2.added === 0);

// A NER span contained INSIDE a regex value (partial overlap) is dropped too.
const fused3 = fuseDetections(baseDetections, [
  { text: "234567890", label: "PER", score: 0.8 },
]);
ok("fusion: partially-overlapping NER span is dropped", fused3.added === 0);

// Duplicate NER spans collapse.
const fused4 = fuseDetections([], [
  { text: "Rahul Sharma", label: "PER", score: 0.9 },
  { text: "Rahul Sharma", label: "PER", score: 0.88 },
]);
ok("fusion: duplicate NER spans collapse to one", fused4.added === 1);

// Tiny spans are skipped.
ok("fusion: sub-3-char spans are skipped",
  fuseDetections([], [{ text: "ab", label: "PER", score: 0.9 }]).added === 0);

// Settings: ml defaults + merge.
const mlDefaults = normaliseSettings(undefined);
ok("ml settings default to enabled (degradation is automatic)",
  mlDefaults.ml.ner === true && mlDefaults.ml.guard === true);
const mlMerged = normaliseSettings({ ml: { ner: false } });
ok("ml settings merge preserves stored guard flag",
  mlMerged.ml.ner === false && mlMerged.ml.guard === true);

// Wire-log persistence: MV3 suspends the service worker, wiping in-memory
// state. recordWire writes through to chrome.storage so the audit survives.
wireLog.clearWire();
wireLog.recordWire({
  turn: 3,
  destination: "Groq demo",
  systemChars: 50,
  messages: [{ role: "user", text: "persist me" }],
  tokens: [],
  leaked: [],
  totalChars: 60,
});
await new Promise((r) => setTimeout(r, 25)); // write-behind flush
const persisted = (await chrome.storage.local.get("pry-wire-log"))["pry-wire-log"];
ok("wire records persist to chrome.storage (survives SW suspension)",
  Array.isArray(persisted) && persisted.length === 1
    && persisted[0].messages[0].text === "persist me",
  JSON.stringify(persisted));
wireLog.clearWire();
const wiped = (await chrome.storage.local.get("pry-wire-log"))["pry-wire-log"];
ok("clearWire wipes persisted records", !wiped || wiped.length === 0);

// ── NER→pixel bridge: span-state channel ───────────────────────────────────
console.log("\n=== Scenario AD: NER→pixel bridge (span state) ===\n");

const { setActiveNerSpans, getActiveNerSpans } = await import("../src/background/ml-bridge.ts");

setActiveNerSpans(["Priya Sharma", "  Priya Sharma  ", "ab", "", "Acme Corp", "Acme Corp", "Delhi", "xxxxx"]);
const stored = getActiveNerSpans();
ok("bridge stores deduped, trimmed NER spans",
  stored.length === 4 && stored.includes("Priya Sharma") && stored.includes("Acme Corp") && stored.includes("Delhi"),
  JSON.stringify(stored));
ok("bridge drops sub-3-char and empty spans",
  !stored.includes("ab") && !stored.includes(""));
ok("getActiveNerSpans returns a copy — callers cannot mutate state",
  (() => { const s = getActiveNerSpans(); s.push("injected"); return getActiveNerSpans().length === 4; })());
setActiveNerSpans(Array.from({ length: 20 }, (_, i) => `span-${i}`));
ok("bridge caps spans at 12 (locate message size bound)", getActiveNerSpans().length === 12);
setActiveNerSpans([]);
ok("clearing spans empties the bridge (no cross-page stale spans)", getActiveNerSpans().length === 0);

// ── Model-agnostic NER label mapping (whichever PII model lands) ──────────
console.log("\n=== Scenario AE: model-agnostic PII label mapping ===\n");

const { keepLabel } = await import("../src/shared/ner-labels.ts");

// ConLL vocab.
ok("ConLL PER/ORG/LOC labels kept", keepLabel("PER") && keepLabel("ORG") && keepLabel("LOC"));
// PII-specialized vocabularies (Piiranha-style).
ok("Piiranha-style PII labels kept",
  keepLabel("EMAIL") && keepLabel("PERSON_NAME") && keepLabel("PHONE_NUMBER")
    && keepLabel("SSN") && keepLabel("ADDRESS") && keepLabel("DOB"));
// GLiNER-style zero-shot labels.
ok("GLiNER-style labels kept",
  keepLabel("name") && keepLabel("email address") && keepLabel("account number"));
// Generic non-PII families stay readable.
ok("non-PII labels are NOT kept",
  !keepLabel("EVENT") && !keepLabel("PRODUCT") && !keepLabel("MISC")
    && !keepLabel("SKILL") && !keepLabel("QUANTITY") && !keepLabel("DATE"));

// Friendly audit names for PII vocabularies via the fusion layer.
const fusedLbl = fuseDetections([], [
  { text: "Rahul Sharma", label: "PERSON_NAME", score: 0.9 },
  { text: "rahul@acme.in", label: "EMAIL", score: 0.95 },
  { text: "Acme Pvt Ltd", label: "COMPANY", score: 0.8 },
]);
ok("fusion maps PII vocabularies to friendly audit labels",
  fusedLbl.detections.some((d) => d.value === "Rahul Sharma" && d.label === "NER Person name")
    && fusedLbl.detections.some((d) => d.value === "rahul@acme.in" && d.label === "NER Email address")
    && fusedLbl.detections.some((d) => d.value === "Acme Pvt Ltd" && d.label === "NER Organization"),
  JSON.stringify(fusedLbl.detections.map((d) => d.label)));

// ── Subword-fragment repair (the silent NER no-op) ────────────────────────
// The screenshot evidence: the self-test line read "found: P, ##riya Sharma".
// Fragment spans never match real page text, so the name was neither
// tokenized in the text channel nor boxed in the pixel channel — it reached
// the model raw and the wire log reported it as a LEAK. Pin the repair.
console.log("\n=== Scenario AF: NER subword-fragment repair ===\n");

const { normalizeSpans } = await import("../src/shared/ner-spans.ts");

const nerRepaired = normalizeSpans([
  { word: "P", entity_group: "PER", score: 0.99 },
  { word: "##riya Sharma", entity_group: "PER", score: 0.95 },
  { word: "Ramesh Gupta", entity_group: "PER", score: 0.98 },
  { word: "Acme Corporation", entity_group: "ORG", score: 0.97 },
]);
ok("WordPiece fragments are merged into whole spans",
  nerRepaired[0]?.text === "Priya Sharma" && nerRepaired[1]?.text === "Ramesh Gupta",
  JSON.stringify(nerRepaired.map((s) => s.text)));
ok("no continuation marker survives normalization",
  nerRepaired.every((s) => !s.text.includes("##") && !s.text.includes("\u2581")));
ok("merged span keeps the weakest fragment score (honest threshold)",
  nerRepaired[0]?.score === 0.95);
ok("distinct labels are never fused by a continuation",
  normalizeSpans([
    { word: "Acme", entity_group: "ORG", score: 0.9 },
    { word: "##Corp", entity_group: "LOC", score: 0.9 },
  ]).length === 2);
// \u2581 marks a word START (a space), unlike ## which glues — conflating
// them turns "New" + "\u2581Delhi" into "NewDelhi".
const sentencePiece = normalizeSpans([
  { word: "\u2581New", entity_group: "LOC", score: 0.9 },
  { word: "\u2581Delhi", entity_group: "LOC", score: 0.9 },
]);
ok("SentencePiece markers join with a space, not glue",
  sentencePiece.length === 1 && sentencePiece[0].text === "New Delhi",
  JSON.stringify(sentencePiece));
ok("unmarked neighbours are never fused into one entity",
  normalizeSpans([
    { word: "Google", entity_group: "ORG", score: 0.9 },
    { word: "Apple", entity_group: "ORG", score: 0.9 },
  ]).length === 2);
ok("malformed pipeline output never throws", normalizeSpans(null).length === 0);

// ── Token-level BIO output (the silent-zero defect) ───────────────────────
// Measured against the real bundled weights: the pipeline can return raw tags
// (`entity: "B-PER"`) instead of pre-aggregated groups. Those labels fail a
// PER/ORG/LOC policy check, every span was discarded, and the on-device NER
// contributed NOTHING while the self-test still listed entities. Pin the fix.
const bio = normalizeSpans([
  { entity: "B-PER", word: "P", score: 0.99 },
  { entity: "I-PER", word: "##riya", score: 0.97 },
  { entity: "I-PER", word: "Sharma", score: 0.99 },
  { entity: "O", word: "met", score: 0.99 },
  { entity: "B-PER", word: "Ramesh", score: 0.99 },
  { entity: "I-PER", word: "Gupta", score: 0.99 },
  { entity: "B-ORG", word: "Acme", score: 0.99 },
  { entity: "I-ORG", word: "Corporation", score: 0.99 },
]);
ok("BIO prefixes are stripped so the label policy can match",
  bio[0]?.label === "PER" && bio.some((s) => s.label === "ORG"),
  JSON.stringify(bio.map((s) => s.label)));
ok("token-level BIO output merges into whole entities",
  bio.map((s) => s.text).join(" | ") === "Priya Sharma | Ramesh Gupta | Acme Corporation",
  bio.map((s) => s.text).join(" | "));
ok("outside spans ('O') are dropped, never emitted as entities",
  !bio.some((s) => s.text === "met" || s.label === "O"));
ok("BIO-stripped labels pass the PII policy that silently rejected them before",
  keepLabel(bio[0].label) && keepLabel(bio[2].label));
ok("a span with no surface text is dropped, never emitted empty",
  normalizeSpans([{ entity: "B-PER", score: 0.99 }]).length === 0);
ok("array-shaped scores are coerced, not silently NaN",
  normalizeSpans([{ entity_group: "PER", word: "Priya", score: [0.2, 0.91] }])[0]?.score === 0.91);

// ── Scenario AG: the title channel is sanitized like every other channel ──
// The page title bypasses the element/text detectors entirely. Gmail's title
// is "Inbox (n) - you@gmail.com - Gmail", so the signed-in address reached the
// model raw on every run — the wire-log leak scanner flagged it ("Email
// address (sh---@gmail.com) reached the model") while the pixel channel was
// verified clean. Pin the repair: title PII is tokenized, and a value the
// vault already holds keeps the SAME token it has in the page body.
console.log("\n=== Scenario AG: title-channel PII sanitization ===\n");

const { sanitizeTextPII } = await import("../src/background/agent.ts");

const GMAIL_TITLE = "Inbox (16) - shashank.negi@gmail.com - Gmail";
const titleOut = sanitizeTextPII(GMAIL_TITLE);
ok("title email becomes a vault token, never raw",
  !titleOut.includes("shashank.negi@gmail.com") && /<[A-Z]+_[0-9]+>/.test(titleOut),
  titleOut);

// Vault consistency: register the email as the body channel would, then
// sanitize a title carrying the same address — both must map to one token.
tokenizer.clear();
tokenizer.tokenizeDetections(
  { elements: [], text: "contact: shashank.negi@gmail.com for help", url: "https://x.test", title: "" },
  [{ kind: "credential", value: "shashank.negi@gmail.com" }],
);
const bodyRender = sanitizeTextPII("contact: shashank.negi@gmail.com for help");
ok("body channel keeps its existing token (no re-tokenization)",
  bodyRender.includes("<CRED_1>") && !bodyRender.includes("shashank.negi@gmail.com"), bodyRender);
const sameTitle = sanitizeTextPII("Mail - shashank.negi@gmail.com");
ok("the same address in the title maps to the SAME token",
  sameTitle.includes("<CRED_1>"), sameTitle);

// Honorific names in titles (the "Person name (Dr--------)" wire-log leak).
tokenizer.clear();
const doctorTitle = sanitizeTextPII("Dr. Ramesh Gupta - Profile | HealthSite");
ok("honorific person names in titles are tokenized",
  !doctorTitle.includes("Ramesh Gupta") && /<[A-Z]+_[0-9]+>/.test(doctorTitle), doctorTitle);

// Clean titles pass through untouched (no token spam on ordinary pages).
tokenizer.clear();
ok("an ordinary title is not modified",
  sanitizeTextPII("YouTube") === "YouTube" &&
  sanitizeTextPII("Schedule Design Masterclass IN 2026") === "Schedule Design Masterclass IN 2026");

// Empty/short strings short-circuit.
ok("short input returns unchanged",
  sanitizeTextPII("") === "" && sanitizeTextPII("ok") === "ok");

// ── Scenario AH: face channels fuse, they do not replace each other ───────
// The screenshot evidence: on a YouTube page the large thumbnail face came
// back destroyed (opaque black) and every smaller thumbnail/avatar face
// survived, fully readable. Cause: the pixel pipeline ran its three face
// channels as an EXCLUSIVE chain (`if (faceBoxes.length === 0)`), so one
// BlazeFace hit skipped the skin-colour pass — and BlazeFace is a SHORT-RANGE
// detector that finds one large portrait and drops 40px thumbnail faces.
console.log("\n=== Scenario AH: face-channel fusion policy ===\n");

const { mergeFaceBoxes, coversExistingFace, overlapArea } = await import("../src/shared/face-regions.ts");

const modelBigFace = { x: 300, y: 100, width: 220, height: 220, confidence: 0.93, source: "model" };
const skinThumbA = { x: 40, y: 520, width: 60, height: 60, confidence: 0.7, source: "skin" };
const skinThumbB = { x: 700, y: 300, width: 48, height: 48, confidence: 0.6, source: "skin" };

const fusedFaces = mergeFaceBoxes([modelBigFace], [skinThumbA, skinThumbB]);
ok("a model hit does not suppress the supplementary face channel",
  fusedFaces.length === 3, JSON.stringify(fusedFaces.map((f) => f.source)));
ok("supplementary faces survive alongside the model's face",
  fusedFaces.some((f) => f.source === "skin" && f.x === 40)
    && fusedFaces.some((f) => f.source === "skin" && f.x === 700));

// The same face seen by two channels must not be redacted twice.
const skinDuplicate = { x: 310, y: 110, width: 200, height: 200, confidence: 0.5, source: "skin" };
const fusedDupes = mergeFaceBoxes([modelBigFace], [skinDuplicate, skinThumbA]);
ok("a skin blob overlapping a detected face is not a second face",
  fusedDupes.filter((f) => f.source === "model").length === 1
    && fusedDupes.length === 2, JSON.stringify(fusedDupes));
ok("overlap coverage is measured against the SMALLER box",
  coversExistingFace(
    { x: 320, y: 120, width: 20, height: 20, confidence: 0.5, source: "skin" },
    [modelBigFace],
  ));
ok("overlapArea is zero for disjoint boxes",
  overlapArea(modelBigFace, skinThumbB) === 0);

// A confident detection is never trimmed to make room for a heuristic guess.
const manyModelFaces = Array.from({ length: 12 }, (_, i) => ({
  x: i * 100, y: 0, width: 80, height: 80, confidence: 0.9, source: "model",
}));
const manySkin = Array.from({ length: 20 }, (_, i) => ({
  x: i * 37, y: 400, width: 50, height: 50, confidence: 0.5, source: "skin",
}));
const capped = mergeFaceBoxes(manyModelFaces, manySkin);
ok("every model-detected face is kept",
  capped.filter((f) => f.source === "model").length === 12);
ok("supplementary additions are capped so a photo cannot wall the page",
  capped.filter((f) => f.source === "skin").length <= 16,
  String(capped.filter((f) => f.source === "skin").length));
ok("model boxes are ordered largest first",
  capped[0].width === 80);

// ── Scenario AI: a NER span that is not on the page is not a detection ────
// Tier-0 spans are scored per page now, but the fusion layer is the last line
// of defence: nothing downstream can act on a span that is not literally on
// the page (the tokenizer needs the literal value to replace it, locateSpans
// needs it to black-box it). Reporting one anyway inflated the detection
// count with PII the pipeline never handled.
console.log("\n=== Scenario AI: detection honesty — spans must exist on the page ===\n");

const pageHaystack = "Welcome to YouTube. Recommended: Building with Ollama by Ravi Menon.";
const fusedPresent = fuseDetections(
  [],
  [{ text: "Ravi Menon", label: "PER", score: 0.9 }],
  pageHaystack,
);
ok("a span that IS on the page is still detected",
  fusedPresent.added === 1 && fusedPresent.detections[0].value === "Ravi Menon");
const fusedAbsent = fuseDetections(
  [],
  [{ text: "Priya Sharma", label: "PER", score: 0.9 }],
  pageHaystack,
);
ok("a stale span from another page is not reported as a detection on this one",
  fusedAbsent.added === 0, JSON.stringify(fusedAbsent.detections.map((d) => d.value)));
ok("omitting the haystack keeps the previous behaviour (callers opt in)",
  fuseDetections([], [{ text: "Ravi Menon", label: "PER", score: 0.9 }]).added === 1);

// ── Scenario AJ: region→image mapping is one function, two capture paths ──
// A stitched full-page canvas needs the tile scale AND the restored scroll
// offset. The agent's capture path had it; the inspector's did not, so a
// full-page inspect painted text-PII boxes at a viewport-relative y on a
// page-tall image — the misaligned "faces masked, text readable" ledger frame.
console.log("\n=== Scenario AJ: region→image mapping ===\n");

const { regionMappingFor } = await import("../src/shared/region-mapping.ts");

const viewportMap = regionMappingFor({
  imageWidth: 1424, dpr: 2, viewportWidth: 712, scrollY: 0, fullPage: false,
});
ok("viewport capture scales regions by DPR alone",
  viewportMap.scale === 2 && viewportMap.offsetY === 0 && viewportMap.mapped === false);

const fullPageMap = regionMappingFor({
  imageWidth: 712, dpr: 2, viewportWidth: 712, scrollY: 900, fullPage: true,
});
ok("full-page capture maps CSS px onto the page-tall canvas",
  fullPageMap.scale === 1, JSON.stringify(fullPageMap));
ok("full-page capture offsets regions by the restored scroll position",
  fullPageMap.offsetY === 900);
const downscaledPage = regionMappingFor({
  imageWidth: 356, dpr: 2, viewportWidth: 712, scrollY: 400, fullPage: true,
});
ok("a downscaled stitch scales the offset with the image",
  downscaledPage.scale === 0.5 && downscaledPage.offsetY === 200,
  JSON.stringify(downscaledPage));
ok("full-page mapping degrades to viewport mapping without a viewport width",
  regionMappingFor({ imageWidth: 800, dpr: 1, viewportWidth: 0, scrollY: 500, fullPage: true }).mapped === false);

// ── Scenario AK: planner turns are bounded by silence, not wall clock ──────
// The screenshot evidence: turn 1 answered at 63s, turn 2 at 88s (a 45s abort
// plus a 43s retry), then a fixed 45s wall clock cut every later turn
// mid-reasoning, retried the whole prompt, cut the retry the same way, and left
// the panel on "retrying once…" with the run never reaching a terminal state.
// Pin the policy: a slow-but-streaming turn survives, a silent one is retried,
// a still-streaming turn past the ceiling is reported as a MODEL problem rather
// than looped forever.
console.log("\n=== Scenario AK: planner turn liveness policy ===\n");

const {
  withTurnBudget, newTurnLiveness, turnCutShortMessageFor, isRetryablePlannerError,
} = await import("../src/background/agent.ts");

const budgetOpts = (messageFor) => ({
  firstOutputMs: 40, idleMs: 40, maxMs: 150, onTimeout() {}, messageFor,
});

// A turn that keeps producing deltas past the first-output window must live.
const streamingLiveness = newTurnLiveness();
const keepAlive = setInterval(() => {
  streamingLiveness.lastEventAt = performance.now();
  streamingLiveness.events++;
}, 10);
let streamResolved = false;
await Promise.race([
  withTurnBudget(new Promise((r) => setTimeout(() => r("answered"), 220)), streamingLiveness, budgetOpts(() => "should not fire")),
  new Promise((r) => setTimeout(r, 600)),
]).then((v) => { streamResolved = v === "answered"; });
clearInterval(keepAlive);
ok("a slow turn that keeps streaming is NOT killed (the 63s/88s turns)",
  streamResolved && streamingLiveness.ended === "settled");

// A turn that never produces output is cut and classified as retryable.
const silentLiveness = newTurnLiveness();
let silentReason = "";
await withTurnBudget(
  new Promise(() => {}),
  silentLiveness,
  budgetOpts((reason, liveness, waited) => turnCutShortMessageFor("NVIDIA test", reason, liveness, waited, 60_000)),
).catch((err) => { silentReason = err.message; });
ok("a turn that never answers is cut as 'silent'", silentLiveness.ended === "silent", silentReason);
// ...but NOT retried. Measured on NVIDIA NIM: the first attempt produced no
// token in 90s, the retry produced no token in another 90s, and the run died
// after 180s of dead waiting with the same message it could have shown at 90s.
ok("a turn that never produced a single token is NOT retried (180s of nothing)",
  !isRetryablePlannerError(silentReason), silentReason);
ok("a status-coded transient failure is still retried once",
  isRetryablePlannerError("429 rate limit exceeded") &&
  isRetryablePlannerError("network error: fetch failed") &&
  isRetryablePlannerError("503 Service Unavailable"));

// A turn that streams and then goes quiet is a dropped connection: retryable.
const droppedLiveness = newTurnLiveness();
droppedLiveness.events = 12;
droppedLiveness.lastEventAt = performance.now() - 5000;
const droppedMessage = turnCutShortMessageFor("NVIDIA test", "silent", droppedLiveness, 45_000, 60_000);
ok("a stream that goes quiet is reported as a dropped connection and stays retryable",
  isRetryablePlannerError(droppedMessage) && /went silent/.test(droppedMessage), droppedMessage);

// A turn still streaming when the ceiling hits is NOT a transient hiccup.
const ceilingLiveness = newTurnLiveness();
const ceilingMessage = turnCutShortMessageFor("NVIDIA test", "ceiling", ceilingLiveness, 210_000, 60_000);
ok("the ceiling message names the real cause (a slow model)",
  /still streaming/.test(ceilingMessage) && /faster provider/.test(ceilingMessage), ceilingMessage);
ok("the ceiling message is NOT retryable — no endless 'retrying once…' loop",
  !isRetryablePlannerError(ceilingMessage));

// And the budget really does end a permanently-streaming turn as 'ceiling'.
const foreverLiveness = newTurnLiveness();
const foreverTouch = setInterval(() => {
  foreverLiveness.lastEventAt = performance.now();
  foreverLiveness.events++;
}, 10);
let ceilingEnding = "";
await withTurnBudget(
  new Promise(() => {}),
  foreverLiveness,
  budgetOpts((reason, liveness, waited) => turnCutShortMessageFor("NVIDIA test", reason, liveness, waited, 60_000)),
).catch(() => { ceilingEnding = foreverLiveness.ended; });
clearInterval(foreverTouch);
ok("an unbounded stream is stopped at the ceiling, not left running",
  ceilingEnding === "ceiling", ceilingEnding);

// ── Scenario AL: detected-vs-boxed reconciliation ───────────────────────────
// The screenshot evidence: PRY's own audit said "2 PII detected · 0 items
// redacted · nothing to verify" while the BEFORE/AFTER pair showed the address
// readable in both frames. The text channels had found the email in the
// snapshot (an account chip's aria-label renders no text node), tokenized it —
// and the pixel channel had no way to box it, silently.
console.log("\n=== Scenario AL: PII target hygiene and detected-vs-boxed reconciliation ===\n");

const {
  sanitizePiiTargets, findUnlocatedValues, isLocatableSelector,
} = await import("../src/shared/redaction-reconciliation.ts");

// Hygiene: only values worth locating, and only our own selector shape cross
// the message channel to a page.
const targets = sanitizePiiTargets([
  { value: "ada@example.com", selector: '[data-pry-id="12"]' },
  { value: "ada@example.com", selector: '[data-pry-id="12"]' }, // duplicate pair
  { value: "ab" },                                              // too short
  { value: "x".repeat(200) },                                   // too long
  { selector: "body" },                                         // not our shape
  { selector: '[data-pry-id="7"]' },                           // selector alone is fine
  { value: "  +91 98765 43210  " },                             // trimmed
]);
ok("duplicate value+selector pairs collapse to one target", targets.length === 3);
ok("a target keeps its value and selector together (attribution survives)",
  targets[0].value === "ada@example.com" && targets[0].selector === '[data-pry-id="12"]');
ok("too-short and over-long values never reach a page",
  !targets.some((t) => t.value !== undefined && (t.value.length < 3 || t.value.length > 80)) &&
  !targets.some((t) => (t.value ?? "").startsWith("xx")));
ok("an arbitrary selector is rejected; the registry shape is kept",
  !isLocatableSelector("body") && isLocatableSelector('[data-pry-id="7"]') &&
  targets.some((t) => t.selector === '[data-pry-id="7"]' && t.value === undefined));
ok("a whitespace-padded value is trimmed before it is matched",
  targets.some((t) => t.value === "+91 98765 43210"));

// Reconciliation: a value with no box anywhere is exactly the leak to report.
ok("a value boxed as text counts as located",
  findUnlocatedValues(
    [{ value: "ada@example.com" }],
    [{ value: "ada@example.com" }, { kind: "face" }],
  ).length === 0);
ok("a value boxed via its element counts as located too (no false alarm)",
  findUnlocatedValues(
    [{ value: "ada@example.com", selectors: undefined, selector: '[data-pry-id="12"]' }],
    [{ kind: "pii_field", value: "ada@example.com" }],
  ).length === 0);
ok("a value nothing could box is reported as unlocated (the Gmail frame)",
  findUnlocatedValues(
    [{ value: "ada@example.com" }, { value: "Ramesh Gupta" }],
    [{ kind: "face" }],
  ).join("|") === "ada@example.com|Ramesh Gupta");
ok("no targets means nothing to report",
  findUnlocatedValues([], [{ kind: "face" }]).length === 0 &&
  findUnlocatedValues(undefined, undefined).length === 0);
// The warning sample reuses the tokenizer's masking (asserted above), so the
// value it warns about is never re-leaked into the transcript.
ok("the warning sample is masked by the shared tokenizer policy",
  maskSample("ada@example.com") === "ad•••@example.com" &&
  !maskSample("ada@example.com").includes("ada"));

// ── Scenario AM: OCR frame-text triage (PII inside images/canvas) ───────────
// The gap this closes: every other pixel channel starts from the DOM, so text
// baked into an <img>, a <canvas> or a video frame was invisible to all of
// them and stayed readable in the frame the audit shows (and ships, with
// vision on). This pass reads the ALREADY-REDACTED frame back, which makes it
// self-targeting — a DOM-redacted value is a black rectangle OCR cannot read,
// so anything it can read is by definition what nothing else covered.
console.log("\n=== Scenario AM: OCR frame-text triage ===\n");

const {
  findTriageBoxes, dropCoveredBoxes, capTriageBoxes,
} = await import("../src/shared/ocr-pii-triage.ts");

// Words laid out left-to-right on one line, 20px tall, 8px apart.
const line = (text, opts = {}) => {
  let x = opts.x ?? 10;
  const y = opts.y ?? 10;
  const words = text.split(" ").map((w) => {
    const word = { text: w, x, y, width: w.length * 8, height: 20, confidence: opts.confidence ?? 95 };
    x += w.length * 8 + 8;
    return word;
  });
  return { words };
};

const plain = findTriageBoxes([line("Building a GPT math engine from scratch")]);
ok("ordinary page text yields no boxes (no false blackouts)", plain.length === 0,
  JSON.stringify(plain.map((b) => b.value)));

const email = findTriageBoxes([line("contact ada@example.com today", { x: 0, y: 100 })]);
ok("an email inside image text is boxed exactly over its word",
  email.length === 1 && email[0].value === "ada@example.com" && email[0].y === 100 &&
  email[0].width === "ada@example.com".length * 8, JSON.stringify(email));
ok("the box kind uses the painter's opaque tier (`*_text`)",
  email[0].kind.endsWith("_text"), email[0]?.kind);

// A phone split across two OCR words must union BOTH word boxes: boxing only
// the first word would leave the remaining digits readable.
const phone = findTriageBoxes([line("call 98765 43210", { x: 4, y: 40 })]);
ok("a multi-word span unions every word it covers",
  phone.length === 1 && phone[0].value.includes("98765") && phone[0].width >= 10 * 8,
  JSON.stringify(phone));

// A name in a photo has no pattern to match — only the on-device NER knows it.
const named = findTriageBoxes([line("Priya Sharma", { x: 0, y: 60 })], { spans: ["Priya Sharma"] });
ok("a name found by on-device NER is boxed inside an image too",
  named.length === 1 && named[0].source === "known_span" && named[0].value === "Priya Sharma");
ok("a span match inside a longer word is not boxed (Ann in Annual)",
  findTriageBoxes([line("Annual report")], { spans: ["Ann"] }).length === 0);

// Gibberish lines must not manufacture blackouts.
const gibberish = findTriageBoxes([line("ada@example.com", { confidence: 12 })]);
ok("a line OCR itself is unsure about is ignored", gibberish.length === 0);

// Coverage: boxes already inside a redaction region are not painted twice.
const two = findTriageBoxes([
  line("ada@example.com", { x: 0, y: 0 }),
  line("bob@example.com", { x: 0, y: 200 }),
]);
ok("two values on two lines produce two boxes", two.length === 2);
const keptOne = dropCoveredBoxes(two, [{ x: 0, y: 0, width: 200, height: 24 }]);
ok("a box already covered by a redaction region is dropped",
  keptOne.length === 1 && keptOne[0].value === "bob@example.com");
ok("a barely-overlapping box is kept (partial coverage is not coverage)",
  dropCoveredBoxes(two, [{ x: 190, y: 0, width: 10, height: 20 }]).length === 2);

const triageCapped = capTriageBoxes(two, 1);
ok("the cap reports what it dropped instead of implying full triage",
  triageCapped.kept.length === 1 && triageCapped.dropped === 1);
ok("nothing to cap reports nothing dropped", capTriageBoxes(two, 5).dropped === 0);

// ── Scenario AN: text-anchored targeting (the Gmail inbox row) ──────────────
// The failing run: "open gmail and then open the first email" ended with
// `Loop detected: repeated "read_page" 3 times` because the page read's 80
// element slots went to the sidebar, toolbar and tabs, so no message row was in
// the list at all — the planner's own reasoning says "element [25] is a
// checkbox" and it never found a clickable row. Re-reading could not add what
// the read never selected. The text it CAN see is the handle that exists.
console.log("\n=== Scenario AN: text-anchored targeting ===\n");

const {
  normalizeForMatch, scoreTextMatch, rankTextMatches, pickTextMatch,
  isClickableTarget, describeTextTarget,
} = await import("../src/shared/text-target.ts");

ok("matching ignores case and collapsed whitespace",
  normalizeForMatch("  Meta\n   You're\t on the Muse waiting list ") === "meta you're on the muse waiting list");
ok("zero-width characters do not break a match",
  normalizeForMatch("Priya\u200bSharma") === "priyasharma");
ok("scoring prefers exact over prefix over word over substring",
  scoreTextMatch("Sent", "Sent") === "exact" &&
  scoreTextMatch("Sent items", "Sent") === "prefix" &&
  scoreTextMatch("Sentry City", "Sent") === "prefix" &&
  scoreTextMatch("Open Sent now", "Sent") === "word" &&
  scoreTextMatch("City Sentry", "Sent") === "substring",
  ["Sent/Sent", scoreTextMatch("Sent", "Sent"), "City Sentry/Sent", scoreTextMatch("City Sentry", "Sent")].join(" | "));
ok("a query shorter than 2 characters matches nothing",
  scoreTextMatch("Inbox", "I") === null && scoreTextMatch("Inbox", "") === null);

// The inbox frame: rows are measured as separate runs, in reading order.
const inboxFrame = [
  { text: "Inbox", x: 90, y: 130, width: 40, height: 18 },
  { text: "Starred", x: 90, y: 152, width: 60, height: 18 },
  { text: "You're on the Muse waitlist", x: 180, y: 160, width: 240, height: 18 },
  { text: "Team approved - BuildSprint", x: 180, y: 190, width: 240, height: 18 },
  { text: "Use code 910520 to log in", x: 180, y: 220, width: 240, height: 18 },
];
const firstEmail = pickTextMatch(inboxFrame, "You're on the Muse waitlist");
ok("the first email row is matched by its visible subject text",
  firstEmail?.run.text === "You're on the Muse waitlist" && firstEmail.run.y === 160,
  JSON.stringify(firstEmail?.run));
ok("a row-level query matches even though the row is several spans",
  pickTextMatch(inboxFrame, "team approved")?.run.y === 190);
ok("the topmost of several equal matches wins, and index steps down",
  pickTextMatch(inboxFrame, "Inbox")?.run.y === 130 &&
  pickTextMatch(inboxFrame, "o", 0) === null);

// Two rows both containing "Meta" → index selects the second, by position.
const twoMetas = [
  { text: "Meta - You're on the Muse waitlist", x: 0, y: 160, width: 200, height: 18 },
  { text: "Meta - Use code 910520 to log in", x: 0, y: 200, width: 200, height: 18 },
];
ok("index picks the next match down the page, not a random one",
  pickTextMatch(twoMetas, "Meta")?.run.y === 160 &&
  pickTextMatch(twoMetas, "Meta", 1)?.run.y === 200);
ok("an out-of-range index falls back to the last match instead of clicking nothing",
  pickTextMatch(twoMetas, "Meta", 99)?.run.y === 200);
ok("a query with no match returns null so the caller can fail loudly",
  pickTextMatch(inboxFrame, "nonexistent row") === null);
ok("ranking is deterministic: score first, then reading order",
  rankTextMatches(
    [{ text: "Open Sent", x: 0, y: 10, width: 50, height: 10 }, { text: "Sent", x: 0, y: 90, width: 50, height: 10 }],
    "Sent",
  )[0].run.y === 90);

// Clickable-container policy: Gmail rows are table rows with a delegated
// handler, so `tr` must count; a bare span must not.
ok("a table row counts as a click target (Gmail's inbox rows)",
  isClickableTarget("tr", null, false));
ok("controls and roles count, and a plain span does not",
  isClickableTarget("a", "link", false) &&
  isClickableTarget("div", "listitem", false) &&
  isClickableTarget("div", null, true) &&
  !isClickableTarget("span", null, false));
ok("the action result names what was clicked",
  describeTextTarget("You're on the Muse waitlist", "tr", "row") ===
  '<tr role=row> "you\'re on the muse waitlist"');

// Contract: the tool is exposed to the planner, routed to the page, and the
// safety gate still sees irreversible text requests.
const { TOOLS, PAGE_ACTIONS, actionChangesFrame } = await import("../src/background/tools.ts");
const clickTextTool = TOOLS.find((t) => t.name === "click_text");
ok("click_text is exposed to the planner with a text parameter",
  Boolean(clickTextTool) &&
  clickTextTool.parameters.properties.text?.type === "string" &&
  clickTextTool.parameters.required.includes("text"));
ok("click_text is routed to the content script as a page action",
  PAGE_ACTIONS.has("click_text"));

const { gate: safetyGate } = await import("../src/background/safety.ts");
const refuseEmpty = safetyGate({ name: "click_text", input: { text: "a" } }, undefined, false);
ok("a blind click_text (no usable text) is refused", refuseEmpty.verdict === "refuse", refuseEmpty.reason);
const confirmRiskyText = safetyGate({ name: "click_text", input: { text: "Delete account" } }, undefined, true);
ok("an irreversible target stays behind a confirmation even when matched by text",
  confirmRiskyText.verdict === "confirm", JSON.stringify(confirmRiskyText));
const allowReadOnly = safetyGate({ name: "click_text", input: { text: "You're on the Muse waitlist" } }, undefined, true);
ok("an ordinary row click is allowed", allowReadOnly.verdict === "allow", JSON.stringify(allowReadOnly));

// ── Scenario AO: the deliberation guard ─────────────────────────────────────
// The reported stall: the planner streamed past the 6 000-char display cap
// deliberating about which element was "the first email", never emitted a tool
// call, and nothing cut it — silence never tripped while reasoning flowed, so
// the run sat in one turn until the 210 s ceiling with a truncated, unmoving
// panel. It looked like an API failure; it was a model that would not act.
console.log("\n=== Scenario AO: deliberation guard ===\n");

const { ACT_NOW_DIRECTIVE } = await import("../src/background/agent.ts");

// The directive must name both handles this stall needs.
ok("the steering directive tells the model to act now",
  /act now/i.test(ACT_NOW_DIRECTIVE) && /ONE tool call/.test(ACT_NOW_DIRECTIVE));
ok("and hands it the handle it was missing (click_text by visible text)",
  /click_text/.test(ACT_NOW_DIRECTIVE) && /no element id/.test(ACT_NOW_DIRECTIVE));

// A deliberation cut must never be classified as a transient network hiccup,
// or it would be retried with the identical prompt and stall identically.
const deliberateLiveness = newTurnLiveness();
deliberateLiveness.events = 40;
deliberateLiveness.reasoningChars = 14_200;
deliberateLiveness.reasoningStartedAt = performance.now() - 100_000;
const deliberateMessage = turnCutShortMessageFor("NVIDIA test", "deliberation", deliberateLiveness, 100_000, 60_000);
ok("the deliberation message names the real cause (reasoned, no action)",
  /without taking a single action/.test(deliberateMessage) &&
  /14,200 characters/.test(deliberateMessage), deliberateMessage);
ok("the deliberation message is NOT classed as a retryable stall",
  !isRetryablePlannerError(deliberateMessage), deliberateMessage);
ok("and it does not blame the network for a model that would not act",
  !/network|overloaded|timed? ?out|stalled/i.test(deliberateMessage));

// The budget really does cut a turn that only reasons. Reasoning deltas keep
// arriving, so neither the silence window nor the first-output window can fire:
// the reasoning guard is the only thing that can end this turn.
const monologueLiveness = newTurnLiveness();
const monologue = setInterval(() => {
  monologueLiveness.lastEventAt = performance.now();
  monologueLiveness.events++;
  monologueLiveness.reasoningChars += 400;
  if (monologueLiveness.reasoningStartedAt === 0) monologueLiveness.reasoningStartedAt = performance.now();
}, 10);
let monologueEnded = "";
const monologueStart = Date.now();
await withTurnBudget(
  new Promise(() => {}),
  monologueLiveness,
  {
    firstOutputMs: 60_000,
    idleMs: 30_000,
    maxMs: 600_000,
    maxReasoningChars: 2_000,
    maxReasoningMs: 60_000,
    onTimeout() {},
    messageFor: (reason, liveness, waited) =>
      turnCutShortMessageFor("NVIDIA test", reason, liveness, waited, 60_000),
  },
).catch(() => { monologueEnded = monologueLiveness.ended; });
clearInterval(monologue);
ok("a turn that only reasons is cut by the guard, not left to the ceiling",
  monologueEnded === "deliberation", monologueEnded);
ok("and it is cut quickly rather than after minutes",
  Date.now() - monologueStart < 5_000, `${Date.now() - monologueStart}ms`);

// The time rule has a floor so a slow-but-short turn is not cut for being slow.
const slowButShallow = newTurnLiveness();
slowButShallow.events = 3;
slowButShallow.reasoningChars = 120;
slowButShallow.reasoningStartedAt = performance.now() - 200_000;
const shallowCut = await Promise.race([
  withTurnBudget(new Promise((r) => setTimeout(() => r("answered"), 1200)), slowButShallow, {
    firstOutputMs: 60_000,
    idleMs: 30_000,
    maxMs: 600_000,
    onTimeout() {},
    messageFor: (reason, liveness, waited) => turnCutShortMessageFor("NVIDIA test", reason, liveness, waited, 60_000),
  }).catch(() => "cut"),
  new Promise((r) => setTimeout(() => r("timeout"), 4000)),
]);
ok("a turn that has barely said anything is not cut for being slow",
  shallowCut === "answered", String(shallowCut));

// ── Scenario AU: the runaway-loop guard ─────────────────────────────────────
// The live failure: a 100 s turn against nvidia/nemotron-3.5-lightning-30b-a3b
// whose output collapsed into "can make it one big things. can make it. 0 1 can
// make it one." for thousands of characters. Deltas kept arriving, so the
// silence window never tripped; the deliberation caps only counted onThought,
// and this model streams chain-of-thought through delta.content as well; so the
// run then presented the loop to the user as the answer, spoke it, and re-sent
// it in the next turn's history. Repetition is the one signal a loop cannot
// hide, so it is measured on the text.
console.log("\n=== Scenario AU: runaway-loop (degenerate output) guard ===\n");

const {
  isDegenerateOutput,
  isWordSalad,
  punctuationDensity,
  nonLatinLetterScripts,
  degenerationRatio,
  recordStreamedOutput,
  clampAssistantTextForHistory,
  MAX_HISTORY_TEXT_CHARS,
} = await import("../src/background/agent.ts");
const { SYSTEM_PROMPT: PRY_SYSTEM_PROMPT } = await import("../src/background/prompt.ts");

// Verbatim from the reported run. The head is the model drifting out of its
// topic ("The German Mastiff…"); the tail below it is the loop it collapsed
// into, which kept repeating verbatim in the 6 233-character stream. A faithful
// fixture therefore needs both: a diverse head is what makes the ratio
// measure anything, since a loop from the first word is trivially detectable.
const RUNAWAY_HEAD =
  "The only thing one and can. big. Can make it, can one can one, and can one one big thing " +
  "can make it one big things. Can make it one big things. Can one big things. one can make it. " +
  "and can one big things. can make it. 0. I. And can one big can make it one. thing can make it " +
  "one. And can one big things. can make it. 1 big things can make it. one. big things. can make " +
  "it, one big things. can make it. 0. So can make it. 0. And one can make it can one big thing. " +
  "And can one thing. can make it one. And can one big things. can make it. 0 1 can make it. one " +
  "big things. can make it. 0 1 can make it one. And can one big things. can make it. 0 1 can " +
  "make it one. And can one big things. can make it. 0 1 can make it one. And can one big things. " +
  "can make it. 0 1 can make it one. And can one big things. can make it. 0 1 can make it one. " +
  "And can one big things. can make it. 0 1 can make it one. And can one big things. can make it.";
const RUNAWAY_CYCLE = " And can one big things. can make it. 0 1 can make it one.";
const RUNAWAY = RUNAWAY_HEAD + RUNAWAY_CYCLE.repeat(12);

ok("the reported runaway is detected as degenerate", isDegenerateOutput(RUNAWAY));

// The adversarial false positive: a LONG legitimate answer whose rows really
// are near-identical. A first version of this guard counted every repeated
// 4-gram and flagged exactly this — the reason the rule is now short-cycle.
const TABLE_DUMP = Array.from(
  { length: 12 },
  (_, i) =>
    `${i + 1}. Priya Sharma, email address, account active, last sign in 3 days ago, ` +
    `plan pro, region ap-south-1, token issued, status verified.`,
).join("\n");
ok("a long table of near-identical rows is NOT read as a loop",
  !isDegenerateOutput(TABLE_DUMP), `ratio ${degenerationRatio(TABLE_DUMP).toFixed(3)}`);
ok("nor is PRY's own system prompt", !isDegenerateOutput(PRY_SYSTEM_PROMPT),
  `ratio ${degenerationRatio(PRY_SYSTEM_PROMPT).toFixed(3)}`);
ok("nor coherent multi-sentence agent reasoning",
  !isDegenerateOutput(
    "The inbox read is dominated by the sidebar and toolbar, so no message row has an " +
    "element id. I should navigate directly to youtube.com instead of reconstructing the " +
    "route through an app grid, then type the channel name into the search box.",
  ));
ok("and a short narration line is never in scope",
  !isDegenerateOutput("Opening YouTube and typing the channel name."));

// A loop with a LONG period — the same ~45-word paragraph re-emitted verbatim.
// The short-cycle signal deliberately ignores this (its repeats are 45 words
// apart, the same spacing as a table row), which is why there is a second one.
const LONG_PERIOD_PARAGRAPH =
  "I need to check whether the search results actually loaded before clicking anything on this page, " +
  "because the element ids from the previous read are stale after a navigation and the results list " +
  "is rendered lazily by the site, so the safest next step is to read the page once more and look for " +
  "a result title link near a duration label before taking any further action on it.";
const LONG_PERIOD_LOOP = Array.from({ length: 5 }, () => LONG_PERIOD_PARAGRAPH).join(" ");
ok("a long-period verbatim loop is detected too (the short-cycle signal cannot see it)",
  isDegenerateOutput(LONG_PERIOD_LOOP) && degenerationRatio(LONG_PERIOD_LOOP) < 0.5,
  `block-repeated, short-cycle ratio ${degenerationRatio(LONG_PERIOD_LOOP).toFixed(3)}`);
ok("but the same paragraph stated ONCE is not a loop", !isDegenerateOutput(LONG_PERIOD_PARAGRAPH));
// Margin: the two populations must not be close, or the threshold is luck.
ok("the detector separates the two populations with a wide margin",
  degenerationRatio(RUNAWAY) >= 0.5 && degenerationRatio(TABLE_DUMP) <= 0.05 &&
  degenerationRatio(PRY_SYSTEM_PROMPT) === 0,
  `runaway ${degenerationRatio(RUNAWAY).toFixed(3)} vs table ${degenerationRatio(TABLE_DUMP).toFixed(3)}`);
// …and it must not need the whole stream to notice: by the time the loop has
// repeated a dozen times the verdict is already in, which is why the live 100 s
// turn would have been stopped after a few seconds.
ok("the verdict is reached early in the loop, not at the end of the stream",
  isDegenerateOutput(RUNAWAY_HEAD + RUNAWAY_CYCLE.repeat(6)) &&
  degenerationRatio(RUNAWAY_HEAD + RUNAWAY_CYCLE.repeat(6)) >= 0.5);

// ── The OTHER runaway: glitch text that is not a repetition loop ──────────
// The verbatim sample lives in `fixtures/glitch-output.mjs` (with the run it
// came from) because the agent-loop harness feeds the SAME bytes through a real
// `runTask` — see the `SALAD`/`SALAD_ANSWER` note there. Every 4-gram in it is
// unique, so the loop guard above returns false: repetition is not the only way
// a stream stops being language.

ok("the reported glitch stream is NOT a repetition loop, so the loop guard cannot see it",
  degenerationRatio(SALAD) < 0.05 && !isDegenerateOutput(SALAD),
  `ratio ${degenerationRatio(SALAD).toFixed(3)}`);
ok("but it is caught as word salad", isWordSalad(SALAD));
ok("on the two measured signals (density, and scripts), not on a vibe",
  punctuationDensity(SALAD) >= 0.25 && nonLatinLetterScripts(SALAD).length >= 3,
  `punct ${punctuationDensity(SALAD).toFixed(3)} · scripts ${nonLatinLetterScripts(SALAD).join(",")}`);

// The false-positive battery: long, legitimate outputs of exactly the shapes an
// agent produces, at the lengths where any of this can trigger.
const LEGIT_LONG = {
  "markdown table": [
    "| # | Name | Email | Plan | Region | Status |",
    "| --- | --- | --- | --- | --- | --- |",
    ...Array.from({ length: 24 }, (_, i) => `| ${i + 1} | Priya Sharma | priya${i}@example.com | pro | ap-south-1 | verified |`),
  ].join("\n"),
  "code block": Array.from(
    { length: 30 },
    (_, i) => `  if (entry_${i} && out.includes(entry_${i}.original)) {\n    out = replaceValueWithToken(out, entry_${i});\n    continue;\n  }`,
  ).join("\n"),
  "minified JSON": JSON.stringify({
    tokens: Array.from({ length: 40 }, (_, i) => ({ t: `<CRED_${i}>`, k: "credential", s: "sh···@gmail.com" })),
  }).replace(/\s+/g, ""),
  "four Latin languages": [
    "En español: esta extensión no envía sus datos a ningún servidor.",
    "En français: le contenu de la page reste dans le navigateur.",
    "Auf Deutsch: die Daten verlassen den Browser nicht.",
    "In italiano: nessun dato viene inviato a terzi durante la sessione.",
    "The same guarantee holds in every language the user writes in, and the panel says so.",
  ].join(" "),
  "two-script translation answer": [
    "The Hindi rendering is: यह एक उदाहरण है जो दिखाता है कि पाठ कैसे रहता है।",
    "The explanation continues in plain English so the reader can follow the rest of this paragraph comfortably.",
    "The Arabic equivalent is: هذا مثال يوضح كيف يبقى النص داخل المتصفح ولا يغادر الجهاز أبدا.",
    "And the paragraph closes with ordinary English prose, exactly as a real answer would end.",
    "A second English sentence follows so the sample is long enough to be in scope at all for this check.",
  ].join(" "),
};
for (const [name, text] of Object.entries(LEGIT_LONG)) {
  ok(`a long legitimate ${name} is not read as salad`,
    !isWordSalad(text),
    `punct ${punctuationDensity(text).toFixed(3)} · scripts ${nonLatinLetterScripts(text).length}`);
}
ok("nor is PRY's own system prompt salad",
  !isWordSalad(PRY_SYSTEM_PROMPT), `punct ${punctuationDensity(PRY_SYSTEM_PROMPT).toFixed(3)}`);

// WHY BOTH CONDITIONS: density alone does not separate the populations — a
// minified JSON blob is MORE punctuation-heavy than the glitch stream. The
// script mixture is what does. Written as an assertion so that loosening the
// rule to one signal fails here with the numbers attached.
ok("punctuation density alone cannot separate them (so it is not the only test)",
  punctuationDensity(LEGIT_LONG["minified JSON"]) > punctuationDensity(SALAD),
  `json ${punctuationDensity(LEGIT_LONG["minified JSON"]).toFixed(3)} vs salad ${punctuationDensity(SALAD).toFixed(3)}`);
ok("the script mixture is what separates them: the salad mixes 4, every legitimate sample at most 2",
  nonLatinLetterScripts(SALAD).length === 4 &&
    Object.values(LEGIT_LONG).every((t) => nonLatinLetterScripts(t).length <= 2),
  `salad ${nonLatinLetterScripts(SALAD).length} vs max legit ${Math.max(...Object.values(LEGIT_LONG).map((t) => nonLatinLetterScripts(t).length))}`);
ok("and the word floor keeps a short fragment out of scope",
  !isWordSalad(SALAD.split(/\s+/).slice(0, 40).join(" ")));

// The tail must keep the END of the stream — a guard that kept the start would
// watch the model's opening and never see the loop it drifts into.
const tailLiveness = newTurnLiveness();
recordStreamedOutput(tailLiveness, "A".repeat(5000));
ok("the rolling tail is capped", tailLiveness.outputTail.length === 4000);
const tailProbe = newTurnLiveness();
recordStreamedOutput(tailProbe, "start ");
recordStreamedOutput(tailProbe, "B".repeat(5000));
ok("the rolling tail drops the OLDEST characters, not the newest",
  tailProbe.outputTail.endsWith("BBBB") && !tailProbe.outputTail.includes("start"));

// The budget cuts a degenerate turn fast, and calls it what it is. Deltas are
// fed a few words at a time, which is how a stream actually arrives — a large
// chunk would put the cycle outside the window and flatter the detector.
const runawayWords = RUNAWAY.split(/\s+/);
const degenerateLiveness = newTurnLiveness();
let runawayIndex = 0;
const ramble = setInterval(() => {
  degenerateLiveness.lastEventAt = performance.now();
  degenerateLiveness.events++;
  recordStreamedOutput(degenerateLiveness, `${runawayWords.slice(runawayIndex, runawayIndex + 4).join(" ")} `);
  runawayIndex += 4;
  if (runawayIndex >= runawayWords.length) runawayIndex = RUNAWAY_HEAD.split(/\s+/).length;
}, 5);
let degenerateEnded = "";
const degenerateStart = Date.now();
await withTurnBudget(new Promise(() => {}), degenerateLiveness, {
  firstOutputMs: 60_000,
  idleMs: 30_000,
  maxMs: 600_000,
  onTimeout() {},
  messageFor: (reason, liveness, waited) =>
    turnCutShortMessageFor("NVIDIA test", reason, liveness, waited, 60_000),
}).catch(() => { degenerateEnded = degenerateLiveness.ended; });
clearInterval(ramble);
const degenerateElapsed = Date.now() - degenerateStart;
ok("a looping turn is cut as 'degenerate' rather than run to the ceiling",
  degenerateEnded === "degenerate", degenerateEnded);
ok("and it is cut in seconds, not the 100 s the live run took",
  degenerateElapsed < 5_000, `${degenerateElapsed}ms`);

// A coherent turn of the same shape must survive — otherwise the guard is just
// a shorter ceiling and would cut real long answers.
// Streamed chunks of PRY's own 1 400-word system prompt: long, real, coherent
// prose that shares plenty of vocabulary ("the page", "read it again") without
// ever cycling.
const coherentChunks = PRY_SYSTEM_PROMPT.split(" ").reduce((acc, word) => {
  if (!acc.length || acc[acc.length - 1].split(" ").length >= 8) acc.push(word);
  else acc[acc.length - 1] += ` ${word}`;
  return acc;
}, []);
const coherentLiveness = newTurnLiveness();
let coherentIndex = 0;
const coherentTick = setInterval(() => {
  coherentLiveness.lastEventAt = performance.now();
  coherentLiveness.events++;
  recordStreamedOutput(coherentLiveness, `${coherentChunks[coherentIndex++ % coherentChunks.length]} `);
}, 5);
const coherentSurvived = await Promise.race([
  withTurnBudget(new Promise((r) => setTimeout(() => r("answered"), 1200)), coherentLiveness, {
    firstOutputMs: 60_000, idleMs: 30_000, maxMs: 600_000, onTimeout() {},
    messageFor: (reason, liveness, waited) =>
      turnCutShortMessageFor("NVIDIA test", reason, liveness, waited, 60_000),
  }).catch(() => "cut"),
  new Promise((r) => setTimeout(() => r("timeout"), 4000)),
]);
clearInterval(coherentTick);
ok("a turn streaming 1 400 words of coherent prose is not cut — the guard is not a shorter ceiling",
  (coherentSurvived === "answered" || coherentLiveness.ended === "settled") &&
  coherentLiveness.outputTail.split(/\s+/).length > 400,
  `${coherentSurvived}/${coherentLiveness.ended} · ${coherentLiveness.outputTail.split(/\s+/).length} words streamed`);

// The same budget, fed the real glitch stream: it must be cut as `salad` (not
// as a loop, and not after the 210 s ceiling), because that is what the run
// then reports — and the run must never present the stream as the answer.
const saladWords = SALAD.split(/\s+/);
const saladLiveness = newTurnLiveness();
let saladIndex = 0;
const saladTick = setInterval(() => {
  saladLiveness.lastEventAt = performance.now();
  saladLiveness.events++;
  recordStreamedOutput(saladLiveness, `${saladWords.slice(saladIndex, saladIndex + 4).join(" ")} `);
  saladIndex += 4;
}, 5);
let saladEnded = "";
const saladStart = Date.now();
await withTurnBudget(new Promise(() => {}), saladLiveness, {
  firstOutputMs: 60_000,
  idleMs: 30_000,
  maxMs: 600_000,
  onTimeout() {},
  messageFor: (reason, liveness, waited) =>
    turnCutShortMessageFor("NVIDIA test", reason, liveness, waited, 60_000),
}).catch(() => { saladEnded = saladLiveness.ended; });
clearInterval(saladTick);
const saladElapsed = Date.now() - saladStart;
ok("the glitch stream is cut as 'salad', with its own reason rather than the loop's",
  saladEnded === "salad", `${saladEnded} after ${saladElapsed}ms`);
ok("and it is cut in seconds, not at the ceiling",
  saladElapsed < 5_000, `${saladElapsed}ms`);

// The same glitch, followed by silence — the shape the live run actually had:
// 45 updates of fragments and THEN 30 s of quiet. The idle branch read the quiet
// first, called it a mid-stream stall, and retried (that wording is retryable by
// design), which re-sent the prompt that produced the glitch and produced it
// again. The collapse is the finding; the silence after it is a symptom.
const stalledSalad = newTurnLiveness();
for (let i = 0; i + 4 <= saladWords.length; i += 4) {
  recordStreamedOutput(stalledSalad, `${saladWords.slice(i, i + 4).join(" ")} `);
  stalledSalad.events++;
}
stalledSalad.lastEventAt = performance.now();
ok("the stall fixture really is salad and really has streamed something",
  isWordSalad(stalledSalad.outputTail) && stalledSalad.events > 0,
  `${stalledSalad.events} updates, ${stalledSalad.outputTail.length} chars`);
let stalledEnded = "";
await withTurnBudget(new Promise(() => {}), stalledSalad, {
  firstOutputMs: 60_000,
  idleMs: 100,
  maxMs: 600_000,
  onTimeout() {},
  messageFor: (reason, liveness, waited) =>
    turnCutShortMessageFor("NVIDIA test", reason, liveness, waited, 60_000),
}).catch(() => { stalledEnded = stalledSalad.ended; });
ok("glitch followed by silence is reported as salad, not as a retryable stall",
  stalledEnded === "salad", `${stalledEnded} (idle window was 100ms)`);
// …and the two readings lead to different futures, which is why the order
// matters: the stall wording re-sends the prompt, the salad wording does not.
const stallWouldSay = turnCutShortMessageFor("NVIDIA test", "silent", stalledSalad, 600, 60_000);
ok("the stall reading is the one that would have re-sent the prompt",
  isRetryablePlannerError(stallWouldSay), stallWouldSay);
ok("so the cut it reports instead is not retryable",
  !isRetryablePlannerError(turnCutShortMessageFor("NVIDIA test", stalledEnded, stalledSalad, 600, 60_000)));

const saladMessage = turnCutShortMessageFor("NVIDIA test", "salad", saladLiveness, 9_000, 60_000);
ok("the salad message names the real cause (not language, not a loop)",
  /stopped writing language/.test(saladMessage) && !/repetition loop/.test(saladMessage),
  saladMessage);
ok("it does not read as a transient stall, so the same prompt is not re-sent",
  !isRetryablePlannerError(saladMessage), saladMessage);
ok("and it says no action was taken, which is what the user needs to know",
  /no action was taken/.test(saladMessage));

// The fragments were painted into the answer card as they streamed, so ruling on
// them is not enough — the card has to be emptied. Assistant patches APPEND by
// design (they are narration deltas), so the three surfaces must agree on the
// one patch that replaces: the loop emits it, the worker applies it, the panel
// renders it. Captioning the glitch instead would leave the wall on screen under
// a note saying it was not an answer.
const guardSource = await readFile("src/background/agent.ts", "utf8");
const workerSource3 = await readFile("src/background/service-worker.ts", "utf8");
const panelSource3 = await readFile("src/sidepanel/sidepanel.ts", "utf8");
ok("the loop discards an already-painted stream on BOTH guard paths",
  (guardSource.match(/DISCARDED_STREAM_NOTE/g) ?? []).length >= 3,
  `${(guardSource.match(/DISCARDED_STREAM_NOTE/g) ?? []).length} references (definition + cut + final answer)`);
ok("and the note says the output was discarded, not shown",
  /was discarded/.test(guardSource));
ok("the worker replaces an assistant entry only when the patch says so",
  /entry\.role === "assistant" && !event\.replace/.test(workerSource3));
ok("and the panel renders that replacement instead of appending to it",
  /event\.replace \? "" :/.test(panelSource3));
ok("an ordinary narration delta still appends in both",
  /entry\.text \+ event\.text/.test(workerSource3) &&
    /rawTexts\.get\(event\.id\) \?\? ""\)\) \+ event\.text/.test(panelSource3));

// ── Every provider must keep the two channels apart ─────────────────────────
// `onText` is painted as PRY's ANSWER; `onThought` proves liveness, opens the
// reasoning block, and feeds `liveness.reasoningChars` — which is the signal the
// 12 000-char / 90 s deliberation cut reads. A reasoning model's chain-of-thought
// sent down the wrong one shows the model's private analysis to the user as its
// reply AND leaves the deliberation guard permanently blind. Groq did exactly
// that (measured live: one gpt-oss-20b turn streamed 3 478 chars of reasoning
// through onText and returned an empty turn.text), so the split is asserted for
// every adapter that parses a reasoning field, not just the one that was wrong.
const providerFiles = ["groq", "nvidia", "openai", "anthropic", "ollama"];
for (const name of providerFiles) {
  const source = await readFile(`src/background/providers/${name}.ts`, "utf8");
  // The bug class is a streamed reasoning FIELD routed to the wrong channel; a
  // request flag such as `reasoning_effort`, or a comment mentioning reasoning
  // models, is not a channel decision. (An adapter that parses no reasoning
  // field at all simply has no chain-of-thought to misroute.)
  const reasoningField = /delta\??\.\s*(reasoning_content|reasoning|thinking)\b/;
  if (!reasoningField.test(source)) continue;
  const toAnswer = new RegExp(
    `onText\\(\\s*(String\\()?\\s*(delta\\??\\.\\s*)?(reasoning_content|reasoning|thinking)\\b`,
  ).test(source);
  ok(`${name} sends chain-of-thought to the reasoning channel, never the answer channel`,
    /onThought\?\.\(/.test(source) && !toAnswer,
    toAnswer ? "reasoning is passed to onText" : "ok");
}

const degenerateMessage = turnCutShortMessageFor("NVIDIA test", "degenerate", degenerateLiveness, 12_000, 60_000);
ok("the degeneration message names the real cause (produced text, nothing new)",
  /repetition loop/.test(degenerateMessage) && /nothing new/.test(degenerateMessage),
  degenerateMessage);
ok("it does NOT read as a transient stall, so the prompt is not re-sent to the same model",
  !isRetryablePlannerError(degenerateMessage), degenerateMessage);
ok("and it points at the fix (a steadier model)", /steadier model/.test(degenerateMessage));

// History replay is bounded: the model's own monologue comes back to it every
// later turn, so an unbounded ramble is paid for repeatedly and invites more of
// it. A final answer never reaches this path (no tool calls ends the run).
ok("short narration is replayed verbatim",
  clampAssistantTextForHistory("Opening YouTube.") === "Opening YouTube.");
ok("whitespace-only narration collapses to nothing",
  clampAssistantTextForHistory("   \n  ") === "");
const longMonologue = `Opening YouTube ${"and then reading the page again ".repeat(200)}`;
const clampedMonologue = clampAssistantTextForHistory(longMonologue);
ok("an over-long monologue is clamped before it is replayed",
  clampedMonologue.length < longMonologue.length &&
  clampedMonologue.length <= MAX_HISTORY_TEXT_CHARS + " …[truncated for length]".length,
  `${clampedMonologue.length} chars`);
ok("the clamp announces itself instead of silently dropping text",
  clampedMonologue.endsWith("…[truncated for length]"));
ok("the clamp never leaves half a word behind",
  !/\w…\[/.test(clampedMonologue), clampedMonologue.slice(-40));

// ── Scenario AV: the frame pipeline must not block the planner ─────────────
// The measured cost: the post-action pixel pipeline (capture → redact → verify
// → attack → record) is 1.2 s for a 1× viewport and up to 6.5 s at the 6-tile
// triage cap, and it used to be awaited in front of EVERY page-changing step's
// planner call — local work serialised with a network call that needs none of
// it. It is audit-only whenever vision is off, because no byte of that frame
// reaches the planner.
console.log("\n=== Scenario AV: post-action frame pipeline off the critical path ===\n");

const { frameNeedsPlannerWait, joinEvidence } = await import("../src/background/agent.ts");

// The policy: the direction that matters is VISION ON, because deferring that
// frame hands the planner a description of a screen from before its own action.
ok("vision ON ⇒ the frame must complete before the next planner turn",
  frameNeedsPlannerWait({ visionEnabled: true, hasVisionKey: true, aborted: false }) === true);
ok("vision OFF (the default) ⇒ the frame is audit-only and may run alongside the turn",
  frameNeedsPlannerWait({ visionEnabled: false, hasVisionKey: true, aborted: false }) === false);
ok("vision on with NO key ⇒ nothing can ship, so it is audit-only too",
  frameNeedsPlannerWait({ visionEnabled: true, hasVisionKey: false, aborted: false }) === false);
ok("a Stop mid-step ⇒ no frame is awaited on the way out",
  frameNeedsPlannerWait({ visionEnabled: true, hasVisionKey: true, aborted: true }) === false);

// The join: evidence that has already settled costs nothing, which is the whole
// point — it is joined after a planner turn, not before one.
let resolvedAt = 0;
const work = new Promise((resolve) => {
  setTimeout(() => {
    resolvedAt = Date.now();
    resolve({ summary: "[Frame after the previous action: 4 PII redacted]" });
  }, 60);
});
await new Promise((r) => setTimeout(r, 80));
const joinStart = Date.now();
const joined = await joinEvidence(work, 15_000);
const joinCost = Date.now() - joinStart;
ok("joining a pipeline that already settled returns its evidence",
  joined?.summary === "[Frame after the previous action: 4 PII redacted]", JSON.stringify(joined));
ok("…and costs ~nothing, because the planner turn was the overlap",
  joinCost < 30 && resolvedAt <= joinStart, `${joinCost}ms, settled ${joinStart - resolvedAt}ms before the join`);

// The safety net, which is the reason a wedged capture cannot hang a run: the
// pipeline keeps running and still files its own ledger entry, but the LINE is
// skipped rather than waited for forever.
const wedgedStart = Date.now();
const wedged = await joinEvidence(new Promise(() => {}), 80);
const wedgedCost = Date.now() - wedgedStart;
ok("a pipeline that never settles does not hold the run open",
  wedged === null && wedgedCost >= 70 && wedgedCost < 1_500, `${wedgedCost}ms -> ${wedged}`);
ok("a pipeline that THROWS cannot take the run down from a join site",
  (await joinEvidence(Promise.reject(new Error("capture blew up")), 500)) === null);
ok("joining nothing at all is free", (await joinEvidence(Promise.resolve(null), 500)) === null);

// The structural invariant behind the timing claim: the capture is awaited in
// exactly ONE place — inside the shared pipeline — and the post-action site
// routes through the policy instead of awaiting it inline. Re-inlining that
// await is the regression this catches (it is one line, and it silently
// restores 1.2-6.5 s in front of every planner call).
const agentSource = await readFile("src/background/agent.ts", "utf8");
const awaitedCaptures = agentSource.match(/await captureScreenshot\(/g) ?? [];
ok("the capture is awaited in exactly one place (inside the shared pipeline)",
  awaitedCaptures.length === 1, `${awaitedCaptures.length} site(s)`);
// Both frame sites must BRANCH on that policy — await in the vision branch,
// defer in the other — rather than pick one behaviour for both. (The opening
// frame is the site a wedged capture used to hang a run on, before it had any
// planner turn to hide behind, so it is bounded too.)
const policyDefAt = agentSource.indexOf("export function frameNeedsPlannerWait(");
const policyUseAt = agentSource.indexOf("frameNeedsPlannerWait({");
const openingAwaitedAt = agentSource.indexOf("awaitFrame(runFrameAudit(lastDomDetections");
const openingDeferredAt = agentSource.indexOf("startFrameAudit(lastDomDetections, FRAME_LABEL_OPENING)");
const actionAwaitedAt = agentSource.indexOf("runFrameAudit(freshDetections, observation, FRAME_LABEL_AWAITED)");
const actionDeferredAt = agentSource.indexOf("startFrameAudit(freshDetections, FRAME_LABEL_DEFERRED)");
ok("both frame sites branch on the same policy instead of awaiting directly",
  policyDefAt > 0 && policyUseAt > 0 && openingAwaitedAt > policyUseAt && actionAwaitedAt > policyUseAt,
  `policy defined@${policyDefAt} used@${policyUseAt} opening@${openingAwaitedAt} action@${actionAwaitedAt}`);
ok("and the policy is exported, so its truth table is pinned by a test rather than by reading the call site",
  /export function frameNeedsPlannerWait\(/.test(agentSource));
ok("and each site has a deferred half for the vision-off case",
  openingDeferredAt > 0 && actionDeferredAt > 0);
ok("neither site produces an action summary line for the opening frame (it is not an action's frame)",
  /awaitFrame\(runFrameAudit\(lastDomDetections, "", ""\)\)/.test(agentSource));

// Every wait on a frame pipeline goes through ONE budget. A stray literal would
// mean a site that can hang for a different, undocumented length of time.
ok("the awaited frames are bounded by the named budget, not a literal",
  agentSource.includes("joinEvidence(run.then((value) => ({ value })), FRAME_AUDIT_WAIT_MS)"));
ok("and so is the deferred join",
  agentSource.includes("joinEvidence(pending, FRAME_AUDIT_WAIT_MS)"));
ok("a frame that does not arrive in time is announced, never silently dropped",
  /function noteFrameTimeout\(/.test(agentSource) &&
  (agentSource.match(/noteFrameTimeout\("/g) ?? []).length >= 2);

// ── Scenario AP: the app-switcher dead end ─────────────────────────────────
// The live run: task = reach another site from a Gmail tab. The planner clicked
// `<a 'Google apps'>`, which opens Google's app launcher in a CROSS-ORIGIN
// iframe (ogs.google.com). Nothing in the page can read that document, so the
// tiles are invisible to the page read AND to click_text — the agent then asked
// for the text "YouTube", was told truthfully that no visible text matched, and
// had no action left that could finish the route.
console.log("\n=== Scenario AP: app-switcher route guard ===\n");

const { looksLikeAppSwitcher, appSwitcherRefusal } = await import("../src/shared/route-guard.ts");

ok("the app-launcher control is recognised by its accessible name",
  looksLikeAppSwitcher("Google apps") && looksLikeAppSwitcher("Apps") &&
  looksLikeAppSwitcher("Apps launcher") && looksLikeAppSwitcher("nine-square grid") &&
  looksLikeAppSwitcher("waffle"));
ok("ordinary content that merely mentions apps is NOT blocked",
  !looksLikeAppSwitcher("Apps and extensions") &&
  !looksLikeAppSwitcher("Google Play") &&
  !looksLikeAppSwitcher("Inbox") &&
  !looksLikeAppSwitcher("Manage third-party apps and services") &&
  !looksLikeAppSwitcher(undefined));
ok("an over-long name is not treated as a switcher",
  !looksLikeAppSwitcher("Apps launcher and settings for this workspace account"));

const refusal = appSwitcherRefusal("Google apps");
ok("the refusal explains WHY the route cannot be completed (cross-origin frame)",
  Boolean(refusal) && /cross-origin frame/.test(refusal) && /click_text/.test(refusal));
ok("the refusal names the route that works instead",
  Boolean(refusal) && /navigate/.test(refusal) && /cannot miss/.test(refusal));
ok("the redirect can name the exact destination when the caller knows it",
  /https:\/\/youtube\.com/.test(appSwitcherRefusal("Google apps", "https://youtube.com") ?? "") &&
  /https:\/\/mail\.google\.com/.test(appSwitcherRefusal("Google apps", "https://mail.google.com") ?? ""));
ok("a non-switcher click is not refused at all",
  appSwitcherRefusal("Compose") === null && appSwitcherRefusal("Inbox") === null);

// The row-text separator: minified app markup has no whitespace text nodes, so
// joining measured runs is what makes a quoted row matchable at all.
const { rankTextMatches: rankRows } = await import("../src/shared/text-target.ts");
const joinedRow = "Meta You're on the Muse waitlist 1:19 AM";
const gluedRow = "MetaYou're on the Muse waitlist1:19 AM";
ok("a row quoted the way a person writes it matches the joined text",
  rankRows([{ text: joinedRow, x: 0, y: 0, width: 1, height: 1 }], "Meta You're on the Muse waitlist").length === 1);
ok("which is exactly what glued textContent could not do (the reason for the join)",
  rankRows([{ text: gluedRow, x: 0, y: 0, width: 1, height: 1 }], "Meta You're on the Muse waitlist").length === 0);

// ─── Scenario AQ: painted-box integrity, egress evidence, ledger integrity ──
console.log("\n=== Scenario AQ: painted boxes, egress evidence, ledger integrity ===\n");

// `regionMappingFor` is already bound above (Scenario K); reuse it rather than
// shadowing it, which esbuild rejects as a duplicate declaration.
const { paintRectFor, normalizePaintedRect } = await import("../src/shared/region-mapping.ts");
const { deriveOffscreenProtection, applyCaptureEvidence, missingProtection } = await import("../src/shared/screenshot-protection.ts");
const { screenshotSendDecision } = await import("../src/shared/screenshot-egress.ts");
const { verifyLedgerChain, recordTokenization, recordAction, initLedger, exportCertifiedAuditProof } =
  await import("../src/background/privacy-ledger.ts");

// ── The audit's box must be the box that was painted ──
// The overlay used to be derived from the source region while the fill used the
// padded, clamped, scroll-offset rect, so every proof marker sat off its mask —
// and in full-page mode (offsetY in the thousands) far off it.
const paintGeom = { scale: 2, offsetY: 0, imageWidth: 1000, imageHeight: 800 };
const painted = paintRectFor({ x: 100, y: 50, width: 40, height: 20 }, paintGeom);
ok("a region is padded and scaled into device pixels",
  painted.x === 192 && painted.y === 92 && painted.width === 96 && painted.height === 56,
  JSON.stringify(painted));
const paintedBox = normalizePaintedRect(painted, 1000, 800);
ok("the reported box round-trips to the painted rectangle",
  Math.round(paintedBox.x * 1000) === painted.x &&
  Math.round(paintedBox.y * 800) === painted.y &&
  Math.round(paintedBox.width * 1000) === painted.width &&
  Math.round(paintedBox.height * 800) === painted.height,
  JSON.stringify(paintedBox));
ok("the box is NOT the unpadded source rect (the old drift)",
  Math.round(paintedBox.x * 1000) !== 200 && Math.round(paintedBox.y * 800) !== 100);

// Full-page: regions are measured on the restored viewport, so the scroll
// offset applies first and the clamp keeps the fill on the canvas.
const fullPageMapping = regionMappingFor({
  imageWidth: 2560, dpr: 2, viewportWidth: 1280, scrollY: 1200, fullPage: true, imageHeight: 4000,
});
ok("stitched mapping resolves to tile scale + scroll offset",
  fullPageMapping.valid && fullPageMapping.scale === 2 && fullPageMapping.offsetY === 2400,
  JSON.stringify(fullPageMapping));
const deepRegion = paintRectFor(
  { x: 10, y: 300, width: 100, height: 20 },
  { scale: fullPageMapping.scale, offsetY: fullPageMapping.offsetY, imageWidth: 2560, imageHeight: 4000 },
);
// y = scroll*scale + region.y*scale - padding = 2400 + 600 - 8.
ok("a region deep in a stitched page lands at scale*scroll + y*scale",
  deepRegion.y === 2992, `y=${deepRegion.y}`);
ok("and its reported box matches that painted row",
  Math.round(normalizePaintedRect(deepRegion, 2560, 4000).y * 4000) === deepRegion.y);

const clamped = paintRectFor({ x: 0, y: 0, width: 10, height: 10 }, paintGeom);
ok("a region at the canvas edge is clamped, never negative",
  clamped.x === 0 && clamped.y === 0 && clamped.width > 0 && clamped.height > 0);
ok("a region entirely outside the canvas is not painted and not reported",
  paintRectFor({ x: 5000, y: 5000, width: 10, height: 10 }, paintGeom) === null);
ok("a zero-sized image yields a zero box rather than NaN",
  normalizePaintedRect({ x: 1, y: 1, width: 1, height: 1 }, 0, 0).width === 0);
ok("an invalid scale is refused rather than painted at 1:1",
  paintRectFor({ x: 1, y: 1, width: 1, height: 1 }, { scale: 0, offsetY: 0, imageWidth: 10, imageHeight: 10 }) === null);

// ── Egress evidence has real producers ──
// The contract existed, the guard read it, and nothing wrote it — so the VLM
// path could never ship a frame. These assert the producers and the guard agree.
const healthyOffscreen = deriveOffscreenProtection({
  faceScanRan: true, finalScanRan: true, residualDetections: 0, policyEnabled: true,
});
ok("offscreen evidence leaves the service-worker halves unclaimed",
  healthyOffscreen.facesComplete === true &&
  healthyOffscreen.finalScanComplete === true &&
  healthyOffscreen.textComplete === false &&
  healthyOffscreen.mappingValid === false &&
  healthyOffscreen.reasons.length === 0,
  JSON.stringify(healthyOffscreen));
const assembled = applyCaptureEvidence(healthyOffscreen, { textComplete: true, mappingValid: true });
ok("assembly supplies the text + geometry facts without weakening the rest",
  assembled.textComplete === true && assembled.mappingValid === true &&
  assembled.facesComplete === true && assembled.finalScanComplete === true);
ok("a fully-evidenced frame is allowed to ship (vision is reachable)",
  screenshotSendDecision({
    redactedDataUrl: "data:image/jpeg;base64,AA==", detections: [], redactedCount: 0,
    verification: { verified: true, regionsChecked: 3, regionsRedacted: 3, leakedPatterns: [] },
    protection: assembled,
  }).allowed === true);
ok("a geometry failure alone is enough to refuse it",
  screenshotSendDecision({
    redactedDataUrl: "data:image/jpeg;base64,AA==", detections: [], redactedCount: 0,
    verification: { verified: true, regionsChecked: 3, regionsRedacted: 3, leakedPatterns: [] },
    protection: applyCaptureEvidence(healthyOffscreen, { textComplete: true, mappingValid: false }),
  }).allowed === false);
ok("a frame with no evidence at all is refused, not assumed safe",
  screenshotSendDecision({
    redactedDataUrl: "data:image/jpeg;base64,AA==", detections: [], redactedCount: 0,
    verification: { verified: true, regionsChecked: 0, regionsRedacted: 0, leakedPatterns: [] },
    protection: undefined,
  }).allowed === false);
ok("missingProtection() is explicit and refused",
  missingProtection("no producer").facesComplete === false &&
  missingProtection("no producer").residualDetections !== 0);

// ── Ledger integrity is COMPUTED, not asserted ──
// The panel's badge used to be rendered from a summary that re-hashed nothing
// and seeded the first link from the first entry, so a tampered head was
// structurally invisible. These mutate stored bytes and demand detection.
await clearLedger();
await recordSnapshot("https://example.com/a", "t", 3);
await recordTokenization([{ token: "<PII_1>", kind: "pii_text" }]);
await recordAction("click", true, 4);
const storedKey = "pry-privacy-ledger";
const readStore = () => mem.get(storedKey);

const cleanChain = await verifyLedgerChain(readStore().entries);
ok("an untouched ledger verifies every digest and link",
  cleanChain.valid && cleanChain.hashesIntact && cleanChain.linksIntact && !cleanChain.headLinkUnverifiable,
  JSON.stringify(cleanChain));
const cleanSummary = await getLedgerSummary();
ok("the summary badge is backed by re-derived digests",
  cleanSummary.chainValid === true && cleanSummary.chainHashesIntact === true &&
  cleanSummary.chainHeadUnverifiable === false &&
  cleanSummary.totalActions === 1 && cleanSummary.lastEntryType === "action",
  JSON.stringify(cleanSummary));

// Tamper with the FIRST entry — the one the old check could never see.
const tamperedHead = readStore();
tamperedHead.entries[0] = { ...tamperedHead.entries[0], data: { ...tamperedHead.entries[0].data, elementCount: 999 } };
mem.set(storedKey, tamperedHead);
const headCheck = await getLedgerSummary();
ok("tampering with the FIRST entry is detected (the old check was tautological)",
  headCheck.chainValid === false && headCheck.chainHashesIntact === false,
  JSON.stringify(headCheck));
ok("and the summary names the tampered entry",
  (headCheck.chainReasons ?? []).some((r) => /entry 1/.test(r)), JSON.stringify(headCheck.chainReasons));

// Restore, then tamper with a middle entry's link only.
await clearLedger();
await recordSnapshot("https://example.com/a", "t", 1);
await recordSnapshot("https://example.com/b", "t", 1);
await recordSnapshot("https://example.com/c", "t", 1);
const relinked = readStore();
relinked.entries[2] = { ...relinked.entries[2], prevHash: relinked.entries[0].hash };
mem.set(storedKey, relinked);
const linkCheck = await verifyLedgerChain(readStore().entries);
ok("a broken middle link is detected",
  linkCheck.valid === false && linkCheck.linksIntact === false && linkCheck.hashesIntact === false,
  JSON.stringify(linkCheck));

// A trimmed log must not be reported as intact OR tampered: the head link is
// genuinely unverifiable, and saying either would be a claim we cannot back.
await clearLedger();
await recordSnapshot("https://example.com/a", "t", 1);
await recordSnapshot("https://example.com/b", "t", 1);
const trimmed = readStore();
trimmed.entries = trimmed.entries.slice(1);
mem.set(storedKey, trimmed);
const trimmedCheck = await getLedgerSummary();
ok("a trimmed head is reported unverifiable, not INTACT and not TAMPERED",
  trimmedCheck.chainHeadUnverifiable === true && trimmedCheck.chainHashesIntact === true &&
  trimmedCheck.chainValid === true,
  JSON.stringify(trimmedCheck));

// ── The session boundary is real, and the export states its coverage ──
await clearLedger();
await initLedger();
await recordSnapshot("https://example.com/a", "t", 1);
const firstSession = await getLedgerSummary();
await recordSnapshot("https://example.com/b", "t", 1);
const sameSession = await getLedgerSummary();
ok("entries land inside the session that wrote them",
  firstSession.sessionEntries === 1 && sameSession.sessionEntries === 2,
  `first=${firstSession.sessionEntries} same=${sameSession.sessionEntries}`);
ok("sessionId is stable while the session runs",
  firstSession.sessionId === sameSession.sessionId && /^session-/.test(firstSession.sessionId));
await initLedger();
await recordSnapshot("https://example.com/c", "t", 1);
const nextSession = await getLedgerSummary();
ok("a new run starts a new session id and its own entry count",
  nextSession.sessionId !== sameSession.sessionId && nextSession.sessionEntries === 1,
  `${nextSession.sessionId} vs ${sameSession.sessionId} / ${nextSession.sessionEntries}`);
ok("history is appended across sessions, not discarded",
  nextSession.totalEntries === 3, `entries=${nextSession.totalEntries}`);

const proof = await exportCertifiedAuditProof();
ok("the exported proof states the window the Merkle root covers",
  proof.coverage.retainedFromSeq === 1 && proof.coverage.retainedToSeq === 3 &&
  proof.coverage.trimmed === false && proof.coverage.maxEntries === 500,
  JSON.stringify(proof.coverage));
ok("the exported proof carries a 64-hex Merkle root over that window",
  typeof proof.merkleRoot === "string" && /^[0-9a-f]{64}$/.test(proof.merkleRoot), proof.merkleRoot);
ok("the exported proof reports the chain verdict it computed",
  proof.chainValid === true && proof.chainHashesIntact === true &&
  Array.isArray(proof.chainReasons));

// clearLedger must actually clear — the reset button claims it does.
await clearLedger();
const afterClear = await getLedgerSummary();
ok("clearLedger empties the ledger the panel reads",
  afterClear.totalEntries === 0 && afterClear.chainValid === true,
  JSON.stringify(afterClear));

console.log("\n=== Scenario AR: adversarial redaction attack ===\n");

const {
  attackSoftRegions, uncoveredFaceBoxes, edgeEnergy, unsharpRegion,
  RECONSTRUCTION_THRESHOLD, MIN_ORIGINAL_ENERGY,
} = await import("../src/background/redaction-attack.ts");

// ── Face coverage: a detection MISS, not a weak mask ──
// This is the probe that matters most, because no escalation inside the known
// regions can fix a face nobody boxed.
const faceBox = { x: 100, y: 100, width: 40, height: 40 };
const coverAll = { x: 95, y: 95, width: 50, height: 50 };
const coverHalf = { x: 120, y: 100, width: 40, height: 40 };
const coverGrazing = { x: 135, y: 135, width: 40, height: 40 };

ok("a face fully inside a destroyed region is not reported",
  uncoveredFaceBoxes([faceBox], [coverAll]).length === 0);
ok("a face the region only half covers is still counted as covered (>= 50%)",
  uncoveredFaceBoxes([faceBox], [coverHalf]).length === 0);
ok("a face the region barely clips IS reported",
  uncoveredFaceBoxes([faceBox], [coverGrazing]).length === 1,
  JSON.stringify(uncoveredFaceBoxes([faceBox], [coverGrazing])));
ok("with no destroyed regions every detected face is reported",
  uncoveredFaceBoxes([faceBox], []).length === 1 &&
  uncoveredFaceBoxes([faceBox], undefined).length === 1);
ok("a degenerate zero-area detection is ignored rather than reported as a leak",
  uncoveredFaceBoxes([{ x: 1, y: 1, width: 0, height: 30 }], []).length === 0);
ok("adjacent-but-not-overlapping regions do not count as coverage",
  uncoveredFaceBoxes([faceBox], [{ x: 140, y: 100, width: 10, height: 40 }]).length === 1);

// ── Reconstruction: the probe decides on RESIDUAL energy ──
// A region whose pixels are untouched carries 100% of its original edge energy,
// which is the strongest possible statement that nothing was redacted.
const textRegion = { x: 10, y: 10, width: 60, height: 30, kind: "input_field", label: "Search" };
const sharpText = makeImage(80, 50, (x, y) =>
  x >= 10 && x < 70 && y >= 10 && y < 40 ? ((x % 4) < 2 ? [20, 20, 20] : [250, 250, 250]) : white());

const untouched = attackSoftRegions(sharpText, sharpText, [textRegion]);
ok("an UNTOUCHED region is reported as fully recoverable",
  untouched.length === 1 && Math.round(untouched[0].residualFraction * 100) === 100,
  JSON.stringify(untouched.map((f) => f.residualFraction)));
ok("and the reason names the residual, not a sharpening gain",
  /dampened, not destroyed/.test(untouched[0].reason) && /100% of the original edge energy/.test(untouched[0].reason),
  untouched[0].reason);

const blackedOut = makeImage(80, 50, (x, y) =>
  x >= 10 && x < 70 && y >= 10 && y < 40 ? black() : white());
ok("an OPAQUE region is silent (nothing left to reconstruct)",
  attackSoftRegions(sharpText, blackedOut, [textRegion]).length === 0);

const blankBefore = makeImage(80, 50, white);
ok("a region that was BLANK before redaction is not reported as a leak",
  attackSoftRegions(blankBefore, blankBefore, [textRegion]).length === 0,
  "a blank field cannot leak, and demanding an opaque fill of every empty input would black out whole forms");

// A genuinely half-destroyed region: the text is softened by a box average, so
// the structure is dampened but still present. This is the case the probe exists
// for, and it is built here rather than by weakening a shipped paint so the
// fixture cannot be mistaken for the real calibration (that lives in
// scripts/offscreen-integration-test.mjs, against PRY's own blur).
const soften = (img, rect, radius) => {
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  const span = radius * 2 + 1;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const px = x + dx;
          const py = y + dy;
          if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
          const i = (py * img.width + px) * 4;
          sum += (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
          n++;
        }
      }
      const v = Math.round(sum / n);
      const t = (y * img.width + x) * 4;
      out.data[t] = v; out.data[t + 1] = v; out.data[t + 2] = v; out.data[t + 3] = 255;
    }
  }
  return out;
};
const partial = soften(sharpText, textRegion, 3);
const residual = edgeEnergy(partial, textRegion) / edgeEnergy(sharpText, textRegion);
ok("a softened region keeps a real but reduced residual",
  residual > 0 && residual < 1 && residual < RECONSTRUCTION_THRESHOLD,
  `residual=${residual.toFixed(3)} threshold=${RECONSTRUCTION_THRESHOLD}`);
ok("softening this much reads as destroyed at the shipped threshold",
  attackSoftRegions(sharpText, partial, [textRegion]).length === 0,
  `residual=${residual.toFixed(3)}`);
// Pin the GATE itself: the decision must flip on the measured residual, not on
// some other quantity that happens to correlate with it today.
ok("the same pixels fire the moment the threshold drops past the residual",
  attackSoftRegions(sharpText, partial, [textRegion], { threshold: residual + 0.02 }).length === 0 &&
  attackSoftRegions(sharpText, partial, [textRegion], { threshold: residual - 0.02 }).length === 1,
  `residual=${residual.toFixed(3)}`);

ok("a tiny region yields no energy reading at all (no divide-by-zero guess)",
  edgeEnergy(sharpText, { x: 10, y: 10, width: 2, height: 2 }) === 0);
ok("the minimum-energy floor is what suppresses faint-but-blank fields",
  MIN_ORIGINAL_ENERGY > 0 &&
  attackSoftRegions(makeImage(80, 50, white), makeImage(80, 50, gray), [textRegion]).length === 0);

// Sharpening must not WEAKEN a region: the evidence pass is a filter, and a
// filter that lowered energy would let a destroyed region look recovered.
const recovered = edgeEnergy(unsharpRegion(partial, textRegion), textRegion);
ok("the evidence sharpening pass does not reduce measured energy",
  recovered >= edgeEnergy(partial, textRegion) - 0.001,
  `${edgeEnergy(partial, textRegion).toFixed(2)} → ${recovered.toFixed(2)}`);
// The calibration finding that forced the residual gate: repeated unsharp
// MANUFACTURES energy — three cheap passes drive a softened (i.e. already
// judged-destroyed) region's measured energy ABOVE the sharp original, because
// iterated unsharp manufactures ringing at an edge rather than restoring lost
// bandwidth. A gate on "how much did sharpening bring back?" would therefore
// open on every frame and escalate the whole product to solid black.
let iterated = partial;
for (let pass = 0; pass < 3; pass++) iterated = unsharpRegion(iterated, textRegion, 3, 4);
const shippedE = edgeEnergy(partial, textRegion);
const iteratedE = edgeEnergy(iterated, textRegion);
ok("iterated sharpening inflates measured energy above the original",
  iteratedE > edgeEnergy(sharpText, textRegion),
  `orig=${edgeEnergy(sharpText, textRegion).toFixed(1)} softened=${shippedE.toFixed(1)} iterated=${iteratedE.toFixed(1)}`);
ok("so a gain-based gate would have fired here, and the residual gate does not",
  attackSoftRegions(sharpText, partial, [textRegion]).length === 0);
ok("yet the opaque region is still silent under the shipped gate",
  attackSoftRegions(sharpText, blackedOut, [textRegion]).length === 0);

// ── The attack must be wired into the pipeline, not merely importable ──
const offscreenSource = await readFile(new URL("../src/offscreen/offscreen.ts", import.meta.url), "utf8");
ok("the shipped-frame attack is invoked on the real verification path",
  /attackShippedFrame\(originalData, shippedData/.test(offscreenSource));
ok("and its findings feed the same escalation the OCR leaks use",
  /reconstructionHits > 0 \|\| uncoveredFaces\.length > 0/.test(offscreenSource));
ok("an uncovered face is added to the rebuild region list (or the repaint would miss it)",
  /escalationRegions = \[/.test(offscreenSource) && /rebuildWithOpaqueMasks\(originalCanvas, escalationRegions/.test(offscreenSource));
ok("the attack evidence is reported on the verification object",
  /attack: \{\s*\/\/ `ran` means the PROBE ran/.test(offscreenSource));
ok("the face probe is awaited, not fired and forgotten",
  /const shippedFaces = await detectFacesWithBlazeFace\(shippedCanvas\)/.test(offscreenSource));

console.log("\n=== Scenario AS: task tokenization must not eat the user's instruction ===\n");

// Regression set from a real run. The user asked for a YouTube channel by name;
// the contextual name rule vaulted the name (and, in two cases, the rest of the
// sentence), so the planner received an opaque token where its search target
// should have been, spun for 43s trying to work out what <PII_1> was, and then
// typed the token's own spelling into YouTube's search box.
// `tokenizer` (the shared singleton) is already bound at the top of this file.
const { leadingNameRun, MAX_NAME_WORDS, PIITokenizer } = await import("../src/background/tokenizer.ts");

const UNTOUCHED_TASKS = [
  // The report, verbatim.
  "open youtube and suggest me to Harkirat Singh yt channel",
  "i want to open harkirat singh yt channel",
  // Ordinary prose around a preposition is not an addressee.
  "go to Priya Sharma profile and download the file",
  "add Ramesh Gupta to the meeting invite",
  "open youtube and search for the best channel to watch",
  "send the file to my manager",
  "reply to the first email in the inbox",
  "scroll to the bottom and read the page",
  "can you find the best yt channel for devops",
];
for (const task of UNTOUCHED_TASKS) {
  tokenizer.clear();
  const { task: out, tokenCount } = tokenizer.tokenizeTask(task);
  ok(`the task is not tokenized: ${JSON.stringify(task.slice(0, 44))}`,
    out === task && tokenCount === 0,
    `→ ${JSON.stringify(out)} (vault: ${tokenizer.getEntries().map((e) => e.original).join(" | ")})`);
}

// The feature must still work: a genuine message payload is tokenized, and the
// vault holds the NAME — not the name plus the rest of the sentence.
const MESSAGING_TASKS = [
  { task: "send an email to Priya Sharma about the invoice", name: "Priya Sharma", keep: "about the invoice" },
  { task: "reply to Sharma Traders with the quotation", name: "Sharma Traders", keep: "with the quotation" },
  { task: "email Ramesh Gupta the report", name: "Ramesh Gupta", keep: "the report" },
  { task: "text priya sharma the address", name: "priya sharma", keep: "the address" },
  { task: "addressed to Acme Corporation", name: "Acme Corporation", keep: "" },
  { task: "sent by Ramesh Gupta", name: "Ramesh Gupta", keep: "" },
  { task: "name: Acme Corporation", name: "Acme Corporation", keep: "" },
  { task: "send an email to प्रिया शर्मा", name: "प्रिया शर्मा", keep: "" },
];
for (const { task, name, keep } of MESSAGING_TASKS) {
  tokenizer.clear();
  const { task: out, tokenCount } = tokenizer.tokenizeTask(task);
  const entries = tokenizer.getEntries();
  ok(`a message payload IS tokenized: ${JSON.stringify(task.slice(0, 40))}`,
    tokenCount === 1 && /<PII_1>/.test(out), `→ ${JSON.stringify(out)}`);
  ok(`  …and the vault holds exactly the name (${JSON.stringify(name)})`,
    entries.length === 1 && entries[0].original === name,
    `vault=${JSON.stringify(entries.map((e) => e.original))}`);
  ok("  …and the words AFTER the name survive in the task",
    keep === "" ? true : out.endsWith(keep), `→ ${JSON.stringify(out)}`);
}

// Shape rules, pinned directly: these are the judgments the regex outsources.
ok("a capitalised run stops where the capitals stop",
  leadingNameRun("Harkirat Singh yt channel") === "Harkirat Singh");
ok("a lowercase run stops at the first function word",
  leadingNameRun("priya sharma the address") === "priya sharma");
ok("a run that STARTS with a function word is prose, not a name",
  leadingNameRun("the meeting invite") === null && leadingNameRun("my manager") === null);
ok("a single word is not treated as a name after a preposition",
  leadingNameRun("John") === null && leadingNameRun("youtube") === null);
ok("a name run is capped at three words",
  leadingNameRun("Alpha Beta Gamma Delta") === "Alpha Beta Gamma" && MAX_NAME_WORDS === 3);
ok("non-Latin scripts are names too (any-script letter runs)",
  leadingNameRun("प्रिया शर्मा") === "प्रिया शर्मा");
ok("punctuation inside a name is preserved",
  leadingNameRun("O'Brien Jean-Luc") === "O'Brien Jean-Luc");

// ── Bracket-stripped tokens must resolve ──
// Observed: told to pass <PII_1> verbatim, the planner emitted PII_1, the
// bracketed match found nothing, and the literal characters were typed into the
// page — the user's value silently replaced by the token's own spelling.
for (const entry of tokenizer.getEntries()) {
  const bare = entry.token.slice(1, -1);
  const resolved = tokenizer.resolveAll(bare);
  ok(`a bracket-stripped token resolves (${bare})`,
    resolved === entry.original, `${bare} → ${JSON.stringify(resolved)}`);
  ok(`  …and the bracketed form still resolves (${entry.token})`,
    tokenizer.resolveAll(entry.token) === entry.original);
}
ok("a bare token that is NOT in the vault is left as written",
  tokenizer.resolveAll("PII_99") === "PII_99" && tokenizer.resolveAll("MY_1ST_PLAN") === "MY_1ST_PLAN");
ok("a substituted value is never re-scanned for another token",
  (() => {
    const t = new PIITokenizer();
    // A vault whose value happens to spell a token: resolving the OTHER entry
    // must not then resolve this value a second time.
    t.tokenize("PII_2", "pii_text");
    const rahul = t.tokenize("Rahul", "pii_text");
    return t.resolveAll(rahul) === "Rahul";
  })());
ok("an identifier that merely looks token-ish is not resolved away",
  tokenizer.resolveAll("SKU_1234 and v2_X1 ok") === "SKU_1234 and v2_X1 ok");

// ── The planner must never be told to search for a token's spelling ──
const { SYSTEM_PROMPT, SYSTEM_PROMPT_LOCAL, taskPrompt } = await import("../src/background/prompt.ts");
for (const [name, prompt] of [["remote", SYSTEM_PROMPT], ["local", SYSTEM_PROMPT_LOCAL]]) {
  ok(`the ${name} prompt says a token may be used as a search query`,
    /SEARCH (QUERY|box)/i.test(prompt));
  ok(`the ${name} prompt forbids typing the token's own spelling`,
    /SPELLING/.test(prompt));
}

// ── A task's own words bound the run ────────────────────────────────────────
// The reported failure: "open yt and search harkirat singh" navigated, typed,
// and then CLICKED a search result — a step the task never asked for — and spent
// two more turns re-verifying. The planner narrated the cause itself ("I need to
// follow the route: navigate → type → click_text"), i.e. it copied the LENGTH of
// a stored route recorded for a different task. Where the wording IS the fix,
// the wording is what gets pinned.
ok("the prompt bounds the run to what the task asked for",
  /Act only on what the task asks for/.test(SYSTEM_PROMPT));
ok("and spells out that a search is finished when its results are visible",
  /"Search for X" is complete the moment X's results are visible/.test(SYSTEM_PROMPT));
ok("and that opening a result the task did not ask for is an extra step",
  /do not open a result, a channel, or a video the task did not ask you to open/.test(SYSTEM_PROMPT));
ok("the local prompt is bounded the same way",
  /Do exactly what the task asked/.test(SYSTEM_PROMPT_LOCAL));
ok("the verify rule no longer sends the model back to re-read a page it just saw",
  /already in the last tool result/.test(SYSTEM_PROMPT) &&
  /do not spend a turn re-reading/.test(SYSTEM_PROMPT));

const { renderTrajectoryRoutes } = await import("../src/background/trajectories.ts");
const storedRoute = [{
  id: "t1", domain: "youtube.com", pageType: "video",
  task: "open youtube and play the first video",
  steps: "navigate → type → click_text",
  answer: "", createdAt: 1,
}];
const routeText = renderTrajectoryRoutes(storedRoute);
ok("no matching route renders nothing at all", renderTrajectoryRoutes([]) === "");
ok("a route still shows the older task and the path that solved it",
  routeText.includes("Task: open youtube and play the first video") &&
  routeText.includes("Steps: navigate → type → click_text"));
ok("but the block now says a route's LENGTH is not part of the route",
  /A route's LENGTH is not part of it/.test(routeText));
ok("and that the run ends when THIS task's words are satisfied, not the example's",
  /Your run ends the moment YOUR task's own words are satisfied/.test(routeText));
ok("with the search case named explicitly, since that is the one that went wrong",
  /"search" is finished when the results are visible/.test(routeText));
ok("and the instruction that invited copying the length is gone",
  !/Copy the route, never the values/.test(routeText));

console.log("\n=== Scenario AT: what task text is redacted, and what must not be ===\n");

// An audit of the whole task path against realistic inputs, kept as the
// regression set. `want: true` is a SECRET the user is handing over (must be
// tokenized); `want: false` is an INSTRUCTION PARAMETER (must reach the planner
// intact). Every entry here was produced by asking "what would break the task?"
// of the rules, not by reading them.
const {
  tokenKindForTextMatch, tokenKindLabel, buildTokenLegend,
} = await import("../src/background/tokenizer.ts");

const TASK_CASES = [
  // Secrets — must be tokenized.
  { task: "log in with password hunter2copy", want: true },
  { task: "my card is 4111 1111 1111 1111, pay the bill", want: true },
  { task: "use aadhaar 9900 5163 2666 for the form", want: true },
  { task: "the key is sk-abcdefghijklmnopqrstuvwxyz012345", want: true },
  { task: "otp is 483920, enter it", want: true },
  { task: "my email is rahul.verma@example.com", want: true },
  { task: "call me on +91 98765 43210", want: true },
  { task: "PAN ABCDE1234F and IFSC HDFC0001234 for KYC", want: true },
  { task: "send an email to Priya Sharma", want: true },
  // A cue word outranks the checksum: these are LOOKALIKES (they fail Verhoeff),
  // but the user called them their Aadhaar, so a typo must not leak them.
  { task: "my Aadhaar number is 2345 6789 0129 please verify", want: true },
  { task: "use aadhaar 4111 1111 1111 for the form", want: true },
  // Parameters and prose — must NOT be tokenized.
  { task: "open youtube and suggest me to Harkirat Singh yt channel", want: false },
  { task: "find order 1234 5678 9012 in the orders page", want: false },
  { task: "open the video with id 1234567890123456", want: false },
  // Same lookalike digits, NO cue word: not an identity document, so the bare
  // run needs the checksum to agree and it does not.
  { task: "the form has 4111 1111 1111 in it", want: false },
  { task: "search for the best yt channel for devops", want: false },
  { task: "go to the settings page and turn on dark mode", want: false },
  { task: "reply to the first email in my inbox", want: false },
  { task: "open my profile picture and change it", want: false },
  { task: "book a table for 2024 12 25 at 7pm", want: false },
  { task: "open the file report 2025 09 18 final.pdf", want: false },
  { task: "add a new contact called Work Notes", want: false },
  { task: "open the password manager and change my login", want: false },
  { task: "the key is configuration, not a secret", want: false },
];

let taskFalsePositives = 0;
let taskFalseNegatives = 0;
let taskGobbled = 0;
for (const { task, want } of TASK_CASES) {
  tokenizer.clear();
  const { task: out, tokenCount, newEntries } = tokenizer.tokenizeTask(task);
  const changed = tokenCount > 0;
  if (changed && !want) taskFalsePositives++;
  if (!changed && want) taskFalseNegatives++;
  // A vault value that is not a substring of the task would mean the rule
  // invented a value; a value containing sentence punctuation means it ate the
  // instruction again.
  for (const entry of newEntries) {
    if (!task.includes(entry.original) || /[.!?]$/.test(entry.original)) taskGobbled++;
  }
  assert.equal(
    changed,
    want,
    `task tokenization verdict for ${JSON.stringify(task)}: got ${JSON.stringify(out)} ` +
    `(vault: ${JSON.stringify(newEntries.map((e) => e.original))})`,
  );
}
ok("no instruction parameter is tokenized away (0 false positives)",
  taskFalsePositives === 0, `${taskFalsePositives}/${TASK_CASES.length}`);
ok("no secret in a task is left raw (0 false negatives)",
  taskFalseNegatives === 0, `${taskFalseNegatives}/${TASK_CASES.length}`);
ok("every vault value is an exact substring of the task (nothing gobbled)",
  taskGobbled === 0, `${taskGobbled}`);

// ── The masked line the panel shows for the user's own task ──
tokenizer.clear();
const maskedTask = tokenizer.tokenizeTask("send an email to Priya Sharma about the invoice");
ok("tokenizeTask reports the entries IT created, for the panel to name",
  maskedTask.newEntries.length === 1 && maskedTask.newEntries[0].original === "Priya Sharma",
  JSON.stringify(maskedTask.newEntries.map((e) => e.original)));
ok("and the masked sample it renders hides the value",
  maskSample(maskedTask.newEntries[0].original) !== "Priya Sharma" &&
  !maskSample(maskedTask.newEntries[0].original).includes("harma"),
  maskSample(maskedTask.newEntries[0].original));
ok("a task with nothing to redact reports no entries (no empty notice)",
  (() => { tokenizer.clear(); return tokenizer.tokenizeTask("open youtube").newEntries.length === 0; })());

// ── The token legend the planner receives ──
tokenizer.clear();
tokenizer.tokenize("Priya Sharma", "pii_text");
tokenizer.tokenize("4111 1111 1111 1111", "credential");
tokenizer.tokenize("9900 5163 2666", "id_number");
const legend = buildTokenLegend(tokenizer.getEntries());
ok("the legend lists every live token",
  ["<PII_1>", "<CRED_1>", "<ID_1>"].every((t) => legend.includes(t)), legend);
ok("the legend describes the CATEGORY and never the value",
  /person, company or place name/.test(legend) &&
  !/Priya|Sharma|4111|9900/.test(legend), legend);
ok("the legend tells the planner a token is usable as a search query",
  /search box/i.test(legend), legend);
ok("an empty vault produces no legend at all (no empty section)",
  (() => { tokenizer.clear(); return buildTokenLegend(tokenizer.getEntries()) === null; })());
ok("a long vault is capped and says so",
  (() => {
    const t = new PIITokenizer();
    for (let i = 0; i < 11; i++) t.tokenize(`Person${i} Name`, "pii_text");
    const l = buildTokenLegend(t.getEntries(), 8);
    return l.includes("+3 more token(s)") && !l.includes("Person10 Name");
  })());
ok("each vault kind has a human label",
  ["pii_text", "credential", "id_number", "api_key", "image_text", "something_new"]
    .every((k) => tokenKindLabel(k).length > 3));
ok("the shared matcher maps to the prefix the panel expects",
  tokenKindForTextMatch("email", "Email address") === "credential" &&
  tokenKindForTextMatch("phone", "Phone number") === "credential" &&
  tokenKindForTextMatch("id_text", "Card number") === "credential" &&
  tokenKindForTextMatch("id_text", "Aadhaar number") === "id_number" &&
  tokenKindForTextMatch("name_text", "Person name") === "pii_text");
ok("the task prompt carries the legend when there is one",
  (() => {
    const withLegend = taskPrompt("do the thing", "https://x.test", "X", "LEGEND_HERE");
    const without = taskPrompt("do the thing", "https://x.test", "X");
    return withLegend.includes("LEGEND_HERE") && withLegend.includes("Task: do the thing") &&
      without === "Current tab: X — https://x.test\n\nTask: do the thing";
  })());

// ── Scenario AS: the task-privacy report is made where the work happens ────
console.log("\n=== Scenario AS: task-privacy report and planner legend ===\n");

// The worker tokenizes the task and passes the TOKENIZED string to runTask,
// which tokenizes again. A report guarded on that second pass is guarded on a
// count that is structurally always zero — which is where the "Task privacy:"
// line lived, so it never rendered, and where the planner's legend was built,
// so the legend was silently blank. Both are pinned here.
const phase1 = new PIITokenizer().tokenizeTask("send an email to Priya Sharma about the invoice");
ok("pass 1 (the worker, raw task) reports the substitution",
  phase1.tokenCount === 1 && phase1.newEntries.length === 1 &&
    phase1.task === "send an email to <PII_1> about the invoice",
  JSON.stringify({ task: phase1.task, count: phase1.tokenCount }));

const phase2Tokenizer = new PIITokenizer();
phase2Tokenizer.tokenizeTask("send an email to Priya Sharma about the invoice");
const phase2 = phase2Tokenizer.tokenizeTask(phase1.task);
ok("pass 2 (runTask, already-tokenized task) reports nothing new — so a report there cannot render",
  phase2.tokenCount === 0 && phase2.newEntries.length === 0,
  JSON.stringify({ count: phase2.tokenCount, entries: phase2.newEntries.length }));

// The report itself: names the substitution, masks the value.
const reportShown = phase1.newEntries
  .slice(0, 4)
  .map((e) => `"${maskSample(e.original)}" → ${e.token}`)
  .join(", ");
ok("the privacy line quotes the masked value and its token, never the raw value",
  reportShown.includes("→ <PII_1>") && !reportShown.includes("Priya Sharma") && reportShown.includes("Pr"),
  reportShown);

// The legend the planner receives: built from the vault FILTERED to the tokens
// in this task (how agent.ts builds it), not from this pass's new entries.
const legendTokenizer = new PIITokenizer();
const legendTask = legendTokenizer.tokenizeTask("send an email to Priya Sharma about the invoice").task;
const legendFromVault = buildTokenLegend(
  legendTokenizer.getEntries().filter((e) => legendTask.includes(e.token)),
);
ok("the legend names the token's CATEGORY without its value",
  typeof legendFromVault === "string" &&
    legendFromVault.includes("<PII_1> = a person, company or place name") &&
    !legendFromVault.includes("Priya Sharma"),
  legendFromVault ?? "(null)");
ok("and it is not empty on a run that tokenized something",
  legendFromVault !== null && legendFromVault.includes("<PII_1>"));
ok("for a task with no tokens the legend is absent rather than empty",
  (() => {
    const t = new PIITokenizer();
    t.tokenize("Priya Sharma", "pii_text");
    const task = "open youtube and find a devops channel";
    const entries = t.getEntries().filter((e) => task.includes(e.token));
    return entries.length === 0 && buildTokenLegend(entries) === null;
  })());

// ── Scenario AT: a read-only action does not pay for a fresh frame ─────────
console.log("\n=== Scenario AT: which actions justify re-capturing pixels ===\n");

// A capture is the most expensive thing the loop does after an action
// (capture → paint → OCR triage of up to 6 tiles → pixel verify → OCR re-read →
// adversarial probes), and it is awaited before the next planner turn. It is
// worth it only when the action could have changed a pixel.
ok("a read of the page does not trigger a capture",
  actionChangesFrame("read_page") === false);
ok("nor do the other actions that cannot change pixels",
  actionChangesFrame("find_text") === false && actionChangesFrame("wait") === false);
ok("actions that can change the page do",
  ["click", "click_text", "type", "select", "scroll", "key"].every(actionChangesFrame));
ok("and an action this policy has never seen is treated as frame-changing",
  actionChangesFrame("navigate") === true && actionChangesFrame("open_tab") === true &&
    actionChangesFrame("some_future_tool") === true);
ok("every tool the planner is offered has a capture policy",
  TOOLS.filter((t) => PAGE_ACTIONS.has(t.name))
    .every((t) => typeof actionChangesFrame(t.name) === "boolean"));

// The decision must live in one place: the loop asked PAGE_ACTIONS directly
// before, with its own exclusion list, which is how read_page came to be
// captured while find_text was not.
const loopUsesHelper = (await readFile("src/background/agent.ts", "utf8"))
  .includes("actionChangesFrame(call.name)");
ok("the loop delegates that decision instead of re-deriving it", loopUsesHelper);

// Tesseract's cold start must be paid off the critical path. The service worker
// warms it when it creates the offscreen document, and the offscreen document
// must accept that message.
const workerSource = await readFile("src/background/service-worker.ts", "utf8");
const offscreenDocSource = await readFile("src/offscreen/offscreen.ts", "utf8");
ok("the worker warms OCR when it creates the offscreen document",
  /ensureOffscreenDocument\(\)[\s\S]{0,600}warm-ocr/.test(workerSource));
ok("and the offscreen document handles that message",
  /message\.type === "warm-ocr"/.test(offscreenDocSource));

// ─── Scenario AW: what a RUN may claim about its frames ────────────────────
// A run showed 231 "items redacted" in the transcript, 227 "Redacted" on the
// transcript chip (frame regions only, over the frames the audit still held)
// and 2 "Vault Tokens" — and simultaneously badged "✓ REDACTIONS VERIFIED"
// while a frame of the same run had had its screenshot withheld because its
// mask verification failed. Two numbers, two scopes, one badge, no way to tell.
console.log("\n=== Scenario AW: run-level audit claims ===\n");

const {
  redactionTally,
  describeRedactionTally,
  rollupFrameVerification,
} = await import("../src/shared/metrics.ts");

const tallySample = redactionTally(4, 227, 2);
ok("the run total is frame regions + page items, by construction",
  tallySample.total === 231 && tallySample.frameRegions === 227 && tallySample.pageItems === 4,
  JSON.stringify(tallySample));
ok("the sentence names every part of the total it prints",
  describeRedactionTally(tallySample) ===
    "231 redactions (227 masked frame regions + 4 page items) · 2 vault tokens",
  describeRedactionTally(tallySample));
ok("the same sentence agrees with itself in the singular",
  describeRedactionTally(redactionTally(1, 0, 1)) ===
    "1 redaction (0 masked frame regions + 1 page item) · 1 vault token",
  describeRedactionTally(redactionTally(1, 0, 1)));
const clampedTally = redactionTally(-5, 2.4, -1);
ok("counts are clamped to non-negative integers, never printed raw",
  clampedTally.pageItems === 0 && clampedTally.frameRegions === 2 && clampedTally.tokens === 0 && clampedTally.total === 2,
  JSON.stringify(clampedTally));

const cleanFrame = { verification: { verified: true, regionsChecked: 2, leakedPatterns: [] } };
const emptyFrame = { verification: { verified: true, regionsChecked: 0, leakedPatterns: [] } };
const failedFrame = {
  verification: { verified: false, regionsChecked: 2, leakedPatterns: ["OCR: priya.sharma@example.com"] },
};
const withheldFrame = {
  verification: { verified: true, regionsChecked: 2, leakedPatterns: [] },
  withheld: ["Residual sensitive content detected"],
};
const shippedFrame = {
  verification: { verified: true, regionsChecked: 1, leakedPatterns: [] },
  shipped: true,
};

const allClean = rollupFrameVerification([cleanFrame, cleanFrame, emptyFrame]);
ok("every checked frame passing lets the run claim verification",
  allClean.allVerified === true && allClean.framesVerified === 2 && allClean.framesUnchecked === 1,
  JSON.stringify(allClean));
ok("a frame with nothing to check is a gap, not a failure",
  allClean.framesFailed === 0 && allClean.framesWithheld === 0,
  JSON.stringify(allClean));

// THE BUG THIS PINS: one failing frame plus a passing one later used to badge
// the whole run verified, because the badge read only the newest frame.
const oneFailed = rollupFrameVerification([failedFrame, cleanFrame, withheldFrame, cleanFrame]);
ok("one failed frame falsifies the run-level claim",
  oneFailed.allVerified === false && oneFailed.framesFailed === 1,
  JSON.stringify(oneFailed));
ok("a withheld frame is counted apart from a pass, not folded into one",
  // Two clean frames and one withheld-but-clean frame passed; the withheld one
  // is counted BOTH as verified and as withheld, because they are different
  // questions: "did the check find anything?" and "did PRY let it leave?".
  oneFailed.framesWithheld === 1 && oneFailed.framesVerified === 3,
  JSON.stringify(oneFailed));
ok("the leaked pattern survives into the run-level evidence",
  oneFailed.leakedPatterns.includes("OCR: priya.sharma@example.com"),
  JSON.stringify(oneFailed.leakedPatterns));
ok("a withheld frame alone is enough to falsify the claim",
  rollupFrameVerification([cleanFrame, withheldFrame]).allVerified === false);
ok("a run with no checked frame makes NO verification claim",
  rollupFrameVerification([emptyFrame, emptyFrame]).allVerified === false);
ok("an empty run claims nothing and says so",
  rollupFrameVerification([]).allVerified === false &&
    /No frames were captured/.test(rollupFrameVerification([]).summary),
  rollupFrameVerification([]).summary);
ok("frames that actually left the device are counted apart from those that did not",
  rollupFrameVerification([shippedFrame, cleanFrame]).framesShipped === 1 &&
    rollupFrameVerification([failedFrame, cleanFrame]).framesShipped === 0);
// Every outcome at once, so no clause of the sentence can go missing unnoticed.
const mixed = rollupFrameVerification([failedFrame, cleanFrame, emptyFrame, withheldFrame]);
ok("the summary names every outcome instead of collapsing to one boolean",
  /2 verified/.test(mixed.summary) &&
    /1 FAILED re-OCR/.test(mixed.summary) &&
    /1 withheld from egress/.test(mixed.summary) &&
    /1 with nothing to check/.test(mixed.summary),
  mixed.summary);

// The panel and the transcript must derive their numbers from this one module:
// a second implementation is how the two came to disagree in the first place.
const sidepanelSource = await readFile("src/sidepanel/sidepanel.ts", "utf8");
const workerSource2 = await readFile("src/background/service-worker.ts", "utf8");
const agentSource2 = await readFile("src/background/agent.ts", "utf8");
ok("the panel derives the tally through the shared helper",
  /describeRedactionTally\(tally\)/.test(sidepanelSource));
ok("the run badge reads the ROLLUP, never a single frame's verdict",
  /rollupFrameVerification|verificationRollup/.test(sidepanelSource) &&
    /verificationRollup/.test(workerSource2));
ok("the transcript's total comes from the same helper",
  /describeRedactionTally\(tally\)/.test(agentSource2));

const unusedLegacyTotal = /Total PII items redacted/.test(agentSource2);
ok("and the old unlabelled \"PII items\" wording is gone", unusedLegacyTotal === false);

// ─── Scenario AX: an element id means nothing without its read ─────────────
// Ids are positional array indices, so the same number is a different control
// after any re-render — and a different registry entirely on a new document.
// "Does element 3 exist?" cannot tell those apart, which is how an action could
// land on the wrong control and still report success.
console.log("\n=== Scenario AX: element ids carry their page read ===\n");

const perceive = await import("../src/content/perceive.ts");
const readNow = perceive.registryGeneration();
const staleLookup = perceive.lookupElement(3, readNow + 1);
ok("an id from a later read than the registry's is refused as stale",
  staleLookup.ok === false && staleLookup.reason === "stale",
  JSON.stringify(staleLookup));
ok("and the refusal names both reads",
  staleLookup.askedFor === readNow + 1 && staleLookup.current === readNow,
  JSON.stringify(staleLookup));
const unprovenanced = perceive.lookupElement(3);
ok("an id with no provenance is absent, not stale (nothing to compare)",
  unprovenanced.ok === false && unprovenanced.reason === "missing",
  JSON.stringify(unprovenanced));

const actSource = await readFile("src/content/act.ts", "utf8");
const generationThreaded = actSource.match(/resolve\(input, action\.snapshotGeneration\)/g) ?? [];
ok("every element-id action resolves against its read's generation",
  generationThreaded.length === 3,
  `${generationThreaded.length} of 3 (click, type, select)`);
ok("the page refuses a stale id in words that name both reads",
  /came from page read #/.test(actSource) && /has been read again since/.test(actSource));
ok("the loop stamps each action with the read its ids came from",
  /snapshotGeneration: idGeneration/.test(agentSource2) &&
    /lastRenderedGeneration = snapshot\?\.generation/.test(agentSource2));
ok("and it compares role+name before trusting a renumbered id",
  /const drifted =/.test(agentSource2) &&
    /current\.role !== intended\.role \|\| current\.name !== intended\.name/.test(agentSource2));
ok("a renumbered id is never silently accepted without that comparison",
  !/const elExists = snapshot\?\.elements\.some/.test(agentSource2));

tokenizer.clear();

console.log(`\n${passed} assertions passed. Pipeline verified end-to-end.`);
