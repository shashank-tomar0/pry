/**
 * Detected-vs-redacted reconciliation (pure policy, no DOM, no chrome APIs).
 *
 * PRY has two privacy channels that read DIFFERENT sources:
 *
 *   - the text channels (`snapshot()` + pii-detector + contextual-pii) read
 *     accessible names, element values, attributes and rendered text;
 *   - the pixel channel (`perceive.ts`) can only box rendered text nodes, form
 *     fields and avatar images.
 *
 * Anything the first channel sees that the second cannot place is tokenized for
 * the planner and stays fully readable in the frame. On a real Gmail inbox that
 * looked like: "2 PII detected · 0 items redacted · nothing to verify" beside a
 * BEFORE/AFTER pair where the address was plainly legible in both images.
 *
 * Two jobs live here:
 *
 *   1. `sanitizePiiTargets` — what may be forwarded to the content script to be
 *      located. Values are length-bounded and selectors must match the exact
 *      `[data-pry-id="N"]` shape our own detectors emit, so nothing arbitrary
 *      crosses the message channel.
 *   2. `findUnlocatedValues` — which detected values were NOT boxed anywhere.
 *      A non-empty result is a residual, visible leak that must be reported,
 *      not silently assumed covered.
 */

/** One item the text channels found, and where it came from. */
export interface PiiTarget {
  /** The literal value (email, phone, ID, name). */
  value?: string;
  /** The element the detector read it out of, when there was one. */
  selector?: string;
}

/** Longest value we will ask the content script to go looking for. */
export const MAX_TARGET_VALUE_LENGTH = 80;
/** Shortest value worth locating — matches locateSpans' own floor. */
export const MIN_TARGET_VALUE_LENGTH = 3;
/** Cap on targets per capture, keeping the message and the scan bounded. */
export const MAX_PII_TARGETS = 24;

/** The only selector shape our detectors emit; anything else is rejected. */
const SELECTOR_SHAPE = /^\[data-pry-id="\d{1,6}"\]$/;

export function isLocatableSelector(selector: string): boolean {
  return SELECTOR_SHAPE.test((selector ?? "").trim());
}

export function sanitizePiiTargets(
  targets: PiiTarget[] | undefined,
  max: number = MAX_PII_TARGETS,
): PiiTarget[] {
  const seen = new Set<string>();
  const clean: PiiTarget[] = [];
  for (const t of targets ?? []) {
    const value = (t?.value ?? "").trim();
    const selector = (t?.selector ?? "").trim();
    const valueOk =
      value.length >= MIN_TARGET_VALUE_LENGTH && value.length <= MAX_TARGET_VALUE_LENGTH;
    const selectorOk = isLocatableSelector(selector);
    // A target with neither a usable value nor a usable selector is dropped.
    if (!valueOk && !selectorOk) continue;
    // Dedupe on value+selector: the same value found in two places on one page
    // is one thing to locate, but value and selector must stay paired so a box
    // drawn for the element can still be attributed to its value.
    const key = `${value}\u0000${selector}`;
    if (seen.has(key) || clean.length >= max) continue;
    seen.add(key);
    clean.push({ ...(valueOk ? { value } : {}), ...(selectorOk ? { selector } : {}) });
  }
  return clean;
}

/**
 * Values that were detected but are not covered by any located region.
 *
 * Regions carry the value they cover (`value` on SensitiveRegion), so this is
 * an exact match rather than a guess. A value covered by an element box counts
 * as located — that is why the selector travels with the value.
 */
export function findUnlocatedValues(
  targets: PiiTarget[] | undefined,
  regions: Array<{ value?: string }> | undefined,
): string[] {
  const detected = (targets ?? [])
    .map((t) => (t.value ?? "").trim())
    .filter((v) => v.length > 0);
  if (detected.length === 0) return [];
  const boxed = new Set(
    (regions ?? []).map((r) => (r.value ?? "").trim()).filter((v) => v.length > 0),
  );
  return [...new Set(detected.filter((v) => !boxed.has(v)))];
}

// Masking for the warning sample is NOT reimplemented here: tokenizer.ts
// already owns the one masking policy the whole UI uses (emails keep their
// domain, digits vanish), and a second implementation would drift.
