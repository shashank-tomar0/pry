/**
 * Text-anchored targeting: "click the thing that says X".
 *
 * WHY THIS EXISTS
 *
 * `click` needs an element id from the last page read, and the element list is
 * capped (80) and dominated by page chrome — on a Gmail inbox the sidebar
 * links, the toolbar and the tabs fill the budget before a single message row.
 * The planner therefore cannot click the first email: its own reasoning says
 * "element [25] is a checkbox", it clicks the wrong thing, re-reads the page to
 * look again, and after three identical reads the loop guard ends the run.
 *
 * A row in a modern web app often has no element we can name — Gmail's rows are
 * table rows driven by a delegated click handler, not links. What the planner
 * DOES have is the text it can see ("Meta — You're on the Muse waitlist"). So
 * matching on rendered text is not a fallback for a missing selector; it is the
 * only handle that exists for a whole class of pages (inbox rows, search
 * results, list items, menu entries, card grids).
 *
 * This module is pure: the caller supplies text runs measured from the DOM and
 * gets back a ranked choice. Matching is case- and whitespace-insensitive
 * because OCR-of-the-eye and model-quoted text are both sloppy about spacing.
 */

/** A measured piece of visible text (device-independent viewport pixels). */
export interface TextRun {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A candidate the matcher chose, with how confident the match is. */
export interface TextMatch<T extends TextRun = TextRun> {
  run: T;
  /** 100 exact · 80 prefix · 60 word-boundary · 40 substring. */
  score: number;
  /** Why this scored what it did — shown in the action result. */
  reason: "exact" | "prefix" | "word" | "substring";
}

/** Collapse whitespace, strip zero-width characters, lowercase. */
export function normalizeForMatch(value: string): string {
  return (value ?? "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Score one candidate text against the query, or null when it does not match.
 *
 * An exact match beats a prefix, which beats a whole-word hit, which beats a
 * substring: "Sent" must not lose to "Sent items (3)" when the user asked for
 * "Sent", but "Meta" inside a long row is still a usable hit when that is all
 * there is.
 */
export function scoreTextMatch(candidate: string, query: string): TextMatch["reason"] | null {
  const haystack = normalizeForMatch(candidate);
  const needle = normalizeForMatch(query);
  if (!needle || needle.length < 2) return null;
  if (haystack === needle) return "exact";
  if (haystack.startsWith(needle)) return "prefix";
  // Whole-word containment: the needle must not be glued to a letter or digit.
  const at = haystack.indexOf(needle);
  if (at >= 0) {
    const before = at === 0 ? " " : haystack[at - 1];
    const after = at + needle.length >= haystack.length ? " " : haystack[at + needle.length];
    const bounded = !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
    if (bounded) return "word";
    return "substring";
  }
  return null;
}

const SCORES: Record<TextMatch["reason"], number> = {
  exact: 100,
  prefix: 80,
  word: 60,
  substring: 40,
};

/**
 * Rank every candidate that matches, best first, then in reading order.
 *
 * Reading order (top-to-bottom, then left-to-right) is what makes `index`
 * meaningful for "the first email": position 0 is genuinely the topmost match
 * on screen, which is how a person reads the page.
 */
export function rankTextMatches<T extends TextRun>(runs: T[], query: string): Array<TextMatch<T>> {
  const matches: Array<TextMatch<T>> = [];
  for (const run of runs ?? []) {
    const reason = scoreTextMatch(run.text, query);
    if (!reason) continue;
    matches.push({ run, score: SCORES[reason], reason });
  }
  return matches.sort(
    (a, b) => b.score - a.score || a.run.y - b.run.y || a.run.x - b.run.x,
  );
}

/**
 * Pick one match, defaulting to the topmost.
 *
 * `index` selects among matches of equal standing rather than among all
 * matches, so "the second one" stays stable when a better-scoring match exists
 * further down the page.
 */
export function pickTextMatch<T extends TextRun>(
  runs: T[],
  query: string,
  index: number = 0,
): TextMatch<T> | null {
  const ranked = rankTextMatches(runs, query);
  if (ranked.length === 0) return null;
  const best = ranked[0].score;
  const sameStanding = ranked.filter((m) => m.score === best);
  const wanted = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
  return sameStanding[Math.min(wanted, sameStanding.length - 1)] ?? sameStanding[0];
}

/**
 * Which elements count as "the thing a text lives in".
 *
 * Row-like and control-like containers are click targets; a bare `<span>` of
 * text usually is not, but it is still used for measurement. `tr` is included
 * because that is how Gmail's message rows are built, and they are clickable
 * only through a delegated handler on the row itself.
 */
const CLICKABLE_TAGS = new Set(["a", "button", "tr", "li", "label", "summary", "option"]);
const CLICKABLE_ROLES = new Set([
  "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
  "tab", "option", "row", "gridcell", "listitem", "treeitem", "switch", "checkbox",
]);

export function isClickableTarget(tag: string, role: string | null, hasTabIndex: boolean): boolean {
  if (CLICKABLE_TAGS.has(tag)) return true;
  if (role && CLICKABLE_ROLES.has(role)) return true;
  // A focusable element is reachable by keyboard, which in practice means the
  // page treats it as interactive.
  return hasTabIndex;
}

/** Human-readable name for what was clicked, for the action result. */
export function describeTextTarget(text: string, tag: string, role: string | null): string {
  const label = normalizeForMatch(text).slice(0, 60);
  const kind = role ? `${tag} role=${role}` : tag;
  return `<${kind}> ${JSON.stringify(label)}`;
}
