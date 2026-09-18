/**
 * Agent-loop integration test: the post-action frame pipeline.
 *
 * WHY THIS EXISTS
 *
 * Every other assertion about "the frame pipeline does not block the planner"
 * is a statement about a POLICY (`frameNeedsPlannerWait`) or a HELPER
 * (`joinEvidence`) in isolation. Neither can show the thing the user actually
 * asked for: that the real loop still hands the planner everything it needs —
 * the redaction evidence line, the leak warnings, the run's totals — while the
 * local pixel work stops sitting in front of every planner call.
 *
 * So this harness drives the REAL `runTask` loop: real privacy pipeline
 * (snapshot sanitization, tokenizer, detector, redaction, safety gate, tool
 * schemas, turn budgets, finishTask), real evidence handoff. Only browser I/O
 * and the two model endpoints are stubbed, because neither can exist in Node:
 *
 *   ./executor     — tab I/O (snapshot, execute, isRestricted)
 *   ./providers    — the planner LLM
 *   ./vision       — the VLM, plus the provider capability map
 *   ./ml-bridge    — the on-device models (they live in the offscreen document)
 *   ./privacy-ledger — the ledger, which writes to chrome.storage
 *   ./deterministic  — the deterministic planner (unrelated to this test)
 *
 * The stubs are parameterised through `globalThis.__pry`, and the planner stub
 * RECORDS the exact messages each turn received — which is what makes "the
 * planner still gets everything it needs" assertable rather than assumed.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
// The same bytes the pipeline suite measures against the guard thresholds, fed
// here through a real `runTask`. One fixture, so the two suites cannot end up
// reasoning about two different observations.
import { GLITCH_OUTPUT } from "./fixtures/glitch-output.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
/** Bundled to disk (and deleted on exit) so a stack trace shows the real file
 * and line — importing a data: URL prints the whole bundle into every error. */
const bundlePath = fileURLToPath(new URL("./.itest-bundle.mjs", import.meta.url));
process.on("exit", () => { try { unlinkSync(bundlePath); } catch {} });

