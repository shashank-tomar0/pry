/**
 * TinyFish Search — a web-search channel for the planner.
 *
 * WHY THIS IS SEPARATE FROM THE PLANNER PROVIDERS
 *
 * The planners in `providers/` answer "what should I do next on this page".
 * TinyFish answers a different question: "which URL is the thing the user
 * named". Reaching a known site by navigating to a search engine costs a full
 * agent turn (navigate → read results → click), and a results page is a page
 * like any other: it gets perceived, sanitized and (with vision on) captured.
 * A search API answers the same question in one round trip, before any of that
 * work is paid.
 *
 * It is NOT a replacement for the in-browser loop. TinyFish cannot see the
 * user's tab, their session, or their pixels; everything it returns is public
 * web. The agent still performs the action on the page.
 *
 * PRIVACY CONTRACT
 *
 * The query leaves the browser. This module deliberately does no sanitizing:
 * it receives a query that the caller has already put through PRY's pipelines
 * (see the `web_search` dispatch in agent.ts). Keeping the transport free of
 * vault/tokenizer imports means it can be driven by the harness with a stubbed
 * `fetch` and no browser globals, and it keeps the one place that decides what
 * may leave (the agent loop) the one place that decides it.
 *
 * AUTH
 *
 * REST uses `X-API-Key`, not `Authorization: Bearer`. The key is per-install
 * user configuration, exactly like the planner keys. In an MV3 extension the
 * request is made from the service worker, which is not subject to page CORS
 * when the extension holds a host permission for the origin (this manifest
 * already requests `<all_urls>`), so no proxy is needed — but see the design
 * notes for why a proxy is still the right shape for a *published* build that
 * wants a shared quota.
 */

export const TINYFISH_SEARCH_ENDPOINT = "https://api.search.tinyfish.ai";

export type TinyFishDomainType = "web" | "news" | "research_paper";

export interface TinyFishSearchOptions {
  /** Required. Should already be sanitized by the caller. */
  query: string;
  /**
   * A short statement of why the search is happening. TinyFish uses it as
   * ranking signal (max 2000 chars). It leaves the browser too, so it is
   * subject to the same sanitization as the query.
   */
  purpose?: string;
  /** ISO country code, e.g. "US", "IN". Defaults to US server-side. */
  location?: string;
  /** ISO language code, e.g. "en". Defaults to en server-side. */
  language?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  domainType?: TinyFishDomainType;
  /** 0-10, per the API. Default 0. */
  page?: number;
  /** Freshness window in minutes (1..5256000). Not valid with research_paper. */
  recencyMinutes?: number;
  /** Client-side cap. The API returns up to ~10 per page. */
  maxResults?: number;
}

export interface TinyFishSearchResult {
  position: number;
  siteName: string;
  title: string;
  snippet: string;
  url: string;
  publishedAt?: string;
  publisher?: string;
  authors?: string[];
  venue?: string;
  year?: number;
  citationCount?: number;
  pdfUrl?: string;
}

export interface TinyFishSearchResponse {
  query: string;
  results: TinyFishSearchResult[];
  totalResults: number;
  page: number;
  /** Request + response bytes, for PRY's honest egress meter. */
  bytes: number;
  /** Bytes of the request alone (the query is in the URL). */
  requestBytes: number;
  /** Bytes of the response body alone. */
  responseBytes: number;
}

/** Failure with a message that is already fit to show the planner/user. */
export class TinyFishError extends Error {
  status: number | undefined;
  /** True when retrying the same request could plausibly succeed. */
  retryable: boolean;

  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = "TinyFishError";
    this.status = status;
    this.retryable = retryable;
  }
}

const MAX_QUERY_CHARS = 500;
const MAX_PURPOSE_CHARS = 2_000;
const MAX_PAGE = 10;
const MAX_RESULTS = 20;
const DEFAULT_TIMEOUT_MS = 10_000;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? undefined : trimmed;
}

function domainList(domains: string[] | undefined): string | undefined {
  const cleaned = (domains ?? [])
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d !== "");
  return cleaned.length > 0 ? cleaned.join(",") : undefined;
}

/**
 * The exact URL a search would send. Pure and exported so the harness asserts
 * the wire shape without a network, and so the egress meter can measure the
 * request before it leaves.
 */
