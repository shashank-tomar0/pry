/**
 * TinyFish LIVE smoke test.
 *
 * WHAT THIS IS FOR
 *
 * `tinyfish-test.mjs` proves the transport against a stubbed `fetch`: the URL
 * shape, the header, the parser, the byte counts, the error classification.
 * All of that is deterministic and needs no key — and none of it proves the
 * real service still speaks the documented dialect. APIs drift. A field gets
 * renamed, an auth scheme changes, a rate limit moves. This script is the one
 * that would notice.
 *
 * It is deliberately NOT in `npm run verify`: it costs real requests against a
 * real quota, and a CI run without a key must not silently pass by skipping
 * everything it came here to check.
 *
 * USAGE
 *
 *   TINYFISH_API_KEY=... node scripts/tinyfish-live.mjs
 *
 * Exits 0 with a clear "SKIPPED" and no network at all when the key is absent,
 * so it is safe to run unguarded. Exits non-zero on any real failure.
 *
 * PRIVACY
 *
 * The key is read from the environment and used in exactly one place: the
 * `X-API-Key` header built inside `searchWeb`. It is never written to disk,
 * never logged, and never printed — a failure message reports the HTTP status
 * and the classified cause, not the request that caused it.
 */
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const apiKey = (process.env.TINYFISH_API_KEY ?? "").trim();
if (!apiKey) {
  console.log("SKIPPED — TINYFISH_API_KEY is not set. Nothing was sent.");
  process.exit(0);
}

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// The policy module is TypeScript with extensionless imports, so bundle it the
// same way `tinyfish-test.mjs` does. The transport is bundled too, so both are
// the real shipped source rather than a re-implementation.
async function bundle(entry) {
  const out = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: "live-entry.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

const code = await bundle(`
  export { searchWeb, buildSearchUrl, formatSearchResults, TinyFishError, TINYFISH_SEARCH_ENDPOINT } from "./src/background/tinyfish.ts";
  export { planSearch, dispatchSearch, searchResultPreamble, tokenizePiiInText } from "./src/background/web-search.ts";
`);
const mod = await import(`data:text/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`);
const { searchWeb, formatSearchResults, TinyFishError, planSearch, dispatchSearch } = mod;

/** Never echo the query or the key; only what the service answered. */
function describe(err) {
  if (err instanceof TinyFishError) {
    return `TinyFishError(status=${err.status ?? "?"}, retryable=${err.retryable})`;
  }
  return err instanceof Error ? `${err.name}: ${err.message.slice(0, 120)}` : String(err);
}

console.log("\n1. A real search — the documented shape, answered by the live service");
{
  const t0 = Date.now();
  let res;
  try {
    res = await searchWeb(apiKey, {
      query: "open source pdf invoice parser python",
      purpose: "Live smoke test of the TinyFish transport",
      maxResults: 5,
    });
  } catch (err) {
    check("the live service answers a documented request", false, describe(err));
    console.log("\nNo further checks are meaningful without a working call.");
    console.log(`\nFAIL — ${failed} failure(s)`);
    process.exit(1);
  }
  const ms = Date.now() - t0;
  check("returns a query echo", typeof res.query === "string" && res.query.length > 0);
  check("returns an array of results", Array.isArray(res.results));
  check("results carry a url", res.results.every((r) => typeof r.url === "string" && /^https?:\/\//.test(r.url)));
  check("results carry a title", res.results.every((r) => typeof r.title === "string"));
  check("byte counting is non-zero and sane", res.bytes > 0 && res.bytes < 5_000_000, `${res.bytes} bytes`);
  check("request bytes are a subset of total", res.requestBytes > 0 && res.requestBytes <= res.bytes, `${res.requestBytes} request`);
  check("response bytes add up", res.responseBytes > 0 && res.responseBytes <= res.bytes, `${res.responseBytes} response`);
  check("responds inside 15s", ms < 15_000, `${ms} ms`);

  const text = formatSearchResults(res, { maxResults: 5 });
  check("formatter produces planner-facing text", text.includes(res.query) && text.includes("http"));
  console.log(`\n  first result: ${res.results[0]?.title?.slice(0, 70) ?? "(none)"}`);
  console.log(`  ${res.results[0]?.url ?? ""}`);
}

console.log("\n2. Parameters actually reach the service");
{
  // A domain filter that cannot match proves the parameter is honoured rather
  // than ignored: a service that dropped `include_domains` would return the
  // unfiltered set and this check would fail.
  const filtered = await searchWeb(apiKey, {
    query: "typescript",
    includeDomains: ["example.invalid"],
    maxResults: 5,
  }).catch((err) => ({ error: describe(err) }));
  if (filtered.error) {
    check("an impossible domain filter is accepted", false, filtered.error);
  } else {
    check(
      "an impossible domain filter returns nothing",
      filtered.results.length === 0,
      `${filtered.results.length} result(s)`,
    );
  }
}

console.log("\n3. The refusal path still means NOTHING was sent");
{
  // The policy is proven offline in tinyfish-test.mjs; here it is re-checked
  // against the real function to catch the case where a refactor made the
  // refusal conditional on something environment-dependent.
  const deps = {
    vaultTokens: (t) => (/<CRED_1>/.test(t) ? ["<CRED_1>"] : []),
    resolve: (t) => t,
    mask: (v) => `${v.slice(0, 2)}***`,
    search: async () => {
      throw new Error("MUST NOT BE CALLED");
    },
    signal: new AbortController().signal,
    searchesUsed: 0,
    maxSearchesPerRun: 3,
    tokenize: () => "<CRED_1>",
  };
  const out = await planSearch({ query: "find <CRED_1> account" }, deps, { allowResolvedQueries: false, maxResults: 5 });
  check("a vaulted query is refused", out.ok === false);
  check("the refusal names the token, not a value", out.ok === false && out.error.includes("<CRED_1>"));

  const dispatched = await dispatchSearch({ query: "find <CRED_1> account" }, deps, {
    allowResolvedQueries: false,
    maxResults: 5,
  });
  check("dispatch refuses before the transport", dispatched.ok === false);
}

console.log("\n4. A wrong key fails CLOSED, with a classified cause");
{
  const bogus = `${apiKey.slice(0, 0)}tf_live_definitely_not_a_real_key_000`;
  let threw = null;
  try {
    await searchWeb(bogus, { query: "anything", maxResults: 1 });
  } catch (err) {
    threw = err;
  }
  check("a bad key throws rather than returning empty", threw !== null);
  check("the error is classified as a TinyFishError", threw instanceof TinyFishError);
  check(
    "an auth failure is not marked retryable",
    threw instanceof TinyFishError && threw.retryable === false,
    describe(threw),
  );
  check(
    "the message names the fix, not the key",
    threw instanceof TinyFishError && !threw.message.includes(bogus) && /Options|key/i.test(threw.message),
  );
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