let passed = 0;
function ok(name, cond, extra) {
  if (!cond) throw new Error(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  passed++;
  console.log(`  ✓ ${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Stubs ──────────────────────────────────────────────────────────────────

const STUBS = {
  "./executor": `
    export class TabController {
      constructor(tabId) { this.tabId = tabId; }
      async snapshot() { return globalThis.__pry.snapshot(); }
      async waitForLoad() { return; }
    }
    export async function execute(controller, action) {
      return globalThis.__pry.execute(controller, action);
    }
    export function isRestricted(url) {
      return typeof url === "string" && /^chrome:\\/\\//.test(url);
    }
  `,
  "./providers": `
    export function createPlanner() { return globalThis.__pry.planner; }
  `,
  "./vision": `
    export const VISION_SUPPORTED = new Proxy({}, { get: () => true });
    export const VISION_DEFAULT_MODELS = new Proxy({}, { get: () => "stub-vision-model" });
    export async function observeWithVision(...args) {
      return globalThis.__pry.observeWithVision(...args);
    }
  `,
  "./ml-bridge": `
    export async function requestMlNer() { return []; }
    export async function requestMlGuard() { return null; }
    export function setActiveNerSpans() {}
    export function setActivePiiTargets() {}
    export async function probeMlFiles() { return { face: false, ner: false, guard: false }; }
    export async function selfTestMl() { return null; }
  `,
  "./privacy-ledger": `
    const L = () => globalThis.__pry.ledger;
    export async function initLedger() {}
    export const recordSnapshot = (...a) => { L().push(["snapshot", ...a]); return Promise.resolve(); };
    export const recordDetections = (...a) => { L().push(["detections", ...a]); return Promise.resolve(); };
    export const recordAction = (...a) => { L().push(["action", ...a]); return Promise.resolve(); };
    export const recordTokenization = (...a) => { L().push(["tokenization", ...a]); return Promise.resolve(); };
    export const recordRedaction = (...a) => { L().push(["redaction", ...a]); return Promise.resolve(); };
    export const recordVerification = (...a) => { L().push(["verification", ...a]); return Promise.resolve(); };
  `,
  "./deterministic": `
    export async function tryDeterministic() { return null; }
  `,
};

const stubPlugin = {
  name: "stub-browser-deps",
  setup(b) {
    for (const name of Object.keys(STUBS)) {
      const filter = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      b.onResolve({ filter }, (args) => ({ path: args.path, namespace: "stub" }));
    }
    b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: STUBS[args.path],
      loader: "js",
    }));
  },
};

async function bundle(entryContents) {
  const out = await build({
    stdin: { contents: entryContents, resolveDir: root, sourcefile: "itest-entry.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [stubPlugin],
  });
  return out.outputFiles[0].text;
}

const bundleText = await bundle(`
  export { runTask, frameNeedsPlannerWait } from "./src/background/agent.ts";
  export { DEFAULT_SETTINGS } from "./src/shared/types.ts";
  // The two constants the egress meter ships on EVERY turn, so the payload
  // scenario below can measure a real request rather than just the conversation.
  export { SYSTEM_PROMPT } from "./src/background/prompt.ts";
  export { TOOLS } from "./src/background/tools.ts";
`);
await writeFile(bundlePath, bundleText, "utf8");
const mod = await import(pathToFileURL(bundlePath).href);

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** A benign page: no PII in the DOM, so every capture's count comes from pixels. */
function makeSnapshot(url = "https://example.com/") {
  return {
    url,
    title: "Example Domain",
    text: "Example Domain. This domain is for use in illustrative examples.",
    elements: [
      { id: 1, role: "link", name: "More information" },
      { id: 2, role: "heading", name: "Example Domain" },
    ],
    truncated: false,
    scroll: { y: 0, maxY: 400 },
  };
}

/**
 * A realistic content page, sized to the caps the content script actually
 * enforces (`MAX_ELEMENTS = 80`, `MAX_TEXT = 6000` in content/perceive.ts).
 *
 * The tiny two-element fixture above measures control flow; this one measures
 * BYTES, which is what the planner's prefill latency and the run's egress badge
 * are made of — a real run of this same task reported 431 KB of egress.
 */
function makeBigSnapshot(url = "https://example.com/") {
  const prose = Array.from(
    { length: 60 },
    (_, i) =>
      `Section ${i + 1}: this sentence stands in for a page's visible prose so that the snapshot's text budget is genuinely spent the way it is in the browser.`,
  ).join(" ");
  return {
    url,
    title: "A realistic content page with a full-length title",
    text: prose.slice(0, 6000),
    elements: Array.from({ length: 80 }, (_, i) => ({
      id: i + 1,
      role: i % 3 === 0 ? "link" : i % 3 === 1 ? "button" : "textbox",
      name: `Element ${i + 1} label carrying a realistic amount of wording`,
      value: i % 3 === 2 ? "a field value" : undefined,
      attrs: { href: "www.example.com/a/representative/path" },
    })),
    truncated: true,
    scroll: { y: 0, maxY: 1200 },
  };
}

/**
 * A processed frame that claims `redactedCount` items were painted, with a
 * clean verification verdict — the shape the offscreen document returns.
 */
function makeProcessedFrame(redactedCount) {
  return {
    original: "data:image/png;base64,ORIGINAL",
    redactedDataUrl: "data:image/png;base64,REDACTED",
    redactedCount,
    detections: Array.from({ length: redactedCount }, (_, i) => ({
      kind: "face",
      label: `Face ${i + 1}`,
      confidence: 0.9,
      box: { x: 10 * i, y: 10, width: 20, height: 20 },
      tier: "opaque",
    })),
    verification: {
      verified: true,
      verdict: "verified",
      summary: "all regions confirmed redacted",
      regionsChecked: redactedCount,
      regionsRedacted: redactedCount,
      leakedPatterns: [],
    },
  };
}

/** Build a scripted planner that records everything it was shown. */
function makePlanner(script, { plannerMs, onTurn }) {
  const seen = [];
  return {
    label: "Stub planner",
    seen,
    async run({ messages, onText }) {
      // Deep copy: the loop mutates `messages` after the turn, and what the
      // planner SAW is the whole question here.
      seen.push(JSON.parse(JSON.stringify(messages)));
      if (onTurn) onTurn(seen.length);
      const step = script.shift() ?? { text: "Done.", toolCalls: [] };
      if (step.stream) {
        // A turn that STREAMS, so the liveness guards (which read the rolling
        // tail of what was actually sent) can be exercised at all. `thenSilentMs`
        // reproduces the shape a provider that streams and then goes quiet has.
        for (const chunk of step.stream) {
          await sleep(step.chunkMs ?? 1);
          onText?.(chunk);
        }
        if (step.thenSilentMs) await sleep(step.thenSilentMs);
      } else {
        await sleep(plannerMs);
      }
      return {
        text: step.text ?? (step.stream ? step.stream.join("") : ""),
        toolCalls: step.toolCalls ?? [],
        stopReason: "end_turn",
      };
    },
  };
}

const scrollTurn = (text) => ({ text, toolCalls: [{ id: "c1", name: "scroll", input: { direction: "down" } }] });
const finishTurn = { text: "Finished.", toolCalls: [] };

/** Flatten a turn's messages into the text a planner would read. */
const textOf = (messages) =>
  JSON.stringify(messages);

function baseSettings(overrides = {}) {
  const defaults = mod.DEFAULT_SETTINGS;
  return {
    ...defaults,
    ...overrides,
    provider: "nvidia",
    apiKeys: { ...defaults.apiKeys, nvidia: "test-key" },
    models: { ...defaults.models, nvidia: "stub/planner" },
    vision: { ...defaults.vision, ...(overrides.vision ?? {}) },
    privacy: { ...defaults.privacy, ...(overrides.privacy ?? {}) },
    ml: { ...defaults.ml, ...(overrides.ml ?? {}) },
    maxSteps: overrides.maxSteps ?? 8,
  };
}

const chromeStub = {
  runtime: {
    id: "test-extension",
    getManifest: () => ({ permissions: [] }),
    getURL: (p) => `chrome-extension://test/${p}`,
  },
  tabs: {
    get: async (id) => ({ id, url: "https://example.com/", title: "Example Domain", windowId: 1 }),
    sendMessage: async () => ({}),
    query: async () => [],
    update: async () => ({}),
  },
  storage: {
    local: {
      get: (keys, cb) => (typeof cb === "function" ? cb({}) : Promise.resolve({})),
      set: (items, cb) => (typeof cb === "function" ? cb() : Promise.resolve()),
    },
    session: {
      get: (keys, cb) => (typeof cb === "function" ? cb({}) : Promise.resolve({})),
      set: (items, cb) => (typeof cb === "function" ? cb() : Promise.resolve()),
    },
  },
};

/**
 * Run one scenario through the REAL loop.
 *
 * `captureMs` is the local pixel work; `plannerMs` is the model. If the two are
 * serialised (the old behaviour) the run costs steps × (capture + planner); if
 * the capture is deferred they overlap.
 */
async function runScenario({ name, vision, script, captureMs, plannerMs, snapshotFactory, steps = 4 }) {
  globalThis.chrome = chromeStub;
  const emitted = [];
  const ledger = [];
  const captures = [];
  // Per-frame audit entries, and every tally the agent reported to the worker.
  const auditEntries = [];
  const tallies = [];
  // Peak concurrency of frame pipelines: the offscreen document's detectors are
  // module singletons, so two frames must never be processed at once.
  let inFlight = 0;
  let peakInFlight = 0;

  const planner = makePlanner(script, { plannerMs });

  globalThis.__pry = {
    planner,
    ledger,
    snapshot: () => (snapshotFactory ?? makeSnapshot)(),
    execute: async (controller, action) => {
      return { result: { ok: true, detail: `${action.name} ok` }, controller };
    },
    observeWithVision: async () => ({ text: "A stub VLM description of the page.", model: "stub-vision-model", bytes: 1024 }),
    // The pixel pipeline: takes real wall-clock time, and reports 3 items.
    capture: async () => {
      await sleep(captureMs);
      return { original: "data:image/png;base64,ORIGINAL", processed: makeProcessedFrame(3) };
    },
  };

  const settings = baseSettings({ vision: { enabled: vision } });
  const t0 = Date.now();
  await mod.runTask("open https://example.com and read the page", 1, {
    settings,
    emit: (e) => emitted.push(e),
    askConfirm: async () => true,
    signal: new AbortController().signal,
    captureScreenshot: async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      captures.push(Date.now());
      try {
        await sleep(captureMs);
        return { original: "data:image/png;base64,ORIGINAL", processed: makeProcessedFrame(3) };
      } finally {
        inFlight--;
      }
    },
    recordAudit: (entry) => { auditEntries.push(entry); },
    reportTally: (tally) => { tallies.push(tally); },
  });
  const elapsed = Date.now() - t0;

  return { name, emitted, ledger, planner, captures, elapsed, settings, peakInFlight, auditEntries, tallies };
}

