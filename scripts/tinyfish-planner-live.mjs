/**
 * TinyFish × planner LIVE test — does a REAL model emit a usable `web_search`?
 *
 * WHAT THIS IS FOR
 *
 * `tinyfish-test.mjs` proves the transport and the policy in isolation.
 * `tinyfish-live.mjs` proves the transport against the real service. Neither
 * answers the question that decides whether this feature is worth anything:
 * does a real model, handed the real `web_search` schema, actually CALL it,
 * and are the arguments it produces good enough to survive `planSearch`?
 *
 * A schema a model cannot fill is worse than no schema — it burns a turn and
 * then produces arguments the policy refuses. So this runs the REAL adapter
 * (`createOpenAIPlanner`, the same one the extension uses for OpenRouter), the
 * REAL tool spec, and the REAL policy, then feeds real search results back.
 *
 * WHY A MODEL LIST
 *
 * Free-tier OpenRouter endpoints are heavily rate-limited and vary under load.
 * Observed live: `nvidia/nemotron-3.5-lighting:free` returned a correct
 * `web_search` call on the first try in one run, then three consecutive prose
 * answers (114 s) minutes later. That variance is a property of the endpoint,
 * not of the schema — so rather than let one degraded endpoint read as "the
 * schema is broken", the test walks a prioritised list and reports per-model.
 * Set OPENROUTER_MODEL to pin a single model.
 *
 * USAGE
 *
 *   OPENROUTER_API_KEY=... [TINYFISH_API_KEY=...] node scripts/tinyfish-planner-live.mjs
 *
 * Exits 0 and sends nothing when the key is absent. Exits non-zero when no
 * tested model could produce a `web_search` call — which WOULD be a schema
 * defect, and is exactly what this test exists to catch.
 *
 * PRIVACY
 *
 * The prompt is deliberately free of PII — it is a public-web task. Keys are
 * read from the environment and never written or logged. This is the only test
 * in the repo that sends a prompt to a third party, and it only runs when a
 * human has explicitly provided a key for it.
 */
import { build } from "esbuild";

const apiKey = (process.env.OPENROUTER_API_KEY ?? "").trim();
const pinned = (process.env.OPENROUTER_MODEL ?? "").trim();
const tinyfishKey = (process.env.TINYFISH_API_KEY ?? "").trim();

if (!apiKey) {
  console.log("SKIPPED — OPENROUTER_API_KEY is not set. Nothing was sent.");
  process.exit(0);
}

// Free endpoints that answered a web_search call correctly when sampled live.
const DEFAULT_MODELS = [
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "cohere/north-mini-code:free",
  "dots-studio/dots-3-note-preview:free",
  "poolside/laguna-s-2.1:free",
];
const models = pinned ? [pinned] : DEFAULT_MODELS;

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function bundle(entry) {
  const out = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: "planner-live.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

const code = await bundle(`
  export { createOpenAIPlanner } from "./src/background/providers/openai.ts";
  export { TINYFISH_WEB_SEARCH_TOOL, TOOLS } from "./src/background/tools.ts";
  export { planSearch, dispatchSearch } from "./src/background/web-search.ts";
  export { SYSTEM_PROMPT } from "./src/background/prompt.ts";
  export { searchWeb, formatSearchResults } from "./src/background/tinyfish.ts";
`);
const mod = await import(`data:text/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`);
const {
  createOpenAIPlanner, TINYFISH_WEB_SEARCH_TOOL, TOOLS,
  planSearch, dispatchSearch, SYSTEM_PROMPT,
  searchWeb, formatSearchResults,
} = mod;

// The same composition the run performs: base tools + the search tool.
const plannerTools = [...TOOLS, TINYFISH_WEB_SEARCH_TOOL];

const TASK =
  "Find the official homepage of the Python package 'httpx'. " +
  "Do not navigate yet — just work out which URL it is.";

// The policy deps a real run would supply. The vault is empty, so nothing
// resolves and any token in a query is a straight refusal.
const policyDeps = {
  vaultTokens: () => [],
  resolve: (t) => t,
  mask: (v) => `${String(v).slice(0, 2)}***`,
  search: async () => ({ text: "", bytes: 0, results: 0 }),
  signal: new AbortController().signal,
  searchesUsed: 0,
  maxSearchesPerRun: 3,
  tokenize: () => "<CRED_1>",
};

async function askForSearch(planner) {
  return planner.run({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: TASK }],
    tools: plannerTools,
    signal: AbortSignal.timeout(60_000),
    onText: () => {},
  });
}

console.log(`\nModels under test: ${models.join(", ")}`);
console.log("\n1. A real model, the real schema — does it call web_search?");