export function buildSearchUrl(options: TinyFishSearchOptions): URL {
  const query = nonEmpty(options.query);
  if (!query) throw new TinyFishError("TinyFish search needs a non-empty query.");
  if (query.length > MAX_QUERY_CHARS) {
    throw new TinyFishError(
      `TinyFish search query is ${query.length} chars; keep it under ${MAX_QUERY_CHARS}. ` +
        "Search for the target, not for the page you already read.",
    );
  }

  const purpose = nonEmpty(options.purpose);
  if (purpose && purpose.length > MAX_PURPOSE_CHARS) {
    throw new TinyFishError(`TinyFish purpose must be under ${MAX_PURPOSE_CHARS} chars.`);
  }

  const page = options.page ?? 0;
  if (!Number.isInteger(page) || page < 0 || page > MAX_PAGE) {
    throw new TinyFishError(`TinyFish page must be an integer 0-${MAX_PAGE}.`);
  }

  const domainType = options.domainType ?? "web";
  if (domainType !== "web" && domainType !== "news" && domainType !== "research_paper") {
    throw new TinyFishError(`Unknown TinyFish domain_type "${String(domainType)}".`);
  }

  if (options.recencyMinutes !== undefined) {
    const recency = options.recencyMinutes;
    if (!Number.isInteger(recency) || recency < 1 || recency > 5_256_000) {
      throw new TinyFishError("TinyFish recency_minutes must be an integer 1-5256000.");
    }
    if (domainType === "research_paper") {
      throw new TinyFishError(
        "TinyFish recency_minutes is not supported for research_paper searches.",
      );
    }
  }

  const url = new URL(TINYFISH_SEARCH_ENDPOINT);
  url.searchParams.set("query", query);
  if (purpose) url.searchParams.set("purpose", purpose);
  if (nonEmpty(options.location)) url.searchParams.set("location", options.location!.trim());
  if (nonEmpty(options.language)) url.searchParams.set("language", options.language!.trim());
  const include = domainList(options.includeDomains);
  if (include) url.searchParams.set("include_domains", include);
  const exclude = domainList(options.excludeDomains);
  if (exclude) url.searchParams.set("exclude_domains", exclude);
  if (domainType !== "web") url.searchParams.set("domain_type", domainType);
  if (page !== 0) url.searchParams.set("page", String(page));
  if (options.recencyMinutes !== undefined) {
    url.searchParams.set("recency_minutes", String(options.recencyMinutes));
  }
  return url;
}

/** UTF-8 byte length, the unit the egress meter reports. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function statusMessage(status: number, detail: string): TinyFishError {
  const suffix = detail ? ` ${detail}` : "";
  switch (status) {
    case 400:
      return new TinyFishError(`TinyFish rejected the search request.${suffix}`, status, false);
    case 401:
      return new TinyFishError(
        "TinyFish rejected the API key (401). Check the key in Options.",
        status,
        false,
      );
    case 402:
      return new TinyFishError(
        "TinyFish's free search allowance is used up for today and the wallet balance is zero. " +
          "Search will work again after the 00:00 UTC reset, or add funds to the TinyFish wallet." +
          suffix,
        status,
        false,
      );
    case 403:
      return new TinyFishError(`TinyFish refused this search upstream (403).${suffix}`, status, false);
    case 404:
      return new TinyFishError("TinyFish Search is currently unavailable (404).", status, true);
    case 429:
      return new TinyFishError(
        "TinyFish rate limit reached (30 requests/minute per key). Try again in a moment.",
        status,
        true,
      );
    case 500:
    case 503:
      return new TinyFishError(
        `TinyFish Search is temporarily unavailable (${status}). Retry shortly.${suffix}`,
        status,
        true,
      );
    default:
      return new TinyFishError(`TinyFish search failed (HTTP ${status}).${suffix}`, status, status >= 500);
  }
}

function parseResult(raw: unknown): TinyFishSearchResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const url = typeof r.url === "string" ? r.url : "";
  if (!url) return null; // A result with no destination cannot be navigated to.
  return {
    position: typeof r.position === "number" ? r.position : 0,
    siteName: typeof r.site_name === "string" ? r.site_name : "",
    title: typeof r.title === "string" ? r.title : "",
    snippet: typeof r.snippet === "string" ? r.snippet : "",
    url,
    publishedAt: typeof r.published_at === "string" ? r.published_at : undefined,
    publisher: typeof r.publisher === "string" ? r.publisher : undefined,
    authors: Array.isArray(r.authors) ? r.authors.filter((a): a is string => typeof a === "string") : undefined,
    venue: typeof r.venue === "string" ? r.venue : undefined,
    year: typeof r.year === "number" ? r.year : undefined,
    citationCount: typeof r.citation_count === "number" ? r.citation_count : undefined,
    pdfUrl: typeof r.pdf_url === "string" ? r.pdf_url : undefined,
  };
}

function errorDetail(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const body = parsed as Record<string, unknown>;
      const code = typeof body.code === "string" ? body.code : "";
      const message = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : "";
      const joined = [code, message].filter(Boolean).join(": ");
      // Never echo an arbitrary provider body wholesale: it can be long, and it
      // is not guaranteed to be free of the request URL.
      return joined.slice(0, 200);
    }
  } catch {
    // Not JSON — fall through to a short plain-text detail.
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * Runs one search.
 *
 * `fetchImpl` is injectable so the harness can assert the wire shape with no
 * network and no key. The real call site passes the service worker's `fetch`.
 */
