/**
 * TinyFish Search client + wiring invariant — harness.
 *
 * WHAT THIS PROVES
 *
 * Two separate things, on purpose:
 *
 * 1. TRANSPORT. The wire shape PRY would send (endpoint, query parameters,
 *    X-API-Key), the parsing of the documented response, the egress byte count,
 *    and the failure messages a planner would actually be handed. All of it
 *    against a stubbed `fetch`, so it is deterministic, free, and needs no key.
 *
 * 2. THE WIRING CONTRACT. The loop shows `web_search` to the planner only when
 *    a key exists, so the base `TOOLS` list must stay unchanged, the tool must
 *    be registered read-only, and the settings slot must default to empty. A
 *    sentence in the README is not a check, so this imports the real modules,
 *    asserts the interface a fresh checkout presents, and then drives
 *    `dispatchSearch` with a stub transport to prove every refusal happens
 *    BEFORE a request and every result is tokenized after one.
 *
 * It does NOT prove the live service answers: that is
 * `scripts/ai-live-check.mjs` territory (and deliberately costs a key + a
 * network).
 *
 * USAGE
 *
 *   node scripts/tinyfish-test.mjs
 *
 * Exits non-zero on any failure.
 */
import { build } from "esbuild";
import {
  buildSearchUrl,
  searchWeb,
  formatSearchResults,
  TinyFishError,
  TINYFISH_SEARCH_ENDPOINT,
} from "../src/background/tinyfish.ts";

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function response(body, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Bundle a source module into an importable ES module string.
 *
 * WHY A BUNDLE: `web-search.ts` imports `../shared/text-pii-patterns` the way
 * the rest of the codebase does — extensionless, resolved by esbuild's
 * `bundler` moduleResolution. Node's own ESM loader requires the full file
 * extension, so a bare `import("../src/background/web-search.ts")` fails with
 * ERR_MODULE_NOT_FOUND on its first transitive import. Bundling here is the
 * same move `agent-frame-audit-test.mjs` makes, and it means the code under
 * test is the real source file, not a copy.
 */
async function bundle(entry, resolveDir) {
  const out = await build({
    stdin: { contents: entry, resolveDir, sourcefile: "tinyfish-entry.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

/** Import a bundled string as an ES module, without touching disk. */
async function importBundle(code) {
  const url = `data:text/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`;
  return import(url);
}

// ─── URL construction ────────────────────────────────────────────────────────

console.log("\nURL shape");
{
  const url = buildSearchUrl({
    query: "open-source pdf invoice parser python",
    purpose: "Find a library the agent can read docs for",
    location: "IN",
    language: "en",
    includeDomains: ["github.com", " PyPI.org "],
    excludeDomains: ["pinterest.com"],
    domainType: "web",
    page: 2,
    recencyMinutes: 1440,
  });
  check("hits the documented endpoint", url.origin + url.pathname.replace(/\/$/, "") === TINYFISH_SEARCH_ENDPOINT);
  check("query is encoded as a parameter", url.searchParams.get("query") === "open-source pdf invoice parser python");
  check("purpose rides along", url.searchParams.get("purpose") === "Find a library the agent can read docs for");
  check("location/language ride along", url.searchParams.get("location") === "IN" && url.searchParams.get("language") === "en");
  check("domains are comma-joined and lowercased", url.searchParams.get("include_domains") === "github.com,pypi.org");
  check("excluded domains ride along", url.searchParams.get("exclude_domains") === "pinterest.com");
  check("page rides along", url.searchParams.get("page") === "2");
  check("recency rides along", url.searchParams.get("recency_minutes") === "1440");
  check("default domain_type is omitted", url.searchParams.get("domain_type") === null);
}
{
  const url = buildSearchUrl({ query: "llm agents", domainType: "news" });
  check("news domain_type is sent", url.searchParams.get("domain_type") === "news");
  check("empty defaults are omitted", url.searchParams.get("location") === null && url.searchParams.get("page") === null);
}

console.log("\nInput validation");
{
  const throws = (fn) => {
    try { fn(); return null; } catch (e) { return e; }
  };
  check("empty query refused", throws(() => buildSearchUrl({ query: "   " })) instanceof TinyFishError);
  check("over-long query refused with guidance", /under 500/.test(throws(() => buildSearchUrl({ query: "x".repeat(501) }))?.message ?? ""));
  check("page 11 refused", throws(() => buildSearchUrl({ query: "x", page: 11 })) instanceof TinyFishError);
  check("negative page refused", throws(() => buildSearchUrl({ query: "x", page: -1 })) instanceof TinyFishError);
  check("unknown domain type refused", throws(() => buildSearchUrl({ query: "x", domainType: "video" })) instanceof TinyFishError);
  check("recency on research_paper refused", throws(() => buildSearchUrl({ query: "x", domainType: "research_paper", recencyMinutes: 60 })) instanceof TinyFishError);
  check("over-long purpose refused", throws(() => buildSearchUrl({ query: "x", purpose: "y".repeat(2001) })) instanceof TinyFishError);
}

// ─── Request + parse ─────────────────────────────────────────────────────────

const documented = {
  query: "web automation tools",
  results: [
    {
      position: 1,
      site_name: "example.com",
      title: "Example result",
      snippet: "A short description of the page.",
      url: "https://example.com/page",
      published_at: "2026-10-01",
    },
    {
      position: 2,
      site_name: "docs.example.org",
      title: "Second result",
      snippet: "",
      url: "https://docs.example.org/guide",
    },
  ],
  total_results: 10,
  page: 0,
};

console.log("\nRequest and response");
let seen = null;
{
  const result = await searchWeb("tf_live_test_key", { query: "web automation tools" }, {
    fetchImpl: async (input, init) => {
      seen = { input: String(input), init };
      return response(documented);
    },
  });
  check("GET is used", seen.init.method === "GET");
  check("X-API-Key header is used (not Bearer)", seen.init.headers["X-API-Key"] === "tf_live_test_key" && !("Authorization" in seen.init.headers));
  check("Accept is JSON", seen.init.headers.Accept === "application/json");
  check("parses documented fields", result.results[0].title === "Example result" && result.results[0].siteName === "example.com" && result.results[0].url === "https://example.com/page");
  check("optional date is carried", result.results[0].publishedAt === "2026-10-01");
  check("total_results and page are carried", result.totalResults === 10 && result.page === 0);
  check("egress bytes are measured", result.bytes > 0 && result.requestBytes > 0 && result.responseBytes > 0 && result.bytes === result.requestBytes + result.responseBytes,
    `${result.requestBytes}+${result.responseBytes}`);
  check("total bytes equal the actual body", result.responseBytes === new TextEncoder().encode(JSON.stringify(documented)).length);
}
{
  const many = { ...documented, results: Array.from({ length: 12 }, (_, i) => ({ position: i + 1, url: `https://e.com/${i}`, title: `t${i}`, snippet: "" })) };
  const result = await searchWeb("k", { query: "x", maxResults: 5 }, { fetchImpl: async () => response(many) });
  check("maxResults caps the list", result.results.length === 5);
}
{
  const noUrl = { query: "x", results: [{ position: 1, title: "no url" }, { position: 2, url: "https://ok.example", title: "ok" }], total_results: 2, page: 0 };
  const result = await searchWeb("k", { query: "x" }, { fetchImpl: async () => response(noUrl) });
  check("a result with no URL is dropped", result.results.length === 1 && result.results[0].url === "https://ok.example");
}
{
  const missingKey = await searchWeb("   ", { query: "x" }, { fetchImpl: async () => response(documented) }).catch((e) => e);
  check("empty key fails before any request", missingKey instanceof TinyFishError && /No TinyFish API key/.test(missingKey.message));
}

// ─── Failures ────────────────────────────────────────────────────────────────

console.log("\nFailure messages");
const fail = async (status, body) => searchWeb("secret-key", { query: "x" }, { fetchImpl: async () => response(body, status) }).catch((e) => e);
{
  const e = await fail(401, { message: "invalid key secret-key" });
  check("401 names the fix", e.status === 401 && /API key/.test(e.message));
  check("401 is not retryable", e.retryable === false);
  check("error never echoes the key", !e.message.includes("secret-key"));
}
{
  const e = await fail(429, { message: "slow down" });
  check("429 is retryable", e.status === 429 && e.retryable === true);
  check("429 names the rate limit", /30 requests\/minute/.test(e.message));
}
{
  const e = await fail(402, { code: "INSUFFICIENT_CREDITS", message: "no funds" });
  check("402 names the allowance reset", e.status === 402 && /00:00 UTC/.test(e.message));
}
{
  const e = await fail(503, { message: "unavailable" });
  check("503 is retryable", e.status === 503 && e.retryable === true);
}
{
  const e = await fail(500, "not json at all");
  check("non-JSON error body is tolerated", e.status === 500 && /temporarily unavailable/.test(e.message));
}
{
  const e = await searchWeb("k", { query: "x" }, { fetchImpl: async () => response("not json") }).catch((err) => err);
  check("non-JSON 200 is reported", e instanceof TinyFishError && /not JSON/.test(e.message));
}
{
  const e = await searchWeb("k", { query: "x" }, { fetchImpl: async () => { throw new TypeError("network down"); } }).catch((err) => err);
  check("network failure is reported as retryable", e instanceof TinyFishError && e.retryable === true && /network error/.test(e.message));
}
{
  const e = await searchWeb("k", { query: "x" }, {
    timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  }).catch((err) => err);
  check("timeout is bounded and named", e instanceof TinyFishError && /did not answer within/.test(e.message));
}
{
  const controller = new AbortController();
  controller.abort();
  const e = await searchWeb("k", { query: "x" }, {
    signal: controller.signal,
    fetchImpl: async () => { throw new Error("should not be called"); },
  }).catch((err) => err);
  check("an already-aborted run does not send", e instanceof TinyFishError && /cancelled/.test(e.message));
}

// ─── Formatting ──────────────────────────────────────────────────────────────

console.log("\nPlanner-facing text");
{
  const long = { ...documented, results: [{ position: 1, site_name: "example.com", title: "T".repeat(200), snippet: "S".repeat(400), url: "https://example.com/page" }] };
  const text = formatSearchResults(long);
  check("includes the query", text.includes("web automation tools"));
  check("includes the URL", text.includes("https://example.com/page"));
  check("truncates the title", text.includes("...") && !text.includes("T".repeat(121)));
  check("truncates the snippet", !text.includes("S".repeat(221)));
  check("explains ranking", /ranked best-first/.test(text));
}
{
  const text = formatSearchResults({ query: "nothing", results: [], totalResults: 0, page: 0, bytes: 0, requestBytes: 0, responseBytes: 0 });
  check("empty results are stated, not implied", text.includes("(no results)"));
}

// ─── Wiring invariant: the base TOOLS list stays pure ────────────────────────
//
// The run composes `plannerTools = TOOLS + web_search` only when a key exists,
// so `TOOLS` itself must stay the 16 page tools forever. If `web_search` were
// added to `TOOLS` by accident, a no-key install would start offering a tool
// that can only refuse — which is worse than not having it, because the model
// spends a turn discovering a configuration fact. That is the invariant here,
// and the transport tests above would all pass even if it were violated.
// Plain JavaScript only — this file is executed by Node, not compiled by tsc.

const toolsMod = await import("../src/background/tools.ts").then((m) => m.default ?? m);
const settingsMod = await import("../src/shared/types.ts").then((m) => m.default ?? m);

console.log("\nWiring invariant — base tool list stays pure, composed per run");

const tfEntry = toolsMod && typeof toolsMod === "object" ? toolsMod.TINYFISH_WEB_SEARCH_TOOL : undefined;
const TINYFISH_TOOL = tfEntry && typeof tfEntry === "object" && "name" in tfEntry ? tfEntry : undefined;
const TOOLS = toolsMod && Array.isArray(toolsMod.TOOLS) ? toolsMod.TOOLS : [];
const READ_ONLY_ACTIONS = toolsMod && toolsMod.READ_ONLY_ACTIONS instanceof Set ? toolsMod.READ_ONLY_ACTIONS : new Set();
const actionChangesFrame = toolsMod && typeof toolsMod.actionChangesFrame === "function" ? toolsMod.actionChangesFrame : null;

check(
  "TINYFISH_WEB_SEARCH_TOOL is exported and named web_search",
  !!TINYFISH_TOOL && TINYFISH_TOOL.name === "web_search",
);
check(
  "TINYFISH_WEB_SEARCH_TOOL is a distinct object from the TOOLS entries",
  !!TINYFISH_TOOL && !TOOLS.includes(TINYFISH_TOOL),
);

const tparams = TINYFISH_TOOL && "parameters" in TINYFISH_TOOL ? TINYFISH_TOOL.parameters : undefined;
if (tparams && typeof tparams === "object" && "properties" in tparams) {
  const props = tparams.properties ?? {};
  const required = Array.isArray(tparams.required) ? tparams.required : [];
  check("web_search schema has query", typeof props.query !== "undefined");
  check("web_search schema has purpose", typeof props.purpose !== "undefined");
  check("web_search schema has domain_type", typeof props.domain_type !== "undefined");
  check("web_search schema has include_domains", typeof props.include_domains !== "undefined");
  check("web_search schema has exclude_domains", typeof props.exclude_domains !== "undefined");
  check("web_search schema has max_results", typeof props.max_results !== "undefined");
  check("web_search schema declares exactly six properties", Object.keys(props).length === 6);
  check("web_search requires query only", required.length === 1 && required[0] === "query");
  check("domain_type is constrained to the documented three", Array.isArray(props.domain_type?.enum) && props.domain_type.enum.join(",") === "web,news,research_paper");
} else {
  check("web_search schema has a properties bag", false);
}

const toolsHaveWebSearch = TOOLS.some((t) => t && typeof t === "object" && t.name === "web_search");
check("TOOLS does NOT include web_search (composed per run instead)", !toolsHaveWebSearch);
check("TOOLS still has exactly 16 page tools", TOOLS.length === 16);
check(
  "TOOLS is still the same action set",
  TOOLS.map((t) => t.name).join(",") ===
    "read_page,click,click_text,type,type_text,select,scroll,key,find_text,wait,navigate,go_back,open_tab,list_tabs,switch_tab,close_tab",
);

check("web_search is registered read-only", READ_ONLY_ACTIONS.has("web_search"));
check("READ_ONLY_ACTIONS still has exactly 4 entries", READ_ONLY_ACTIONS.size === 4);
check(
  "the three pre-existing read-only actions are untouched",
  READ_ONLY_ACTIONS.has("read_page") && READ_ONLY_ACTIONS.has("find_text") && READ_ONLY_ACTIONS.has("wait"),
);

if (actionChangesFrame) {
  check("web_search does not trigger a frame capture", actionChangesFrame("web_search") === false);
  check("navigate still triggers a frame capture", actionChangesFrame("navigate") === true);
  check("click still triggers a frame capture", actionChangesFrame("click") === true);
} else {
  check("actionChangesFrame is exported", false);
}

console.log("\nWiring invariant — settings slot, default off");

const DEFAULT_SETTINGS = settingsMod && typeof settingsMod === "object" ? settingsMod.DEFAULT_SETTINGS : undefined;
const normaliseSettings = settingsMod && typeof settingsMod.normaliseSettings === "function" ? settingsMod.normaliseSettings : null;

check("DEFAULT_SETTINGS exposes a search slot", !!DEFAULT_SETTINGS && typeof DEFAULT_SETTINGS === "object" && "search" in DEFAULT_SETTINGS);
check(
  "DEFAULT_SETTINGS.search.apiKey is empty (off by default)",
  !!DEFAULT_SETTINGS && !!DEFAULT_SETTINGS.search && DEFAULT_SETTINGS.search.apiKey === "",
);

{
  const fresh = normaliseSettings ? normaliseSettings(undefined) : undefined;
  check("normaliseSettings(undefined) yields a search slot", !!fresh && !!fresh.search);
  check("normaliseSettings(undefined) leaves the key empty", !!fresh?.search && fresh.search.apiKey === "");
}
{
  const partial = normaliseSettings ? normaliseSettings({ search: { apiKey: "" } }) : undefined;
  check("normaliseSettings keeps an explicitly empty key", !!partial?.search && partial.search.apiKey === "");
}
{
  const withKey = normaliseSettings ? normaliseSettings({ search: { apiKey: "tf_test_key" } }) : undefined;
  check("normaliseSettings keeps a supplied key", !!withKey?.search && withKey.search.apiKey === "tf_test_key");
}
{
  // A stored block written by an older build may be `{}`. A shallow spread would
  // replace the default with it and leave `apiKey` undefined, so this pins the
  // deep merge rather than the happy path.
  const emptyBlock = normaliseSettings ? normaliseSettings({ search: {} }) : undefined;
  check("normaliseSettings deep-merges an empty search block", !!emptyBlock?.search && emptyBlock.search.apiKey === "");
}
{
  const nullBlock = normaliseSettings ? normaliseSettings({ search: null }) : undefined;
  check("normaliseSettings tolerates a null search block", !!nullBlock?.search && nullBlock.search.apiKey === "");
}
{
  // Regression guard: adding the slot must not disturb the existing settings.
  const existing = normaliseSettings
    ? normaliseSettings({ provider: "groq", fastPlanner: true, privacy: { destroyFaces: false } })
    : undefined;
  check("normaliseSettings still honours the provider", existing?.provider === "groq");
  check("normaliseSettings still honours fastPlanner", existing?.fastPlanner === true);
  check("normaliseSettings still honours a privacy override", existing?.privacy?.destroyFaces === false);
  check("normaliseSettings still fills the search slot when absent", !!existing?.search);
}

// ─── Dispatch: the policy in front of the transport ──────────────────────────
//
// These drive the real `dispatchSearch`. The transport is a stub that records
// what it was asked for, so "refused" can be checked as "the transport was
// never called" — the only definition that matters, because a policy that
// refuses AFTER sending is a leak with an error message attached.

console.log("\nDispatch policy");
{
  const { dispatchSearch } = await importBundle(
    await bundle('export { dispatchSearch } from "./src/background/web-search.ts";', process.cwd()),
  );

  const mask = (v) => `${v.slice(0, 2)}***`;
  const limits = { allowResolvedQueries: false, maxResults: 5 };

  /** A stub run: vault has one token, transport records and answers. */
  function harness(overrides = {}) {
    const calls = [];
    const tokenized = [];
    const deps = {
      vaultTokens: (text) => (/<CRED_1>/.test(text) ? ["<CRED_1>"] : []),
      resolve: (text) => text.replace("<CRED_1>", "alice@example.com"),
      mask,
      search: async (plan, signal) => {
        calls.push({ plan, aborted: signal.aborted });
        return { text: "ranked", bytes: 1200, results: 2 };
      },
      signal: new AbortController().signal,
      searchesUsed: 0,
      maxSearchesPerRun: 3,
      tokenize: (value, kind) => {
        tokenized.push({ value, kind });
        return `<${kind === "api_key" ? "KEY" : "CRED"}_1>`;
      },
      ...overrides,
    };
    return { calls, tokenized, deps };
  }

  {
    const h = harness();
    const out = await dispatchSearch({ query: "check <CRED_1> portal" }, h.deps, limits);
    check("a vaulted query is refused", out.ok === false);
    check("the refusal names the token, not a value", out.ok === false && out.error.includes("<CRED_1>"));
    check("the refusal says nothing was sent", out.ok === false && /third party/.test(out.error));
    check("the transport was never called", h.calls.length === 0);
  }

  {
    // The user's standing opt-in: resolved, then sent — and the transport sees
    // the RESOLVED value, which is what actually leaves.
    const h = harness();
    const out = await dispatchSearch({ query: "check <CRED_1> portal" }, h.deps, {
      allowResolvedQueries: true,
      maxResults: 5,
    });
    check("an allowed vaulted query is sent", out.ok === true);
    check("the transport sees the resolved value", h.calls[0]?.plan.query === "check alice@example.com portal");
    check("the raw value is not echoed back to the planner", out.ok === true && !out.content.includes("alice@example.com"));
  }

  {
    const h = harness();
    const out = await dispatchSearch({ query: "invoice for 4111 1111 1111 1111" }, h.deps, limits);
    check("a card number in a query is refused", out.ok === false);
    check("the masked finding is shown", out.ok === false && /\*\*\*/.test(out.error));
    check("the card number is not repeated in the error", out.ok === false && !out.error.includes("4111 1111 1111 1111"));
    check("no request on a PII refusal", h.calls.length === 0);
  }

  {
    const h = harness({ searchesUsed: 3 });
    const out = await dispatchSearch({ query: "harmless public query" }, h.deps, limits);
    check("the per-run cap refuses locally", out.ok === false && /already used/.test(out.error));
    check("the cap refusal sends nothing", h.calls.length === 0);
  }

  {
    const h = harness();
    const out = await dispatchSearch({ query: "   " }, h.deps, limits);
    check("an empty query is refused", out.ok === false);
    check("an empty query sends nothing", h.calls.length === 0);
  }

  {
    const h = harness({
      search: async () => {
        throw new Error("HTTP 429");
      },
    });
    const out = await dispatchSearch({ query: "public query" }, h.deps, limits);
    check("a transport failure is a tool error, not a throw", out.ok === false && /HTTP 429/.test(out.error));
    check("the failure tells the planner not to retry blindly", out.ok === false && /retry blindly/.test(out.error));
  }

  {
    const h = harness({
      search: async () => ({
        text: "contact bob@example.com for details",
        bytes: 900,
        results: 1,
      }),
    });
    const out = await dispatchSearch({ query: "public query" }, h.deps, limits);
    check("a successful search returns content", out.ok === true && out.content.includes("1 result(s)"));
    check("the egress bytes are reported", out.ok === true && out.bytes === 900);
    check("the query that left is reported for the wire log", out.ok === true && out.query === "public query");
    check("PII in results is handed to the vault", h.tokenized.some((t) => t.value === "bob@example.com"));
    check("PII in results does not reach the planner raw", out.ok === true && !out.content.includes("bob@example.com"));
    check("the preamble says the results are public web", out.ok === true && /public web/.test(out.content));
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
