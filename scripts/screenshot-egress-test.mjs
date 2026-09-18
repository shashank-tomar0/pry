/**
 * Screenshot egress guard — assertions driven by the REAL producers.
 *
 * This test used to hand-build the `protection` object and assert the guard
 * accepted it. That passed while the feature was dead: nothing in the extension
 * ever produced such an object, so `screenshotSendDecision` refused every frame
 * with "Protection evidence missing" and the VLM never received an image. A test
 * that fabricates the evidence cannot notice that production does not.
 *
 * So the happy path here is assembled the same way the pipeline assembles it —
 * `deriveOffscreenProtection` for the scans the offscreen document witnessed,
 * then `applyCaptureEvidence` for the two facts only the service worker holds —
 * and the assertions cover both directions: that real evidence is accepted, and
 * that every way of failing it is refused.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/** Bundle the three modules under test into one importable ES module. */
const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      export * from "./src/shared/screenshot-egress.ts";
      export * from "./src/shared/screenshot-protection.ts";
    `,
    resolveDir: root,
    sourcefile: "egress-test-entry.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const {
  sendProtectedScreenshot,
  screenshotSendDecision,
  deriveOffscreenProtection,
  applyCaptureEvidence,
  missingProtection,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

let passed = 0;
function ok(name, cond, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  passed++;
  console.log(`  ✓ ${name}`);
}

/** What the offscreen document reports for a healthy frame. */
const healthyOffscreen = () =>
  deriveOffscreenProtection({
    faceScanRan: true,
    finalScanRan: true,
    residualDetections: 0,
    policyEnabled: true,
  });

/** What the service worker contributes for a frame it could verify. */
const verifiedCapture = { textComplete: true, mappingValid: true, reasons: [] };

/** A frame exactly as the pipeline builds it: offscreen half, then assembly. */
function pipelineFrame(overrides = {}) {
  const protection = applyCaptureEvidence(
    overrides.offscreenEvidence ?? healthyOffscreen(),
    overrides.capture ?? verifiedCapture,
  );
  return {
    redactedDataUrl: "data:image/jpeg;base64,AA==",
    detections: [],
    redactedCount: 0,
    // `in` rather than `??`: "no verification at all" is one of the cases under
    // test, and `??` would silently substitute the healthy default for it.
    verification: "verification" in overrides
      ? overrides.verification
      : {
          verified: true,
          regionsChecked: 2,
          regionsRedacted: 2,
          leakedPatterns: [],
        },
    protection,
  };
}

console.log("\n=== screenshot egress: evidence produced by the real pipeline ===\n");

// ── 1. The regression that made vision unreachable ──────────────────────────
// If this fails, the guard is refusing a frame the pipeline actually produced
// and the VLM path is dead again. This is the assertion the old suite lacked.
const good = pipelineFrame();
ok(
  "a frame assembled by the pipeline is allowed to ship",
  screenshotSendDecision(good).allowed === true,
  JSON.stringify(screenshotSendDecision(good).reasons),
);
ok(
  "and its evidence is fully satisfied, not merely non-blocking",
  good.protection.facesComplete === true &&
    good.protection.textComplete === true &&
    good.protection.mappingValid === true &&
    good.protection.finalScanComplete === true &&
    good.protection.residualDetections === 0 &&
    good.protection.policyEnabled === true,
  JSON.stringify(good.protection),
);

let sent = 0;
const send = async () => {
  sent++;
  return "ok";
};
assert.equal((await sendProtectedScreenshot(good, send)).sent, true);
assert.equal(sent, 1, "an allowed frame must reach the network exactly once");
ok("an allowed frame reaches the send callback exactly once", sent === 1);

// ── 2. Absent evidence fails CLOSED ────────────────────────────────────────
const noEvidence = { ...pipelineFrame(), protection: undefined };
const noEvidenceDecision = screenshotSendDecision(noEvidence);
ok("a frame with no protection object is refused", noEvidenceDecision.allowed === false);
ok(
  "and the refusal names the missing evidence",
  noEvidenceDecision.reasons.includes("Protection evidence missing"),
  JSON.stringify(noEvidenceDecision.reasons),
);
ok(
  "missingProtection() is itself a refused frame",
  screenshotSendDecision({ ...pipelineFrame(), protection: missingProtection("test") }).allowed === false,
);

// ── 3. Every offscreen-witnessed scan failure blocks ───────────────────────
const offscreenFailures = [
  ["face scan did not complete", { faceScanRan: false }, "facesComplete"],
  ["final scan did not run", { finalScanRan: false }, "finalScanComplete"],
  ["residual detection survived", { residualDetections: 1 }, "residualDetections"],
  ["required policy disabled", { policyEnabled: false }, "policyEnabled"],
];
for (const [label, bad, flag] of offscreenFailures) {
  const evidence = deriveOffscreenProtection({
    faceScanRan: true,
    finalScanRan: true,
    residualDetections: 0,
    policyEnabled: true,
    ...bad,
  });
  const frame = pipelineFrame({ offscreenEvidence: evidence });
  const decision = screenshotSendDecision(frame);
  ok(`${label} → refused`, decision.allowed === false, JSON.stringify(decision.reasons));
  if (flag === "residualDetections") {
    ok(`  …and residuals are not reported as zero`, frame.protection.residualDetections !== 0);
  } else {
    ok(`  …and ${flag} is false in the evidence`, frame.protection[flag] === false);
  }
}

// ── 4. Every service-worker fact blocks ────────────────────────────────────
for (const [label, capture] of [
  ["DOM text channel incomplete", { textComplete: false, mappingValid: true }],
  ["region→image mapping unverified", { textComplete: true, mappingValid: false }],
]) {
  const frame = pipelineFrame({ capture: { ...capture, reasons: [] } });
  const decision = screenshotSendDecision(frame);
  ok(`${label} → refused`, decision.allowed === false, JSON.stringify(decision.reasons));
}

const withReason = pipelineFrame({
  capture: { textComplete: true, mappingValid: true, reasons: ["dom-targets-unresolved"] },
});
ok(
  "a coverage reason blocks even when every flag is satisfied",
  screenshotSendDecision(withReason).allowed === false,
  JSON.stringify(screenshotSendDecision(withReason).reasons),
);
ok(
  "and that reason reaches the transcript",
  screenshotSendDecision(withReason).reasons.includes("dom-targets-unresolved"),
);

// ── 5. Verification failures block, and reasons dedupe ─────────────────────
for (const [label, verification] of [
  ["mask verification failed", { verified: false, regionsChecked: 2, regionsRedacted: 1, leakedPatterns: ["x"] }],
  ["regions checked ≠ regions redacted", { verified: true, regionsChecked: 2, regionsRedacted: 1, leakedPatterns: [] }],
  ["leaked patterns recorded", { verified: true, regionsChecked: 2, regionsRedacted: 2, leakedPatterns: ["OCR: email"] }],
  ["verification missing", undefined],
]) {
  const frame = pipelineFrame({ verification });
  ok(`${label} → refused`, screenshotSendDecision(frame).allowed === false);
}

const dupReasons = applyCaptureEvidence(healthyOffscreen(), {
  textComplete: false,
  mappingValid: false,
  reasons: ["dup", "dup"],
});
ok(
  "assembly deduplicates reasons",
  dupReasons.reasons.filter((r) => r === "dup").length === 1,
  JSON.stringify(dupReasons.reasons),
);

// ── 5b. One residual is ONE finding, and it names the region ───────────────
// Verbatim from a reported run: "Screenshot withheld: Residual sensitive content
// detected; 1 residual detection(s) survived the redaction pass; Mask verification
// unsuccessful." Three phrases for one region, none of which said WHICH region —
// so the question that decides whether this is a real leak or a mask painted in the
// wrong place had no answer in the transcript. The verifier already produced the
// answer (label, kind and pixel coordinates); it just never left the evidence.
const LEAK = 'PIXEL: "Email address" (credential) at 412,180 was not visibly redacted — original content may still be visible.';
const residualOffscreen = deriveOffscreenProtection({
  faceScanRan: true,
  finalScanRan: true,
  residualDetections: 1,
  residualDetails: [LEAK],
  policyEnabled: true,
});
const withheldFrame = pipelineFrame({
  offscreenEvidence: residualOffscreen,
  verification: { verified: false, regionsChecked: 2, regionsRedacted: 1, leakedPatterns: [LEAK] },
});
const withheld = screenshotSendDecision(withheldFrame);
ok("a residual the verifier already named does not also appear as two generic phrases",
  withheld.reasons.length === 1 &&
  !withheld.reasons.includes("Residual sensitive content detected") &&
  !withheld.reasons.includes("Mask verification unsuccessful"),
  JSON.stringify(withheld.reasons));
ok("and the one reason it does report says which region, with coordinates",
  withheld.reasons[0].includes("PIXEL:") && withdrawnCoordinates(withheld.reasons[0]),
  withheld.reasons[0]);
function withdrawnCoordinates(reason) {
  return /at 412,180/.test(reason) && /Email address/.test(reason);
}
ok("the frame is still refused — naming the region is not a reason to ship it",
  withheld.allowed === false);

// A frame whose verification failed for a DIFFERENT reason must still say so: the
// de-duplication is specifically about the same finding being reported twice, not
// about suppressing mask failures.
const otherFailure = pipelineFrame({
  verification: { verified: false, regionsChecked: 2, regionsRedacted: 1, leakedPatterns: [] },
});
ok("a verification failure that is not a residual still reports itself",
  screenshotSendDecision(otherFailure).reasons.includes("Mask verification unsuccessful"),
  JSON.stringify(screenshotSendDecision(otherFailure).reasons));

// ── 6. Bad encodings block ────────────────────────────────────────────────
ok(
  "a non-image payload is refused",
  screenshotSendDecision({ ...pipelineFrame(), redactedDataUrl: "data:text/plain;base64,AA==" }).allowed === false,
);

// ── 7. Blocked frames make zero calls ─────────────────────────────────────
sent = 0;
const blocked = [
  { ...pipelineFrame(), protection: undefined },
  { ...pipelineFrame(), protection: missingProtection("no evidence") },
  pipelineFrame({ offscreenEvidence: deriveOffscreenProtection({ faceScanRan: false, finalScanRan: true, residualDetections: 0, policyEnabled: true }) }),
  pipelineFrame({ capture: { textComplete: true, mappingValid: false, reasons: [] } }),
  pipelineFrame({ verification: undefined }),
  pipelineFrame({ verification: { verified: false, regionsChecked: 1, regionsRedacted: 0, leakedPatterns: ["leak"] } }),
];
for (const frame of blocked) {
  const outcome = await sendProtectedScreenshot(frame, send);
  ok("a blocked frame reports not-sent", outcome.sent === false);
  ok("  …with at least one reason", Array.isArray(outcome.reasons) && outcome.reasons.length > 0);
}
assert.equal(sent, 0, "blocked frames must make zero network calls");
ok("blocked frames make zero network calls", sent === 0);

console.log(`\n${passed} screenshot egress assertions passed (evidence produced by the pipeline).\n`);