const results = [];
let winner = null;
for (const model of models) {
  const planner = createOpenAIPlanner("openrouter", apiKey, model);
  const t0 = Date.now();
  try {
    const turn = await askForSearch(planner);
    const call = turn.toolCalls.find((c) => c.name === "web_search");
    const ms = Date.now() - t0;
    results.push({ model, ok: !!call, ms, calls: turn.toolCalls.map((c) => c.name).join(",") || "(none)" });
    console.log(
      `  ${call ? "✓" : "✗"} ${model} — ${ms} ms — ${call ? "web_search" : `no tool call (stop=${turn.stopReason}, got ${results.at(-1).calls})`}`,
    );
    if (call && !winner) winner = { model, planner, turn, call };
    if (winner) break; // one working model is enough for the legs below
  } catch (err) {
    results.push({ model, ok: false, ms: Date.now() - t0, error: String(err?.message ?? err).slice(0, 100) });
    console.log(`  ✗ ${model} — ERROR ${results.at(-1).error}`);
  }
}

const worked = results.filter((r) => r.ok).length;
console.log(`\n  ${worked}/${results.length} model(s) produced a web_search call`);

if (!winner) {
  check(
    "at least one real model can call web_search with this schema",
    false,
    "no tested model emitted the tool — this WOULD be a schema defect",
  );
  console.log(`\nFAIL — ${failed} failure(s)`);
  process.exit(1);
}

console.log(`\nContinuing with ${winner.model}`);
console.log(`  args: ${JSON.stringify(winner.call.input).slice(0, 160)}`);

console.log("\n2. Those arguments survive the real policy");
const verdict = planSearch(winner.call.input, policyDeps, { allowResolvedQueries: false, maxResults: 5 });
check("planSearch accepts the model's arguments", verdict.ok === true, verdict.ok ? "" : verdict.error?.slice(0, 160));
if (verdict.ok) {
  check("a query was produced", verdict.plan.query.length > 0, JSON.stringify(verdict.plan.query).slice(0, 80));
  check("the query is within the 500-char bound", verdict.plan.query.length <= 500);
  check("max_results is clamped to 1-20", verdict.plan.maxResults >= 1 && verdict.plan.maxResults <= 20, String(verdict.plan.maxResults));
}

console.log("\n3. Round trip: real transport, results fed back to the same model");
if (!tinyfishKey) {
  console.log("  (skipped: TINYFISH_API_KEY not set, so no request was sent)");
} else {
  let dispatched;
  try {
    dispatched = await dispatchSearch(
      winner.call.input,
      {
        ...policyDeps,
        search: async (plan, signal) => {
          const res = await searchWeb(tinyfishKey, plan, { signal });
          return {
            text: formatSearchResults(res, { maxResults: plan.maxResults }),
            bytes: res.bytes,
            results: res.results.length,
          };
        },
      },
      { allowResolvedQueries: false, maxResults: 5 },
    );
  } catch (err) {
    dispatched = { ok: false, error: String(err?.message ?? err) };
  }

  check("the model's own query survives a real search", dispatched.ok === true, dispatched.ok ? `${dispatched.results} result(s), ${dispatched.bytes} B` : dispatched.error?.slice(0, 160));

  if (dispatched.ok) {
    const turn2 = await winner.planner.run({
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: TASK },
        { role: "assistant", text: "", toolCalls: [winner.call] },
        { role: "tool", results: [{ id: winner.call.id, content: dispatched.content }] },
      ],
      tools: plannerTools,
      signal: AbortSignal.timeout(60_000),
      onText: () => {},
    });
    check("the follow-up turn completes", true);
    // Assert against what the TRANSPORT returned, not a domain remembered by
    // whoever wrote this test. (The first version hardcoded python-httpx.dev
    // and failed against a model that correctly answered python-httpx.org —
    // the actual #1 result. Hardcoding was the bug.) Every result URL is
    // offered, so this proves the answer came from the search rather than from
    // the model's memory, which is the property that matters.
    const returnedHosts = dispatched.content
      .split(/\s+/)
      .filter((w) => /^https?:\/\//.test(w))
      .map((w) => { try { return new URL(w.trim()).host; } catch { return ""; } })
      .filter(Boolean);
    const named = /https?:\/\/[^\s)]+/i.exec(turn2.text)?.[0] ?? "";
    let namedHost = "";
    try { namedHost = named ? new URL(named).host : ""; } catch { /* leave empty */ }
    check(
      "the model names a URL that came from the results",
      namedHost !== "" && returnedHosts.includes(namedHost),
      `${namedHost || "(none)"} — returned: ${returnedHosts.slice(0, 3).join(", ")}`,
    );
  }
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
