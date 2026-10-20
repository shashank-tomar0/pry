/**
 * The `web_search` policy — what may be searched for, and what may come back.
 *
 * This module is PURE: it holds no key, makes no request, and imports nothing
 * from the browser. The transport lives in `tinyfish.ts`; the decision about
 * what is allowed to leave lives here. Keeping them apart is the point — the
 * one function that can send a user's words to a third party is a pure function
 * of its inputs, so the harness can prove the refusals fire without a network
 * and without a key.
 *
 * WHY A QUERY IS A PRIVACY EVENT
 *
 * Every other outbound channel in this extension carries values the run has
 * already sanitized: a tokenized snapshot, a redacted frame. A search query is
 * different in kind — it is *the agent's own words about the user*, written for
 * a third party, and it is the one string a redaction cannot protect, because it
 * must stay readable to be useful. So the rule is inverted here: a query that
 * contains a vault token or a PII pattern is REFUSED, not rewritten. Rewriting
 * would silently answer a different question than the agent asked, and the
 * planner would act on results for a subject the user never named.
 *
 * The refusal is actionable on purpose: it names the masked finding and tells
 * the planner what to do instead (drop the private part, or navigate directly).
 * A model that cannot tell why it was refused will rephrase and retry.
 */

import { matchPiiInText } from "../shared/text-pii-patterns";

/** The tool name the loop dispatches on. One spelling, exported. */
export const WEB_SEARCH_TOOL = "web_search";

/** Transport limits, mirrored so a bad plan is refused before a request is built. */
export const MAX_QUERY_CHARS = 500;
export const MAX_RESULTS_CEILING = 20;
export const DOMAIN_TYPES = ["web", "news", "research_paper"] as const;
export type DomainType = (typeof DOMAIN_TYPES)[number];

/** Everything the policy needs from the run, injected so it stays pure. */
export interface SearchPolicyDeps {
  /** Vault tokens appearing in a string, e.g. `["<CRED_1>"]`. */
  vaultTokens: (text: string) => string[];
  /** Swaps vault tokens back for real values. Only called when the user allowed it. */
  resolve: (text: string) => string;
  /** Masks a value for a message the model will read. Never returns the value. */
  mask: (value: string) => string;
}

export interface SearchLimits {
  /**
   * Allow a vault token in a query to be resolved and sent.
   *
   * Default false, and the default is the product decision: an unresolved token
   * in a query means the agent is about to search for something it deliberately
   * removed from its own reasoning, which is the one case where a search can
   * undo a redaction.
   */
  allowResolvedQueries: boolean;
  /** Per-call cap. */
  maxResults: number;
}

/** A validated search, ready for the transport. */
export interface SearchPlan {
  query: string;
  purpose?: string;
  domainType?: DomainType;
  includeDomains?: string[];
  excludeDomains?: string[];
  maxResults: number;
}

export type SearchVerdict =
  | { ok: true; plan: SearchPlan }
  | { ok: false; error: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function domainList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = value
    .filter((d): d is string => typeof d === "string")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d !== "");
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * One masked, human-readable line per finding. The count is stated even when
 * only the first few are shown, so the planner cannot read a truncated list as
 * the whole answer.
 */
function describeFindings(values: string[], mask: (v: string) => string): string {
  const shown = values.slice(0, 3).map((v) => `"${mask(v)}"`).join(", ");
  const more = values.length > 3 ? ` (+${values.length - 3} more)` : "";
  return `${shown}${more}`;
}

/**
 * Decides whether a planned search may be sent, and builds the request.
 *
 * Order matters: bounds first (cheap, and a 501-char query is a bug in the
 * planner, not a privacy event), then vault tokens, then PII patterns. A vault
 * token is checked first among the two because it is the stronger signal — the
 * run itself decided this value was too sensitive to keep.
 */
