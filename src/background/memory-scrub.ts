/**
 * Memory Scrub — learned artifacts must carry shapes, never values.
 *
 * WHY THIS EXISTS
 *
 * Trajectories and lessons are replayed into future prompts, and the task
 * text they store rides raw by design (search terms are instruction
 * parameters, not secrets). A stored task like "open youtube and search for
 * harkirat" therefore replays the entity verbatim — and a later run for
 * "open yt in the new tab" reasoned "I'll obey the route", typed the old
 * search term, and reported it as the result. Prompt framing alone did not
 * stop it ("Take the ROUTE, never the values" was in the prompt it quoted).
 *
 * So values are removed at WRITE time, from the two places they enter
 * memory:
 *
 *   1. Structured PII (emails, phones, checksum IDs, cued names) via the
 *      same matchers both privacy channels share (`matchPiiInText`).
 *   2. Whatever this run TYPED into the web, harvested from the step-entry
 *      texts (`Typed "harkirat" into <input "Search">`). The typed value is
 *      the highest-signal entity source a run has: it is exactly what the
 *      model chose as a value, quoted back by the executor as ground truth
 *      (what the field holds NOW), so there is no guessing involved.
 *
 * What is deliberately NOT scrubbed: route words (navigate, click, search),
 * site names, and control labels. Masking those would destroy the route the
 * entry exists to teach. A masked entry reads "open youtube and search for
 * [...]" — the shape survives, the entity does not.
 */

import { matchPiiInText } from "../shared/text-pii-patterns";

/** Shortest/longest quoted run treated as one typed value. */
const MIN_VALUE_CHARS = 3;
const MAX_VALUE_CHARS = 80;

/** Placeholder per structured-PII kind. Typed values all become `[...]`. */
const KIND_PLACEHOLDER: Record<string, string> = {
  email: "[email]",
  phone: "[phone]",
  id_text: "[id]",
  name_text: "[name]",
  api_key: "[key]",
  credential: "[secret]",
};
export const TYPED_VALUE_PLACEHOLDER = "[...]";

/**
 * Harvest values this run typed into the web, from step-entry texts.
 *
 * Only `type` / `type_text` steps qualify: a click target is visible page
 * text (often a control label like "Sign in" — masking that everywhere
 * would garble routes), while a typed value is by definition something the
 * run supplied. The parse anchors on the executor's own format
 * (`Typed "<json>" into …`), so the field label and the echo can never be
 * mistaken for the value. Bare vault tokens are skipped — they are already
 * meaningless outside their run.
 */
export function harvestTypedValues(
  steps: Array<{ action?: string; text: string }>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.action !== "type" && step.action !== "type_text") continue;
    const m = /^Typed ("(?:[^"\\]|\\.)*")/.exec(step.text);
    if (!m) continue;
    let value: unknown;
    try {
      value = JSON.parse(m[1]);
    } catch {
      continue; // malformed quote — not a value we can trust
    }
    if (typeof value !== "string") continue;
    const v = value.trim();
    if (v.length < MIN_VALUE_CHARS || v.length > MAX_VALUE_CHARS) continue;
    if (/^<[A-Z]+_\d+>$/.test(v)) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mask one value everywhere it occurs: word-bounded and case-insensitive,
 * so "Harkirat" goes but the verb in "search" never does (a letter-run
 * value cannot match inside a longer word). Digits join the boundary set
 * so a short number cannot eat a fragment of a longer one.
 */
function maskValue(text: string, value: string, placeholder: string): string {
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{M}0-9_])${escapeRegExp(value)}(?=$|[^\\p{L}\\p{M}0-9_])`,
    "giu",
  );
  return text.replace(pattern, (_m, lead: string) => `${lead}${placeholder}`);
}

/**
 * Scrub a string bound for learned memory (a trajectory task/answer or a
 * lesson line). Structured PII first, then typed values longest-first so
 * "harkirat singh" masks before "harkirat" can leave a fragment. Pure and
 * total: unknown input passes through unchanged, never throws.
 */
export function scrubMemoryText(text: string, typedValues: readonly string[]): string {
  let out = String(text ?? "");
  // Structured spans, from the end so earlier indices stay valid.
  const matches = matchPiiInText(out);
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    out = out.slice(0, m.start) + (KIND_PLACEHOLDER[m.kind] ?? "[...]") + out.slice(m.end);
  }
  const ordered = [...typedValues].sort((a, b) => b.length - a.length);
  for (const v of ordered) out = maskValue(out, v, TYPED_VALUE_PLACEHOLDER);
  return out;
}