/** The run's end-of-run line, which carries the run's totals. */
const tallyLineOf = (emitted) =>
  emitted
    .filter((e) => e.kind === "entry" && e.entry)
    .map((e) => e.entry.text ?? "")
    .find((t) => t.startsWith("Task ended."));

/**
 * Parse "Task ended. 12 redactions (9 masked frame regions + 3 page items) · 2
 * vault tokens." so the parts can be checked against each other and against
 * what the panel was told.
 */
function parseTallyLine(line) {
  const m = /^Task ended\. (\d+) redactions? \((\d+) masked frame regions? \+ (\d+) page items?\) · (\d+) vault tokens?/.exec(line ?? "");
  return m ? { total: +m[1], frameRegions: +m[2], pageItems: +m[3], tokens: +m[4] } : null;
}

// ─── Scenario 1: vision OFF — the frame is deferred, nothing is lost ────────

console.log("\n=== agent loop: post-action frame pipeline, vision OFF ===\n");

// The ratio matters more than the values: a planner turn in production is
// seconds to minutes, and a capture is 1.2-6.5 s, so the turn is the thing that
// hides the capture. The stub keeps that direction (capture < turn) rather than
// the inverse, which would measure the join's own wait instead.
const CAPTURE_MS = 200;
const PLANNER_MS = 400;

const off = await runScenario({
  name: "vision off",
  vision: false,
  captureMs: CAPTURE_MS,
  plannerMs: PLANNER_MS,
  script: [scrollTurn("Scrolling down."), scrollTurn("Scrolling again."), scrollTurn("One more."), finishTurn],
});

const systemTexts = (r) => r.emitted.filter((e) => e.kind === "entry" && e.entry).map((e) => e.entry.text ?? "");
const toolTexts = (r) =>
  r.planner.seen.map((messages) =>
    messages.filter((m) => m.role === "tool").flatMap((m) => m.results.map((x) => x.content)),
  );

ok("the loop ran a real multi-turn task", off.planner.seen.length >= 3, `${off.planner.seen.length} planner turns`);
ok("each page-changing action did capture a frame", off.captures.length >= 3, `${off.captures.length} capture(s)`);
ok(
  "and no two frames were ever processed at once (the offscreen detectors are shared)",
  off.peakInFlight === 1,
  `peak concurrency ${off.peakInFlight}`,
);

// THE POINT OF THE CHANGE: the capture is overlapped with the planner turn that
// follows it. Serialised, four turns cost 4 × (200 + 400) = 2400 ms; overlapped
// they cost about 4 × 400 = 1600 ms, because each capture fits inside the turn
// after it. The margin below sits between the two.
//
// Widened from 2000 ms after it failed at 2084 ms on a machine that had just run
// the offscreen pixel suite: this is a wall-clock assertion in a suite that runs
// after several heavy ones, and a gate that fails on load rather than on
// behaviour teaches people to ignore it. The claim being checked is the
// DIRECTION — overlapped (≈1600) against serialised (≈2400) — so 2200 still
// fails the regression it exists for while leaving real headroom for a slow box.
ok(
  "the pixel pipeline overlapped the planner turns instead of blocking them",
  off.elapsed < 2200,
  `${off.elapsed}ms for ${off.planner.seen.length} turns at ${CAPTURE_MS}ms capture + ${PLANNER_MS}ms planner (serialised would be ~${4 * (CAPTURE_MS + PLANNER_MS)}ms)`,
);
// The ONE place the deferral cannot hide the capture is the first join, which
// lands after the opening turn with no earlier turn behind it — so the cost is
// the capture minus that turn, not the whole capture. Stated here so nobody
// later reads a first-turn slowdown as a regression.
ok(
  "the deferral costs at most (capture − turn), never the whole capture",
  off.elapsed < 4 * PLANNER_MS + 2 * CAPTURE_MS,
  `${off.elapsed}ms vs bound ${4 * PLANNER_MS + 2 * CAPTURE_MS}ms`,
);

// EVERYTHING THE PLANNER NEEDS: the evidence line still reaches it, labelled
// with the step it describes. It is not dropped and not silently mislabelled.
const allToolText = toolTexts(off).flat().join("\n");
ok(
  "the deferred frame's evidence line still reaches the planner",
  /\[Frame after the previous action: 3 PII redacted\]/.test(allToolText),
  allToolText.slice(0, 400),
);
ok(
  "the same line carries the verification verdict",
  /\[Re-OCR VERIFIED: 3\/3 regions confirmed redacted\]/.test(allToolText),
);
ok(
  "it is labelled as the PREVIOUS step's frame, never as this step's",
  !/\[Screenshot: 3 PII redacted\]/.test(allToolText),
);
ok(
  "and it reaches the planner no later than the next turn after the action",
  toolTexts(off).some((turn, i) => i >= 1 && turn.join("\n").includes("Frame after the previous action")),
);

