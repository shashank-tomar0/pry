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

/**
 * Which of those values STILL count as unplaceable, given what the locators saw.
 *
 * The locators (`locateSpans`, `locateElements`) only return a rect for text the
 * capture can actually contain: they skip anything whose client rect lies
 * outside the viewport, because a viewport screenshot has no pixels there. That
 * skip is right for PAINTING and was wrong as input to `findUnlocatedValues`,
 * which read "no region carries this value" as "detected but unlocatable on
 * screen" — a coverage failure, and a coverage failure withholds the frame.
 *
 * A live run failed on exactly that. A name the on-device model found in the
 * page's TEXT and that was rendered below the fold is provably absent from a
 * capture of the visible area, but it was counted as unplaceable — and the
 * pixel channel was then asked to clear it from the frame, which it cannot do
 * either, so the case could never resolve. Every frame on that page was
 * withheld and the planner lost its vision channel for the rest of the run.
 *
 * So the two outcomes are separated, and only one of them withholds:
 *
 *   - SEEN, but outside the area this capture covers: the image provably does
 *     not contain it. Not a leak, and no reason to refuse the frame.
 *   - NOT SEEN at all: the value may live where a DOM walk cannot read it — an
 *     image, a canvas, a video frame. A real unknown, handed to the pixel
 *     channel and withheld until it is answered.
 *
 * TWO GUARDS keep the first claim honest rather than convenient:
 *
 *   - `scanComplete` — a walk that stopped at its node or time budget did not
 *     look at the rest of the page, so there "not seen" means "not seen YET"
 *     and nothing may be excused.
 *   - `captureCoversWholePage` — for a stitched full-page capture an off-viewport
 *     value IS in the image, so nothing may be excused either.
 */
export function unplacedAfterLocators(
  unplaced: string[],
  locators: {
    /** Values a locator saw rendered outside the area this capture covers. */
    offCapture: Iterable<string>;
    /** True only when EVERY locator that was asked walked the whole document. */
    scanComplete: boolean;
    /** True for a stitched full-page capture, which covers the whole document. */
    captureCoversWholePage: boolean;
  },
): string[] {
  if (locators.captureCoversWholePage || !locators.scanComplete) return [...unplaced];
  const excused = new Set(locators.offCapture);
  return unplaced.filter((value) => !excused.has(value));
}

/**
 * Which detected ELEMENT targets the pixel channel could not account for, and
 * why that matters for whether a frame may leave the browser.
 *
 * The service worker used to ask a much weaker question: "does any target carry
 * a selector?" If one did, it pushed `dom-selector-coverage-unverified`, which is
 * a coverage failure — and a coverage failure withholds the frame. The reason was
 * honest: the wire format could not say which target a returned box belonged to,
 * so "every target was boxed" was unprovable. The consequence was not honest: on
 * any page with a form field the planner lost its vision channel entirely, which
 * is part of why the reported Gmail run read the page five times and never saw it.
 *
 * The boxes name their target now (`targetSelector`), so the question can be
 * asked per target, and the two ways a target can be uncovered are different
 * findings:
 *
 *   - `unaccounted` — a target with a VALUE that no box covers. This is already
 *     reported by `findUnlocatedValues` as an unplaceable value, and the
 *     frame-text channel is asked to clear it in the pixels. It is a leak to
 *     resolve, not a reason to withhold the whole frame.
 *   - `unattributable` — a target with NO value and no box of its own. Nothing
 *     can even name what is uncovered here, so the frame stays withheld. This is
 *     the case the old blanket flag existed for, kept exactly as strict.
 */
export function unverifiedElementTargets(
  targets: PiiTarget[] | undefined,
  regions: Array<{ value?: string; targetSelector?: string }> | undefined,
): { unaccounted: string[]; unattributable: string[] } {
  const listed = (targets ?? []).filter(
    (t) => isLocatableSelector(t?.selector ?? "") || (t?.value ?? "").trim().length > 0,
  );
  if (listed.length === 0) return { unaccounted: [], unattributable: [] };

  const namedSelectors = new Set(
    (regions ?? []).map((r) => (r.targetSelector ?? "").trim()).filter(Boolean),
  );
  const boxedValues = new Set(
    (regions ?? []).map((r) => (r.value ?? "").trim()).filter(Boolean),
  );

  const unaccounted: string[] = [];
  const unattributable: string[] = [];
  for (const target of listed) {
    const selector = (target?.selector ?? "").trim();
    const value = (target?.value ?? "").trim();
    // A box that names this target, or one that covers its value, is coverage.
    if (selector && namedSelectors.has(selector)) continue;
    if (value && boxedValues.has(value)) continue;
    if (value) unaccounted.push(value);
    else unattributable.push(selector);
  }
  return { unaccounted: [...new Set(unaccounted)], unattributable: [...new Set(unattributable)] };
}

// Masking for the warning sample is NOT reimplemented here: tokenizer.ts
// already owns the one masking policy the whole UI uses (emails keep their
// domain, digits vanish), and a second implementation would drift.