export function planSearch(
  input: Record<string, unknown>,
  deps: SearchPolicyDeps,
  limits: SearchLimits,
): SearchVerdict {
  const query = text(input.query);
  if (!query) {
    return { ok: false, error: "web_search needs a non-empty `query`." };
  }
  if (query.length > MAX_QUERY_CHARS) {
    return {
      ok: false,
      error:
        `That query is ${query.length} characters; the search service accepts ${MAX_QUERY_CHARS}. ` +
        "Search for the target, not for the page you already read.",
    };
  }

  // ── Vault tokens: the agent's own redactions ──────────────────────────────
  const tokens = deps.vaultTokens(query);
  if (tokens.length > 0) {
    if (!limits.allowResolvedQueries) {
      return {
        ok: false,
        error:
          `Refused: the query contains ${describeFindings(tokens, (t) => t)} — a value this run marked ` +
          "private, and a search would send it to a third party in clear text. " +
          "Search for the public part only (drop the private value), or ask the user for permission.",
      };
    }
    // Allowed, but only by the user's standing choice: resolve, then re-check
    // below, because the RESOLVED value is what actually leaves.
    return finish(deps.resolve(query), input, deps, limits);
  }

  return finish(query, input, deps, limits);
}

/** The second half of `planSearch`: PII patterns and the request shape. */
function finish(
  query: string,
  input: Record<string, unknown>,
  deps: SearchPolicyDeps,
  limits: SearchLimits,
): SearchVerdict {
  const findings = matchPiiInText(query).map((m) => m.value);
  if (findings.length > 0 && !limits.allowResolvedQueries) {
    return {
      ok: false,
      error:
        `Refused: the query contains what looks like private data — ${describeFindings(findings, deps.mask)}. ` +
        "Queries leave the browser, so search for the public subject instead " +
        "(the site name, the general topic) and read the specifics on the page.",
    };
  }

  const purpose = text(input.purpose);
  const rawDomainType = text(input.domain_type);
  if (rawDomainType && !(DOMAIN_TYPES as readonly string[]).includes(rawDomainType)) {
    return {
      ok: false,
      error: `web_search's domain_type must be one of ${DOMAIN_TYPES.join(", ")}; got "${rawDomainType}".`,
    };
  }

  const requested = typeof input.max_results === "number" ? input.max_results : limits.maxResults;
  const maxResults = Math.min(
    Math.max(1, Math.floor(Number.isFinite(requested) ? requested : limits.maxResults)),
    MAX_RESULTS_CEILING,
  );

  const plan: SearchPlan = {
    query,
    purpose: purpose || undefined,
    domainType: rawDomainType ? (rawDomainType as DomainType) : undefined,
    includeDomains: domainList(input.include_domains),
    excludeDomains: domainList(input.exclude_domains),
    maxResults,
  };
  return { ok: true, plan };
}

/**
 * The vault kinds a text match can map to. Three, because `matchPiiInText`
 * reports an API key, an identity number, or a credential — a name hit is not
 * a search-leak concern (it is already in the query the user typed) and so is
 * not a kind this path ever hands the vault.
 *
 * Exported so the injected `tokenize` callback and `SearchDispatchDeps` share
 * one spelling: declaring it inline in each place is how the two drifted to
 * `string` and the union, which the typecheck caught.
 */
export type SearchTokenKind = "credential" | "api_key" | "id_number";

/**
 * Replaces PII in text that arrived from somewhere else — the search results.
 *
 * Search snippets are third-party text that the run did not choose, and they go
 * into `messages`, which is re-sent on every later turn. A page that publishes
 * an email address must not thereby put it in the planner's context forever, so
 * the same pattern set that guards page text guards this.
 *
 * `tokenize` is injected (`(value, kind) => "<CRED_1>"`), so the vault owns the
 * mapping and this stays a pure string transform.
 */