// Nothing was sacrificed by deferring: the same evidence is filed everywhere it
// was filed before.
ok(
  "the ledger still recorded every deferred frame's redaction",
  off.ledger.filter((entry) => entry[0] === "redaction").length >= 3,
  `${off.ledger.filter((e) => e[0] === "redaction").length} redaction entries`,
);
ok(
  "the ledger still recorded verification for them",
  off.ledger.filter((entry) => entry[0] === "verification").length >= 3,
);
// The run's totals, and the SHAPE they must have. One run used to be reported
// as 231 "items redacted" in the transcript, 227 "Redacted" on the audit chip
// (frame regions only, over whatever frames the entry buffer still held) and 2
// "Vault Tokens" — three surfaces, one run, no way to tell them apart. The line
// now names its parts, and the parts must add up to the total.
const offTallyLine = tallyLineOf(off.emitted);
const offTally = parseTallyLine(offTallyLine);
ok(
  "the run's end line decomposes its total by channel",
  offTally !== null,
  offTallyLine ?? "no totals line",
);
ok(
  "the total is exactly frame regions + page items",
  offTally !== null && offTally.total === offTally.frameRegions + offTally.pageItems,
  JSON.stringify(offTally),
);
ok(
  "and it counts every deferred frame's painted regions",
  offTally !== null && offTally.frameRegions >= 9,
  `${offTally?.frameRegions} region(s) for ${off.captures.length} capture(s)`,
);
const lastReportedTally = off.tallies.at(-1);
ok(
  "the panel is told the same numbers the transcript prints",
  lastReportedTally !== undefined &&
    offTally !== null &&
    lastReportedTally.total === offTally.total &&
    lastReportedTally.frameRegions === offTally.frameRegions &&
    lastReportedTally.pageItems === offTally.pageItems &&
    lastReportedTally.tokens === offTally.tokens,
  `reported ${JSON.stringify(lastReportedTally)} vs line ${JSON.stringify(offTally)}`,
);

// ─── Scenario 2: vision ON — the frame is NOT deferred ─────────────────────

console.log("\n=== agent loop: post-action frame pipeline, vision ON ===\n");

const on = await runScenario({
  name: "vision on",
  vision: true,
  captureMs: CAPTURE_MS,
  plannerMs: PLANNER_MS,
  script: [scrollTurn("Scrolling down."), scrollTurn("Scrolling again."), finishTurn],
});

const onToolText = toolTexts(on).flat().join("\n");
ok(
  "with vision ON the frame line is delivered in the action's OWN turn (it was awaited)",
  /\[Screenshot: 3 PII redacted\]/.test(onToolText),
  onToolText.slice(0, 400),
);
ok(
  "and it is never labelled as a previous step's frame",
  !/Frame after the previous action/.test(onToolText),
);
ok(
  "the VLM path ran against the redacted frame",
  systemTexts(on).some((t) => /Screenshot withheld|VLM observation/.test(t)) ||
    /VLM observation/.test(onToolText),
  systemTexts(on).filter((t) => t.includes("Screenshot")).join(" | ") || "no vision-path notice",
);

// A frame the gate refuses must say so PER FRAME. This stub's frames carry no
// protection evidence, so the gate fails closed on every one of them; the run
// must record why, because the run-level badge is only entitled to claim
// verification for frames that were not withheld (and must not claim it for a
// run in which one was).
const withheldEntries = on.auditEntries.filter((e) => (e.withheld?.length ?? 0) > 0);
ok(
  "a frame refused egress is recorded as withheld, with reasons",
  withheldEntries.length > 0 &&
    withheldEntries.every((e) => e.withheld.every((r) => typeof r === "string" && r.length > 0)),
  `${withheldEntries.length} withheld of ${on.auditEntries.length}; ${JSON.stringify(withheldEntries[0]?.withheld)}`,
);
ok(
  "and it is the gate's own reason that is recorded, not a summary of it",
  withheldEntries.some((e) => e.withheld.some((r) => /Protection evidence missing/.test(r))),
  JSON.stringify(withheldEntries[0]?.withheld),
);
ok(
  "a run with vision off withholds nothing (no frame was offered for egress)",
  off.auditEntries.every((e) => (e.withheld?.length ?? 0) === 0),
  JSON.stringify(off.auditEntries.map((e) => e.withheld)),
);

// ─── Scenario 3: a wedged capture cannot hold a run open ───────────────────

console.log("\n=== agent loop: a wedged capture must not hang the run ===\n");

/**
 * Every capture never settles — the failure mode the bounded join exists for.
 * Run once per vision setting, because the two settings are the two places a
 * capture is waited on at all (the opening frame when vision is on; the join
 * after a planner turn), and BOTH must give up rather than hang.
 */
const WEDGE_BUDGET_MS = 300;
async function runWedged(vision) {
  globalThis.chrome = chromeStub;
  const emitted = [];
  let captureCalls = 0;
  globalThis.__pry = {
    planner: makePlanner([scrollTurn("Scrolling."), finishTurn], { plannerMs: 10 }),
    ledger: [],
    snapshot: () => makeSnapshot(),
    execute: async (controller, action) => ({ result: { ok: true, detail: `${action.name} ok` }, controller }),
    observeWithVision: async () => ({ text: "", model: "stub", bytes: 0 }),
    capture: async () => null,
  };
  const t0 = Date.now();
  await mod.runTask("read the page", 1, {
    settings: baseSettings({ vision: { enabled: vision } }),
    emit: (e) => emitted.push(e),
    askConfirm: async () => true,
    signal: new AbortController().signal,
    // The production budget (15 s) is more than 2× the worst measured capture,
    // so shortening it here drives the SAME code path without a two-minute test.
    frameAuditWaitMs: WEDGE_BUDGET_MS,
    captureScreenshot: async () => {
      captureCalls++;
      return new Promise(() => {});
    },
    recordAudit: () => {},
  });
  return { emitted, captureCalls, elapsed: Date.now() - t0 };
}

