/**
 * Live AI check: is the model actually working through PRY's real plumbing?
 *
 * WHAT THIS PROVES THAT `npm run verify` CANNOT
 *
 * The whole verification suite runs against STUBBED providers, which is the
 * only way it can be deterministic and free. That means every green assertion
 * answers "is the pipeline wired correctly", and none of them answers "does a
 * real model, given PRY's real system prompt and tool schema, produce an action
 * PRY can execute". A wrong tool schema, a prompt the model cannot follow, an
 * expired key, a provider that changed its API shape — all of those are
 * invisible to the suite and fatal in the product.
 *
 * So this script talks to a REAL endpoint, once, on purpose:
 *
 *   1. turn 1 — the model is shown a page read and the task "search YouTube for
 *      harkirat singh". It must return a well-formed tool call against the real
 *      schema (this is the step that failed in the reported run: the model kept
 *      re-reading the page instead of acting).
 *   2. turn 2 — the model is shown that tool result and must finish with
 *      coherent language, which is then measured with the SHIPPED glitch guard
 *      so a real answer and the observed glitch stream are judged by the same
 *      code that judges them in production.
 *
 * It is deliberately NOT part of `npm run verify`: it costs money, needs a key,
 * and depends on a network. Run it when you change the prompt, the tool schema,
 * or a provider adapter.
 *
 * USAGE
 *
 *   GROQ_API_KEY=gsk_...            node scripts/ai-live-check.mjs
 *   NVIDIA_API_KEY=nvapi-...        node scripts/ai-live-check.mjs   (PROVIDER=nvidia)
 *   OPENAI_API_KEY=sk-...           node scripts/ai-live-check.mjs   (PROVIDER=openai)
 *   ANTHROPIC_API_KEY=sk-ant-...    node scripts/ai-live-check.mjs   (PROVIDER=anthropic)
 *   OPENROUTER_API_KEY=sk-or-...    node scripts/ai-live-check.mjs   (PROVIDER=openrouter)
 *
 * MODEL=... overrides the model. Exit code is non-zero if any check fails, so it
 * can gate a release.
 */
import { build } from "esbuild";
import { unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundlePath = fileURLToPath(new URL("./.ai-live-bundle.mjs", import.meta.url));
process.on("exit", () => { try { unlinkSync(bundlePath); } catch {} });

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return cond;
}

// ─── Bundle the real plumbing ────────────────────────────────────────────────