export async function searchWeb(
  apiKey: string,
  options: TinyFishSearchOptions,
  deps: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<TinyFishSearchResponse> {
  const key = (apiKey ?? "").trim();
  if (!key) {
    throw new TinyFishError(
      "No TinyFish API key set. Add one in Options → Web search to use web_search.",
    );
  }

  const url = buildSearchUrl(options);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // AbortSignal.any is Chrome 116+ and Node 20+, but the extension targets
  // Chrome 120 while the harness may run on an older Node — compose manually.
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(deps.signal?.reason);
  if (deps.signal) {
    if (deps.signal.aborted) controller.abort(deps.signal.reason);
    else deps.signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);

  const requestBytes = utf8Bytes(url.toString());
  let response!: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { "X-API-Key": key, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    if (deps.signal?.aborted) {
      throw new TinyFishError("TinyFish search was cancelled.", undefined, false);
    }
    const timedOut = controller.signal.aborted;
    throw new TinyFishError(
      timedOut
        ? `TinyFish did not answer within ${Math.round(timeoutMs / 1000)}s.`
        : "Could not reach TinyFish (network error).",
      undefined,
      true,
    );
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onAbort);
  }

  const text = await response.text();
  const responseBytes = utf8Bytes(text);

  if (!response.ok) {
    throw statusMessage(response.status, errorDetail(text));
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new TinyFishError("TinyFish returned a response that was not JSON.", response.status, true);
  }
  if (!body || typeof body !== "object") {
    throw new TinyFishError("TinyFish returned an empty search response.", response.status, true);
  }

  const raw = body as Record<string, unknown>;
  const all = Array.isArray(raw.results)
    ? raw.results.map(parseResult).filter((r): r is TinyFishSearchResult => r !== null)
    : [];
  const requested = options.maxResults ?? all.length;
  const limit = Math.min(Math.max(1, Math.floor(requested || 1)), MAX_RESULTS);

  return {
    query: typeof raw.query === "string" ? raw.query : options.query,
    results: all.slice(0, limit),
    totalResults: typeof raw.total_results === "number" ? raw.total_results : all.length,
    page: typeof raw.page === "number" ? raw.page : options.page ?? 0,
    bytes: requestBytes + responseBytes,
    requestBytes,
    responseBytes,
  };
}

/**
 * Renders results as the text a planner tool result carries.
 *
 * Bounded on purpose: every character here is re-sent on every later planner
 * turn, so a page of long snippets is a per-turn cost for the rest of the run.
 * Titles and snippets are cut, and the full URL is kept because it is the one
 * field the agent acts on.
 *
 * CALLER'S DUTY: this text is third-party content. It must pass through
 * `sanitizeTextPII` (and, for names/orgs, the Tier-0 fusion path) before it
 * enters `messages`, exactly like a page snapshot.
 */
export function formatSearchResults(
  response: TinyFishSearchResponse,
  options: { maxResults?: number; snippetChars?: number } = {},
): string {
  const max = Math.min(options.maxResults ?? 8, response.results.length);
  const snippetChars = options.snippetChars ?? 220;
  const lines: string[] = [
    `Web search: ${JSON.stringify(response.query)} — ${response.totalResults} results, page ${response.page}.`,
    "Positions are ranked best-first. Navigate to a result's URL to act on it; do not invent URLs.",
  ];
  for (const r of response.results.slice(0, max)) {
    const title = r.title.length > 120 ? `${r.title.slice(0, 117)}...` : r.title;
    const snippet = r.snippet.length > snippetChars
      ? `${r.snippet.slice(0, snippetChars - 3)}...`
      : r.snippet;
    const meta = [r.siteName, r.publishedAt, r.publisher].filter(Boolean).join(" · ");
    lines.push(
      `${r.position || lines.length - 1}. ${title}${meta ? ` (${meta})` : ""}\n   ${r.url}` +
        (snippet ? `\n   ${snippet}` : ""),
    );
  }
  if (response.results.length === 0) lines.push("(no results)");
  return lines.join("\n");
}