const wedgedOff = await runWedged(false);
ok(
  "vision off: a capture that never returns still ends the run",
  wedgedOff.captureCalls >= 1 && wedgedOff.elapsed < WEDGE_BUDGET_MS * 6,
  `${wedgedOff.captureCalls} call(s), ${wedgedOff.elapsed}ms (budget ${WEDGE_BUDGET_MS}ms per wait)`,
);
ok(
  "and the run reports its totals rather than hanging on it",
  parseTallyLine(tallyLineOf(wedgedOff.emitted)) !== null,
  tallyLineOf(wedgedOff.emitted) ?? "no totals line",
);

const wedgedOn = await runWedged(true);
ok(
  "vision on: the AWAITED capture gives up instead of hanging before turn 1",
  wedgedOn.captureCalls >= 1 && wedgedOn.elapsed < WEDGE_BUDGET_MS * 6,
  `${wedgedOn.captureCalls} call(s), ${wedgedOn.elapsed}ms`,
);
ok(
  "and it is honest about the frame it lost instead of staying silent",
  wedgedOn.emitted.some((e) => e.kind === "entry" && /did not finish within/.test(e.entry?.text ?? "")),
  wedgedOn.emitted.filter((e) => e.kind === "entry").map((e) => e.entry.text).join(" | "),
);
ok(
  "and the run still reaches its totals",
  parseTallyLine(tallyLineOf(wedgedOn.emitted)) !== null,
  tallyLineOf(wedgedOn.emitted) ?? "no totals line",
);

// ─── Scenario 4: the frame's leak evidence is never dropped ────────────────

console.log("\n=== agent loop: leak evidence survives deferral ===\n");

globalThis.chrome = chromeStub;
let leakFrame = false;
const leakEmitted = [];
globalThis.__pry = {
  planner: makePlanner([scrollTurn("Scrolling."), finishTurn], { plannerMs: 20 }),
  ledger: [],
  snapshot: () => makeSnapshot(),
  execute: async (controller, action) => ({ result: { ok: true, detail: `${action.name} ok` }, controller }),
  observeWithVision: async () => ({ text: "", model: "stub", bytes: 0 }),
  capture: async () => null,
};
await mod.runTask("read the page", 1, {
  settings: baseSettings({ vision: { enabled: false } }),
  emit: (e) => leakEmitted.push(e),
  askConfirm: async () => true,
  signal: new AbortController().signal,
  captureScreenshot: async () => {
    leakFrame = true;
    return {
      original: "data:image/png;base64,ORIGINAL",
      processed: {
        ...makeProcessedFrame(1),
        // A residual that survived redaction: the run must not lose this just
        // because the pipeline ran alongside the planner turn.
        verification: {
          verified: false,
          verdict: "leaked",
          summary: "1 residual region survived the redaction pass",
          regionsChecked: 2,
          regionsRedacted: 1,
          leakedPatterns: ["OCR: priya.sharma@example.com"],
        },
      },
    };
  },
  recordAudit: () => {},
});

const leakNote = leakEmitted
  .filter((e) => e.kind === "entry" && e.entry)
  .map((e) => e.entry.text ?? "")
  .find((t) => t.includes("Re-OCR WARNING") || t.includes("Last frame audit"));
ok(
  "a residual leak found by a DEFERRED frame is still reported, with its pattern",
  Boolean(leakNote) && /Re-OCR WARNING/.test(leakNote),
  leakNote ?? "no warning emitted",
);
ok("the frame really was the failing one", leakFrame);

// ─── Scenario 4b: an element number that changes meaning ───────────────────
//
// Element ids are positional indices, so a number only means what the read that
// produced it says it means. Live shape of the failure: one planner turn calls
// two tools; the first action changes the page; the second tool call then uses
// an id from BEFORE that change. Optional chaining a number to a different
// control used to be the outcome.

console.log("\n=== agent loop: an element number that changes meaning ===\n");

const BEFORE = {
  url: "https://mail.example.com/",
  title: "Compose",
  text: "Compose",
  elements: [
    { id: 0, role: "textbox", name: "Message Body" },
    { id: 1, role: "button", name: "Send" },
  ],
  truncated: false,
  scroll: { y: 0, maxY: 0 },
  generation: 1,
};

/**
 * Runs one turn that clicks element 0 and then types into element 0, against a
 * page whose SECOND read is `after` (i.e. the ids were renumbered by the first
 * action's re-perception).
 */
async function runIdDrift(after) {
  globalThis.chrome = chromeStub;
  const emitted = [];
  const executed = [];
  let reads = 0;
  globalThis.__pry = {
    planner: makePlanner(
      [
        {
          text: "Clicking the body, then typing into it.",
          toolCalls: [
            { id: "c1", name: "click", input: { element_id: 0, reason: "focus the body" } },
            { id: "c2", name: "type", input: { element_id: 0, text: "hi", reason: "write the message" } },
          ],
        },
        finishTurn,
      ],
      { plannerMs: 10 },
    ),
    ledger: [],
    snapshot: () => {
      reads += 1;
      return reads === 1 ? BEFORE : { ...after, generation: reads };
    },
    execute: async (controller, action) => {
      executed.push(JSON.parse(JSON.stringify(action)));
      return { result: { ok: true, detail: `${action.name} ok` }, controller };
    },
    observeWithVision: async () => ({ text: "", model: "stub", bytes: 0 }),
    capture: async () => null,
  };
  await mod.runTask("write an email body", 1, {
    settings: baseSettings({ vision: { enabled: false } }),
    emit: (e) => emitted.push(e),
    askConfirm: async () => true,
    signal: new AbortController().signal,
    captureScreenshot: async () => null,
    recordAudit: () => {},
  });
  // Both entry texts and the patches that rewrite a pending step: the loop
  // reports what it did to an in-flight step by patching it, and a helper that
  // only read entries would miss every one of those notes.
  const texts = () => emitted
    .map((e) => (e.kind === "patch" ? (e.text ?? "") : e.kind === "entry" ? (e.entry?.text ?? "") : ""))
    .filter(Boolean);
  const toolResults = (r) => globalThis.__pry.planner.seen
    .flatMap((messages) => messages.filter((m) => m.role === "tool"))
    .flatMap((m) => m.results.map((x) => x.content));
  return { emitted, executed, texts: texts(), toolResults: toolResults({ emitted }) };
}

