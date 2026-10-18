/**
 * TinyFish Search client — harness.
 *
 * WHAT THIS PROVES
 *
 * The wire shape PRY would send (endpoint, query parameters, X-API-Key), the
 * parsing of the documented response, the egress byte count, and the failure
 * messages a planner would actually be handed. All of it against a stubbed
 * fetch, so it is deterministic, free, and runs in `npm run verify` once it is
 * added to that script.
 *
 * It does NOT prove the live service answers: that is `scripts/ai-live-check.mjs`
 * territory (and deliberately costs a key + a network).
 *
 * USAGE
 *
 *   node scripts/tinyfish-test.mjs
 *
 * Exits non-zero on any failure.
 */
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

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
