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

// D2: face region with real content (skin-tone variance), blurred afterwards
// (simulated by a heavy uniform smear) → verified via the pixel-diff path.
const origD2 = makeImage(40, 40, (x, y) => {
  if (x >= 5 && x < 25 && y >= 5 && y < 25) return ((x + y) % 2 ? [215, 180, 160] : [180, 145, 130]);
  return white();
});
const redD2 = makeImage(40, 40, (x, y) => {
  if (x >= 5 && x < 25 && y >= 5 && y < 25) return [70, 70, 70]; // heavy blur/overlay smear
  return white();
});
const vD2 = verifyRegions(origD2, redD2, [{ x: 5, y: 5, width: 20, height: 20, kind: "face", label: "Face detected" }]);
ok("content region that was blurred verifies via pixel diff", vD2.verified && vD2.regionsRedacted === 1, JSON.stringify(vD2));

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

const { repairTokenConcatenation } = await import("../src/background/tokenizer.ts");
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

// End-to-end: the exact failure from the live Gmail run — "7<CRED_1>" must
// resolve to the bare vault value, not "7shashank@gmail.com".
tokenizer.clear();
tokenizer.tokenize("shashank.tomar.work@gmail.com", "credential");
const repaired = tokenizer.resolveAll(repairTokenConcatenation("7<CRED_1>"));
ok("resolved value contains no digit prefix",
  repaired === "shashank.tomar.work@gmail.com",
  `got ${repaired}`);

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

console.log(`\n${passed} assertions passed. Pipeline verified end-to-end.`);