// (a) The page renumbered its ids, but the control the model meant is still
// uniquely identifiable — retry it automatically instead of costing a turn.
const drift = await runIdDrift({
  ...BEFORE,
  elements: [
    { id: 0, role: "button", name: "Send" },
    { id: 1, role: "textbox", name: "Message Body" },
  ],
});
ok(
  "both tool calls in one turn still ran",
  drift.executed.length === 2,
  JSON.stringify(drift.executed.map((a) => a.name)),
);
ok(
  "the renumbered id was remapped to the control the model meant",
  drift.executed[1]?.input?.element_id === 1,
  `executed element_id ${drift.executed[1]?.input?.element_id} (expected 1: the textbox moved there)`,
);
ok(
  "and the log says the number had moved rather than staying silent",
  drift.texts.some((t) => /now sits on button "Send"/.test(t) && /retrying automatically/.test(t)),
  drift.texts.join(" | "),
);
ok(
  "the action carries the generation of the read its id came from",
  drift.executed[0].snapshotGeneration === 1 && drift.executed[1].snapshotGeneration === 2,
  JSON.stringify(drift.executed.map((a) => a.snapshotGeneration)),
);

// (b) The number now names a different control and the old control is NOT
// uniquely identifiable — refuse, and never touch the wrong element.
const ambiguous = await runIdDrift({
  ...BEFORE,
  elements: [
    { id: 0, role: "button", name: "Send" },
    { id: 1, role: "button", name: "Send" },
  ],
});
ok(
  "a type into a renumbered id does NOT run on the wrong control",
  ambiguous.executed.length === 1 && ambiguous.executed[0].name === "click",
  JSON.stringify(ambiguous.executed.map((a) => `${a.name}#${a.input.element_id}`)),
);
const refusalText = ambiguous.toolResults.find((t) => /different control/.test(t)) ?? "";
ok(
  "the refusal names BOTH meanings of the number",
  /it was a textbox named "Message Body"/.test(refusalText) &&
    /the current page has a button named "Send" at that number/.test(refusalText),
  refusalText.slice(0, 300),
);
ok(
  "and it hands the planner the current elements to choose from",
  /pick the right one and retry/.test(refusalText) && /\[\d+\]/.test(refusalText),
  refusalText.slice(0, 300),
);
ok(
  "the transcript says a refusal happened, not a stale element",
  ambiguous.texts.some((t) => /Refused — that element number now points at a different control\./.test(t)),
  ambiguous.texts.join(" | "),
);

// A re-render that does NOT move the ids must not refuse anything: the id is
// from an older read, but it still names the same control.
const stable = await runIdDrift({ ...BEFORE });
ok(
  "an id from an older read that still names the same control is accepted",
  stable.executed.length === 2 && stable.executed[1].input.element_id === 0,
  JSON.stringify(stable.executed.map((a) => `${a.name}#${a.input.element_id}`)),
);
ok(
  "and it is stamped with the current read so the page accepts it",
  stable.executed[1].snapshotGeneration === 2,
  String(stable.executed[1].snapshotGeneration),
);

// ─── Scenario 4b: a task that needs no element id can still be done ────────
//
// The reported dead end: "open youtube and search harkirat singh". The run reached
// the page, the read carried no id for the search box, and with no way to type
// without one the model re-read the page five times until the loop guard killed
// the run. This drives the real loop through that exact shape, with the box named
// instead of numbered, and checks the two things that make the fix real: the action
// REACHES the page as a page action, and a run whose only action is type_text is
// still a run that acted.
console.log("\n=== agent loop: typing into a field with no element id ===\n");

/** A read of youtube.com with ids for chrome and none for the search box. */
const NO_ID_FOR_SEARCH = {
  url: "https://www.youtube.com/",
  title: "YouTube",
  text: "Home Shorts Subscriptions",
  elements: [
    { id: 0, role: "link", name: "Home" },
    { id: 1, role: "link", name: "Shorts" },
    { id: 2, role: "link", name: "Subscriptions" },
  ],
  truncated: true,
  scroll: { y: 0, maxY: 800 },
  generation: 1,
};

const typed = await (async () => {
  globalThis.chrome = chromeStub;
  const emitted = [];
  const executed = [];
  globalThis.__pry = {
    planner: makePlanner(
      [
        {
          text: "Searching YouTube.",
          toolCalls: [
            {
              id: "c1",
              name: "type_text",
              input: { field: "Search", text: "harkirat singh", submit: true, reason: "run the search" },
            },
          ],
        },
        finishTurn,
      ],
      { plannerMs: 10 },
    ),
    ledger: [],
    snapshot: () => NO_ID_FOR_SEARCH,
    execute: async (controller, action) => {
      executed.push(JSON.parse(JSON.stringify(action)));
      return {
        result: {
          ok: true,
          detail:
            'Matched the field named "Search" (exact match). Typed "harkirat singh" into ' +
            '<input "Search">. Field now shows: "harkirat singh", and pressed Enter.',
        },
        controller,
      };
    },
    observeWithVision: async () => ({ text: "", model: "stub", bytes: 0 }),
    capture: async () => null,
  };
  await mod.runTask("open youtube and search harkirat singh", 1, {
    settings: baseSettings({ vision: { enabled: false } }),
    emit: (e) => emitted.push(e),
    askConfirm: async () => true,
    signal: new AbortController().signal,
    captureScreenshot: async () => null,
    recordAudit: () => {},
  });
  return { emitted, executed };
})();

const typedAction = typed.executed.find((a) => a.name === "type_text");
ok("the field-named action reaches the page instead of being dropped as unknown",
  Boolean(typedAction),
  JSON.stringify(typed.executed.map((a) => a.name)));
ok("it arrives with the field's name and the text intact — no id is invented for it",
  typedAction?.input.field === "Search" &&
  typedAction?.input.text === "harkirat singh" &&
  typedAction?.input.submit === true &&
  typedAction?.input.element_id === undefined,
  JSON.stringify(typedAction?.input));