export function tokenizePiiInText(
  input: string,
  tokenize: (value: string, kind: SearchTokenKind) => string,
): string {
  if (!input || input.length < 6) return input;
  const matches = matchPiiInText(input);
  if (matches.length === 0) return input;
  let out = input;
  // Replace from the end so earlier indices stay valid.
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const kind: SearchTokenKind =
      m.kind === "api_key" ? "api_key" : m.kind === "id_text" ? "id_number" : "credential";
    out = out.slice(0, m.start) + tokenize(m.value, kind) + out.slice(m.end);
  }
  return out;
}

/** What the injected transport returns. Kept structural so this module never
 * imports the browser-facing transport. */
export interface SearchTransportResult {
  /** Planner-facing text, as produced by `formatSearchResults`. */
  text: string;
  /** UTF-8 bytes that actually left the browser (request + response). */
  bytes: number;
  /** Ranked results returned. */
  results: number;
}

/** What the run must supply for one dispatch beyond the policy itself. */
export interface SearchDispatchDeps extends SearchPolicyDeps {
  /** The transport. Only reached after the policy says yes. */
  search: (plan: SearchPlan, signal: AbortSignal) => Promise<SearchTransportResult>;
  /** The run's abort signal, so Stop cancels an in-flight search. */
  signal: AbortSignal;
  /** Searches already made this run, for the per-run cap. */
  searchesUsed: number;
  /** Hard cap per run (see `TinyFishSettings.maxSearchesPerRun`). */
  maxSearchesPerRun: number;
  /** Vault tokenizer for PII found in RESULTS (not in the query). */
  tokenize: (value: string, kind: SearchTokenKind) => string;
}

export type SearchDispatchOutcome =
  | { ok: true; content: string; bytes: number; results: number; query: string }
  | { ok: false; error: string };

/**
 * One complete `web_search` call, minus the loop.
 *
 * Three decisions in one place, in the order that matters:
 *
 *   1. the per-run cap, because a planner in a loop can burn the 30/min quota
 *      faster than any other failure mode;
 *   2. `planSearch`, which is what may LEAVE;
 *   3. tokenizing what came BACK, because snippets are third-party text that
 *      gets re-sent on every later turn.
 *
 * The transport is only called after (1) and (2) both pass, so a refusal can
 * never be a request that was made and then discarded.
 */
export async function dispatchSearch(
  input: Record<string, unknown>,
  deps: SearchDispatchDeps,
  limits: SearchLimits,
): Promise<SearchDispatchOutcome> {
  if (deps.searchesUsed >= deps.maxSearchesPerRun) {
    return {
      ok: false,
      error:
        `Refused: this run has already used its ${deps.maxSearchesPerRun} search(es). ` +
        "Continue from the pages you already have, or ask the user before starting a new run.",
    };
  }

  const verdict = planSearch(input, deps, limits);
  if (!verdict.ok) return verdict;

  const plan = verdict.plan;
  let outcome: SearchTransportResult;
  try {
    outcome = await deps.search(plan, deps.signal);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Web search failed: ${detail}. Do not retry blindly — navigate to a site you know, or ask the user.`,
    };
  }

  const safe = tokenizePiiInText(outcome.text, deps.tokenize);
  return {
    ok: true,
    content: `${searchResultPreamble(outcome.results, outcome.bytes)}\n\n${safe}`,
    bytes: outcome.bytes,
    results: outcome.results,
    query: plan.query,
  };
}

/**
 * The line the planner reads before the results.
 *
 * States where the text came from and what to do with it, because the one
 * failure mode that matters here is a planner treating a snippet as evidence
 * about the USER's page — the snippets are public web, and the user's session
 * is the only thing that can answer questions about their account.
 */
export function searchResultPreamble(count: number, bytes: number): string {
  if (count === 0) {
    return "Web search returned no results. Do not repeat the same query — rephrase it, or navigate to a site you know.";
  }
  return (
    `Web search returned ${count} result(s) from the public web (${bytes} bytes measured on the egress meter). ` +
    "These are public pages, NOT the user's own data: use a URL to navigate, then read the page itself."
  );
}