// The planner stack plus the two constants every request is built from. No
// stubs: if this needs a stub to import, the check would be testing the stub.
const bundleText = (
  await build({
    stdin: {
      contents: `
        export { createPlanner } from "./src/background/providers/index.ts";
        export { SYSTEM_PROMPT } from "./src/background/prompt.ts";
        export { TOOLS } from "./src/background/tools.ts";
        export { DEFAULT_SETTINGS } from "./src/shared/types.ts";
        export { isWordSalad, punctuationDensity, nonLatinLetterScripts, isDegenerateOutput, degenerationRatio } from "./src/background/agent.ts";
      `,
      resolveDir: root,
      sourcefile: "ai-live-entry.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "error",
  })
).outputFiles[0].text;

await writeFile(bundlePath, bundleText, "utf8");
const mod = await import(pathToFileURL(bundlePath).href);

// ─── Provider + key from the environment ─────────────────────────────────────

const PROVIDER = (process.env.PROVIDER ?? "groq").toLowerCase();
const KEY_VARS = {
  groq: "GROQ_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};
const keyVar = KEY_VARS[PROVIDER];
if (!keyVar) {
  console.error(`Unknown PROVIDER "${PROVIDER}". Known: ${Object.keys(KEY_VARS).join(", ")}`);
  process.exit(2);
}
const apiKey = process.env[keyVar] ?? "";
if (!apiKey) {
  console.error(
    `No key found in ${keyVar}. This check needs a REAL key — it exists to test the ` +
      `provider, so there is nothing useful it can do without one.`,
  );
  process.exit(2);
}

const settings = {
  ...mod.DEFAULT_SETTINGS,
  provider: PROVIDER,
  apiKeys: { ...mod.DEFAULT_SETTINGS.apiKeys, [PROVIDER]: apiKey },
  models: {
    ...mod.DEFAULT_SETTINGS.models,
    [PROVIDER]: process.env.MODEL ?? mod.DEFAULT_SETTINGS.models[PROVIDER],
  },
};

const model = settings.models[PROVIDER];
const keyHint = apiKey.length > 8 ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : "set";
console.log(`\n=== live AI check: ${PROVIDER} / ${model} (key ${keyHint}) ===\n`);

// ─── A page read, in the shape the executor returns ──────────────────────────

const PAGE_READ = [
  "[7] searchbox \"Search\" (inputType=text)",
  "[8] button \"Search\"",
  "[9] link \"Home\"",
  "[12] link \"Shorts\"",
  "[14] link \"Subscriptions\"",
  "[31] link \"Harkirat Singh — YouTube channel\"",
  "[32] link \"Harkirat Singh explains the system design of a URL shortener (2:14:07)\"",
].join("\n");

const TASK =
  "Task: search YouTube for harkirat singh, then report the first result you can see.\n\n" +
  "--- Current page ---\nURL: https://www.youtube.com/\nTitle: YouTube\n" +
  `Elements:\n${PAGE_READ}\n\nPage text:\nHome Shorts Subscriptions Harkirat Singh`;

const messages = [{ role: "user", content: TASK }];

/** One real planner turn, with the streaming callbacks the loop installs. */
async function runTurn(label, conv) {
  const planner = mod.createPlanner(settings);
  const started = Date.now();
  let streamed = "";
  let reasoning = "";
  const turn = await planner.run({
    system: mod.SYSTEM_PROMPT,
    messages: conv,
    tools: mod.TOOLS,
    signal: new AbortController().signal,
    onText: (delta) => { streamed += delta; },
    onThought: (delta) => { reasoning += delta; },
  });
  const ms = Date.now() - started;
  console.log(`  · ${label}: ${(ms / 1000).toFixed(1)}s · ${streamed.length} chars out · ${reasoning.length} chars reasoning`);
  return { turn, ms, streamed, reasoning };
}

// ─── Turn 1: it must ACT on the page it was shown ────────────────────────────

console.log("── turn 1: a real tool call against the real schema ──");

const TOOL_NAMES = new Set(mod.TOOLS.map((t) => t.name));
let first;
try {
  first = await runTurn("turn 1", messages);
} catch (error) {
  check("the provider answered at all", false, `${error?.constructor?.name}: ${String(error?.message ?? error).slice(0, 300)}`);
  console.log("\nThe provider call itself failed — nothing else can be judged from here.");
  process.exit(1);
}

check("the provider answered at all", true, `${(first.ms / 1000).toFixed(1)}s`);

// The channel split is not cosmetic. `onText` is the channel the panel paints as
// PRY's ANSWER, and `onThought` is the one that proves liveness and feeds the
// deliberation guard. A provider that forwards chain-of-thought to `onText`
// prints the model's private analysis as its reply and leaves reasoningChars at
// zero; Groq did exactly that until this check was written, which is why the
// assertion is here rather than in a comment.
check("what streamed as the answer is what the loop will treat as the answer",
  first.streamed === first.turn.text,
  `streamed ${first.streamed.length} chars, turn.text ${first.turn.text.length} chars`);
check("chain-of-thought arrives on the reasoning channel, if the model streams any",
  first.reasoning.length === 0 || !first.streamed.includes(first.reasoning.slice(0, 40)),
  `${first.reasoning.length} chars reasoning`);

const calls = first.turn.toolCalls ?? [];
check("the model returned at least one tool call", calls.length > 0,
  `${calls.length} call(s); text ${JSON.stringify(first.turn.text.slice(0, 60))}`);
check("every call names a tool that exists in the shipped schema",
  calls.every((c) => TOOL_NAMES.has(c.name)),
  calls.map((c) => c.name).join(", ") || "(none)");
const acted = calls.some((c) => ["type", "click", "click_text", "read_page", "key"].includes(c.name));
check("it responds to the page by acting, not only by reading", calls.some((c) => c.name !== "read_page"),
  calls.map((c) => c.name).join(", ") || "(none)");
check("no call carries arguments that are not in the schema", calls.every((c) => {
  const spec = mod.TOOLS.find((t) => t.name === c.name);
  if (!spec) return false;
  const allowed = Object.keys(spec.parameters.properties ?? {});
  return Object.keys(c.input ?? {}).every((k) => allowed.includes(k));
}), JSON.stringify(calls.map((c) => c.input)));

// The reported failure: the model re-reads the page forever instead of typing into
// the search box it was just shown. Either handle is a pass — the query has to
// reach the field — but which one it chose is worth printing, because preferring a
// name over an available id is a real (if survivable) regression: a name can match
// several controls, an id from the current read names exactly one.
const typedById = calls.find(
  (c) => c.name === "type" && String(c.input?.text ?? "").toLowerCase().includes("harkirat"),
);
const typedByName = calls.find(
  (c) => c.name === "type_text" && /harkirat/i.test(String(c.input?.text ?? "")),
);
check("it types the query into the search field rather than re-reading",
  Boolean(typedById || typedByName),
  JSON.stringify((typedById ?? typedByName)?.input) || `got ${calls.map((c) => c.name).join(", ") || "no calls"}`);
console.log(
  `    handle used: ${typedById ? "type (id from the read)" : typedByName ? "type_text (field name)" : "none"}`,
);

// ─── Turn 2: it must finish in language ──────────────────────────────────────

console.log("\n── turn 2: a coherent final answer, judged by the SHIPPED guard ──");

const assistantTurn = {
  role: "assistant",
  text: first.turn.text || "(acted)",
  toolCalls: calls,
};
const results = calls.map((c) => ({
  id: c.id,
  name: c.name,
  content:
    c.name === "type"
      ? `Typed ${JSON.stringify(c.input.text)} into [7] searchbox "Search". Field now shows: ` +
        `${JSON.stringify(c.input.text)}, and pressed Enter.\n\n--- Page after this action ---\n` +
        `URL: https://www.youtube.com/results?search_query=harkirat+singh\n` +
        "Elements:\n[41] link \"Harkirat Singh - YouTube channel\"\n" +
        "[42] link \"Harkirat Singh: System Design of Instagram (1:02:11)\""
    : "ok",
  isError: false,
}));
const conv2 = [
  ...messages,
  assistantTurn,
  { role: "tool", results },
  {
    role: "user",
    content:
      "The page changed as shown. Finish the task: tell the user what the first result is, " +
      "in one or two sentences. Do not call another tool.",
  },
];

let second;
try {
  second = await runTurn("turn 2", conv2);
} catch (error) {
  check("turn 2 answered", false, String(error?.message ?? error).slice(0, 300));
  console.log(`\n${failed} check(s) failed.`);
  process.exit(1);
}

const answer = (second.turn.text ?? "").trim();
check("the model produced a final answer instead of more tool calls",
  answer.length > 0 && (second.turn.toolCalls ?? []).length === 0,
  `${answer.length} chars, ${(second.turn.toolCalls ?? []).length} tool call(s)`);
check("the answer is language a person can read, by the shipped glitch check",
  !mod.isWordSalad(answer),
  `punct ${mod.punctuationDensity(answer).toFixed(3)} · scripts ${mod.nonLatinLetterScripts(answer).join(",") || "latin only"}`);
check("it is not a repetition loop either",
  !mod.isDegenerateOutput(answer),
  `repeat ratio ${mod.degenerationRatio(answer).toFixed(3)}`);
check("it actually mentions what it found rather than answering generically",
  /harkirat/i.test(answer),
  JSON.stringify(answer.slice(0, 140)));

console.log("\n  answer: " + JSON.stringify(answer.slice(0, 220)) + (answer.length > 220 ? "…" : ""));

// ─── Turn 3: does it reach for the id-free typing tool? ──────────────────────
//
// A new tool the model does not choose is not a fix. The reported YouTube run had
// ids for the page chrome and NONE for the search box — the box is visible on
// screen while absent from the read — so this shows the model exactly that page
// and checks which tool it picks. The failure to catch is a second read_page (the
// behaviour that looped) or a guessed id; the pass is type_text, named by the
// field rather than numbered.
console.log("\n── turn 3: a search box with no element id ──");

const NO_ID_TASK =
  "Task: search YouTube for harkirat singh.\n\n--- Current page ---\n" +
  "URL: https://www.youtube.com/\nTitle: YouTube\nElements:\n" +
  "[0] link \"Home\"\n[1] link \"Shorts\"\n[2] link \"Subscriptions\"\n" +
  "Page text:\nHome  Shorts  Subscriptions  Search  Sign in";

let third;
try {
  third = await runTurn("turn 3", [{ role: "user", content: NO_ID_TASK }]);
} catch (error) {
  check("turn 3 answered", false, String(error?.message ?? error).slice(0, 300));
  third = null;
}
if (third) {
  const thirdCalls = third.turn.toolCalls ?? [];
  const names = thirdCalls.map((c) => c.name);
  const fieldTyped = thirdCalls.find((c) => c.name === "type_text");
  check("it does not simply re-read a page it has already been shown",
    !names.includes("read_page"), names.join(", ") || "(none)");
  check("it types into the field by name when the field has no id",
    Boolean(fieldTyped), names.join(", ") || "(none)");
  if (fieldTyped) {
    check("and it names the field the way it appears on screen, with the query to type",
      /search/i.test(String(fieldTyped.input.field ?? "")) &&
      /harkirat/i.test(String(fieldTyped.input.text ?? "")),
      JSON.stringify(fieldTyped.input));
  }
  console.log(`  · turn 3: ${(third.ms / 1000).toFixed(1)}s · chose ${names.join(", ") || "no tool"}`);
}

const totalMs = first.ms + second.ms + (third?.ms ?? 0);
console.log(`\n  total: ${(totalMs / 1000).toFixed(1)}s for ${third ? 3 : 2} turns`);

if (failed > 0) {
  console.log(`\n${failed} check(s) FAILED — the model did not work through PRY's plumbing.\n`);
  process.exit(1);
}
console.log("\nAI is working end to end: real key, real prompt, real tool schema, real answer.\n");