ok("the transcript says what it is doing in the user's terms, not \"element undefined\"",
  typed.emitted.some((e) => e.kind === "entry" && /field named "Search"/.test(e.entry?.text ?? "")),
  typed.emitted.map((e) => (e.kind === "entry" ? e.entry?.text : e.text)).filter(Boolean).slice(0, 4).join(" | ").slice(0, 140));
ok("a run whose only action is naming a field still counts as having acted",
  typed.emitted.find((e) => e.kind === "experience")?.experience?.taskSuccess === true,
  JSON.stringify({ taskSuccess: typed.emitted.find((e) => e.kind === "experience")?.experience?.taskSuccess }));
ok("and the tool result the planner reads back is the matched field, not a guess",
  typed.emitted.length > 0 &&
  globalThis.__pry.planner.seen.some((messages) =>
    messages.some((m) => m.role === "tool" && m.results.some((r) => /Matched the field named/.test(r.content)))),
  "");

// ─── Scenario 4c: glitch output is never presented as the answer ───────────
//
// The live run: asked to "open youtube and search for harkirat singh", the model
// streamed 83 s of punctuation and mixed-script fragments, made ZERO tool calls,
// went silent for 30 s, was retried once, and the retry's wall of text was
// printed as PRY AGENT's answer above "Task ended." — for a task that had not
// started. The guard itself is measured in the pipeline suite; what this
// scenario pins is the LOOP's end of it: no retry, no success, and no fragments
// left sitting in the transcript where an answer belongs.
console.log("\n=== agent loop: glitch output is never the answer ===\n");

/**
 * Replay the panel's patch rules over the event stream, so what is asserted is
 * the text the user ends up reading — not the raw events. Assistant patches
 * append unless they carry `replace`; every other role replaces.
 *
 * Without this, a test can pass while the answer card still shows the glitch:
 * the events are what the loop sent, the entries are what the panel displays.
 */
function transcriptAfter(emitted) {
  const entries = new Map();
  const order = [];
  for (const event of emitted) {
    if (event.kind === "entry" && event.entry) {
      entries.set(event.entry.id, { ...event.entry });
      order.push(event.entry.id);
    } else if (event.kind === "patch" && entries.has(event.id) && event.text !== undefined) {
      const entry = entries.get(event.id);
      entry.text =
        entry.role === "assistant" && !event.replace ? (entry.text ?? "") + event.text : event.text;
    }
  }
  return order.map((id) => entries.get(id));
}

const glitch = await runScenario({
  name: "glitch",
  vision: false,
  captureMs: 0,
  plannerMs: 0,
  script: [
    // Streamed, because that is how the real failure arrived: as deltas that the
    // narration path painted into the answer card before anything could rule on
    // them. The whole sample arrives inside one tick, so this lands on the
    // final-answer guard rather than on the watchdog's cut.
    { text: GLITCH_OUTPUT, stream: GLITCH_OUTPUT.match(/[\s\S]{1,60}/g) ?? [], chunkMs: 1 },
    // Reachable only if the loop wrongly re-sends the prompt that collapsed.
    finishTurn,
  ],
});

const glitchEntries = transcriptAfter(glitch.emitted);
const glitchText = (e) => e.text ?? "";
const glitchCards = glitchEntries.filter((e) => e.role === "assistant");
const paintedGlitch = glitch.emitted.filter(
  (e) => e.kind === "entry" && e.entry?.role === "assistant" && /walks-around/.test(e.entry.text ?? ""),
);
ok("the stream really was painted into the answer card first, so replacing it is the fix",
  paintedGlitch.length === 1,
  `${paintedGlitch.length} card(s) painted with fragments, ` +
    `${glitch.emitted.filter((e) => e.kind === "entry" && e.entry?.role === "assistant").length} assistant card(s)`);
ok("the answer card does not keep the fragments — it says they were discarded",
  glitchCards.length === 1 && /discarded/.test(glitchText(glitchCards[0])),
  JSON.stringify(glitchText(glitchCards[0] ?? {}).slice(0, 90)));
ok("no glitch fragment survives anywhere the user can read",
  glitchEntries.every((e) => !/walks-around|łu\),|λ\)····/.test(glitchText(e))),
  glitchEntries.find((e) => /walks-around|łu\)/.test(glitchText(e)))?.text?.slice(0, 60));
ok("the run reports a model failure instead of an answer",
  glitchEntries.some((e) => e.role === "error" &&
    /text that is not language|stopped writing language/.test(glitchText(e))),
  glitchEntries.filter((e) => e.role === "error").map(glitchText).join(" | ").slice(0, 120));
ok("the collapsed turn is not retried — the same prompt buys the same garbage",
  glitch.planner.seen.length === 1,
  `${glitch.planner.seen.length} planner turns`);
const glitchExperience = glitch.emitted.find((e) => e.kind === "experience")?.experience;
ok("and the run is not recorded as a success for a task it never started",
  glitchExperience?.taskSuccess === false,
  JSON.stringify({ taskSuccess: glitchExperience?.taskSuccess }));

// The control: a long, COHERENT final answer still reaches the panel untouched.
// The guard must not be doing this to every long answer.
const longAnswer = Array.from(
  { length: 12 },
  (_, i) => `Step ${i + 1}: YouTube's search field takes the query and the results render as cards.`,
).join(" ");
const coherent = await runScenario({
  name: "coherent answer",
  vision: false,
  captureMs: 0,
  plannerMs: 0,
  script: [{ text: longAnswer, stream: longAnswer.match(/[\s\S]{1,80}/g), chunkMs: 1 }],
});
const coherentCards = transcriptAfter(coherent.emitted).filter((e) => e.role === "assistant");
ok("a long coherent answer is still delivered in full, not discarded",
  coherentCards.length === 1 && glitchText(coherentCards[0]) === longAnswer,
  `${glitchText(coherentCards[0] ?? {}).length} of ${longAnswer.length} chars`);
ok("and that run reports no error at all",
  transcriptAfter(coherent.emitted).every((e) => e.role !== "error"));

// ─── Scenario 5: what one planner turn is actually charged ─────────────────

console.log("\n=== agent loop: the per-turn payload budget ===\n");

/**
 * The complaint this exists to answer is "every tool call takes a lot of
 * seconds". Part of that is the model; part of it is what each turn RE-SENDS.
 * The loop already pruned stale renders out of tool results, but the page read
 * the run OPENED with lives in messages[0] — a message the tool-result prune
 * never walked — so a multi-turn run paid for two full page reads on every turn
 * while only one of them was current.
 *
 * Measured here on the real loop with a production-sized page, because the
 * numbers (kilobytes per turn, and the growth across turns) are the whole claim.
 */
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const userContentOf = (messages) => messages.find((m) => m.role === "user")?.content ?? "";
const toolContentsOf = (messages) =>
  messages.filter((m) => m.role === "tool").flatMap((m) => m.results.map((r) => r.content));
/** A page read that is still there in full: marker AND the rendered body. */
const isFullRead = (content) =>
  content.includes("--- Page after this action ---") && content.includes("\nText: Section 1");
const isPrunedRead = (content) => content.includes("[Previous page snapshot omitted");

const payloadTurns = 5;
const payload = await runScenario({
  name: "payload",
  vision: false,
  captureMs: 0,
  plannerMs: 0,
  snapshotFactory: makeBigSnapshot,
  script: [
    scrollTurn("Scrolling."),
    scrollTurn("Scrolling."),
    scrollTurn("Scrolling."),
    scrollTurn("Scrolling."),
    finishTurn,
  ],
});

const seen = payload.planner.seen;
ok("the payload run produced several planner turns", seen.length >= payloadTurns, `${seen.length} turns`);

const perTurn = seen.map((messages) => bytesOf(messages));
const openingOnTurn1 = userContentOf(seen[0]).includes("--- Current page ---");
ok("turn 1 opens with the page read in full (it has nothing else to go on)", openingOnTurn1,
  userContentOf(seen[0]).slice(0, 120));

ok(
  "once a fresher read exists, the opening read is not re-sent",
  seen.slice(1).every((m) =>
    userContentOf(m).includes("[Opening page snapshot omitted") &&
    !userContentOf(m).includes("--- Current page ---")),
  userContentOf(seen[1]).slice(-160),
);
ok(
  "but the turn still carries a full, CURRENT page read — the prune is not a loss",
  seen.slice(1).every((m) => toolContentsOf(m).some(isFullRead)),
  JSON.stringify(seen.slice(1).map((m) => toolContentsOf(m).filter(isFullRead).length)),
);
ok(
  "no turn carries two full page reads at once",
  seen.every((m) => toolContentsOf(m).filter(isFullRead).length <= 1),
  JSON.stringify(seen.map((m) => toolContentsOf(m).filter(isFullRead).length)),
);
ok(
  "old renders are still pruned rather than stacked up",
  seen.at(-1) && toolContentsOf(seen.at(-1)).filter(isPrunedRead).length >= 1,
  `${toolContentsOf(seen.at(-1)).filter(isPrunedRead).length} pruned`,
);

// The saving itself, taken from the loop's own messages rather than assumed:
// turn 1's opening message minus a later turn's is exactly the render that no
// longer travels.
const openingUserBytes = bytesOf(userContentOf(seen[0]));
const laterUserBytes = bytesOf(userContentOf(seen[1]));
const renderBytes = openingUserBytes - laterUserBytes;
ok(
  "dropping the stale opening read saves a real page's worth of bytes per turn",
  renderBytes > 3000,
  `${renderBytes} B per turn (page read ${openingUserBytes} B → ${laterUserBytes} B)`,
);

// A run must not pay more for each successive step. This is the property that
// makes latency predictable: turn N costs about what turn 2 costs, not N × a
// page read.
const growth = perTurn.at(-1) - perTurn[1];
ok(
  "per-turn payload does not grow without bound across the run",
  growth < 4000,
  `${perTurn.map((b) => Math.round(b / 1024) + "K").join(" → ")} (growth ${growth} B)`,
);

const total = perTurn.reduce((a, b) => a + b, 0);
const withoutPrune = total + renderBytes * (perTurn.length - 1);
ok(
  "the whole run's planner payload is meaningfully smaller than the same run without the prune",
  total < withoutPrune * 0.85,
  `${Math.round(total / 1024)} KB vs ${Math.round(withoutPrune / 1024)} KB unpruned ` +
    `(${Math.round((1 - total / withoutPrune) * 100)}% less)`,
);

// The same accounting at the width the egress badge uses: the real request is
// `{ system, tools, messages }`, and the first two are byte-identical on every
// turn. Measuring the whole thing is what keeps this honest — the conversation
// is not the bill, only the part of it that can change.
const fixedBytes = bytesOf({ system: mod.SYSTEM_PROMPT, tools: mod.TOOLS });
const requestBytes = seen.map((messages) =>
  bytesOf({ system: mod.SYSTEM_PROMPT, tools: mod.TOOLS, messages }));
const fixedShare = Math.round((fixedBytes / requestBytes[1]) * 100);
console.log(
  `  · conversation per turn: ${perTurn.map((b) => `${(b / 1024).toFixed(1)} KB`).join(" → ")}`,
);
console.log(
  `  · whole request per turn: ${requestBytes.map((b) => `${(b / 1024).toFixed(1)} KB`).join(" → ")}` +
    ` (system + tools are ${(fixedBytes / 1024).toFixed(1)} KB, ${fixedShare}% of turn 2)`,
);
console.log(
  `  · the stale opening read was ${(renderBytes / 1024).toFixed(1)} KB of every turn after the first`,
);
ok(
  "the request the provider is charged does not grow with step count",
  requestBytes.at(-1) - requestBytes[1] < 4000,
  `${requestBytes.map((b) => Math.round(b / 1024) + "K").join(" → ")}`,
);

console.log(`\n${passed} agent-loop assertions passed (real runTask, stubbed browser + models).`);
assert.ok(passed >= 15);
