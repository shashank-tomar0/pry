/**
 * PII triage over OCR'd frame text (pure policy: no DOM, no chrome, no canvas).
 *
 * WHY THIS EXISTS
 *
 * Every other pixel redaction path starts from the DOM: `perceive.ts` measures
 * rendered text nodes, form fields and avatar images, and the element bridge
 * boxes PII the detectors read out of an element. PII that was never in the DOM
 * at all — text baked into a `<img>`, a `<canvas>`, a video frame, a PDF
 * viewer's painted output — is invisible to all of them, so it stayed readable
 * in the frame that the audit shows and, when vision is on, in the frame that
 * shipped. That was the honest §6.5 gap.
 *
 * This module closes it the only way pixels can: read the frame back and box
 * what is legible. It runs on the ALREADY-REDACTED frame, which is what makes
 * it self-targeting — anything OCR can still read there is, by definition,
 * something no other channel covered. There is no bookkeeping to get wrong and
 * no way for a detector to disagree with it.
 *
 * WHAT IT MATCHES
 *
 *   - the shared PII patterns (email, phone, checksum-validated ID shapes),
 *     the same matchers the text channel uses, so the two agree on what a
 *     phone number is;
 *   - spans the on-device NER already found on this page (`spans`), which is
 *     what gives a bare name inside an image a chance: pattern matching alone
 *     cannot recognise "Priya Sharma" without a cue word next to it.
 *
 * WHAT IT DOES NOT DO
 *
 * A name in an image that the NER never saw anywhere on the page is still not
 * detected. OCR misreads are another limit: a value OCR cannot read is a value
 * this cannot box. Neither is claimed away — the caller reports coverage.
 */

import { matchPiiInText } from "./text-pii-patterns";

/** One recognized word with its box in image pixels. */
export interface OcrWord {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number;
}

/** Words grouped as the OCR engine saw them (one entry per text line). */
export interface OcrLine {
  words: OcrWord[];
}

/** A box worth painting, with the value that justified it. */
export interface TriageBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The literal text this box covers. Never logged unmasked. */
  value: string;
  /** Region kind for the painter. All of these end in `_text` → opaque fill. */
  kind: string;
  label: string;
  source: "pattern" | "known_span";
  /**
   * The KNOWN value this box proves covered, when the box was found by looking
   * for one. It differs from `value` exactly when the frame's pixels do not
   * spell the value correctly: `value` is what OCR read (what is painted),
   * `matchedSpan` is what the caller asked about. Clearance accounting must use
   * this field, or a value found THROUGH a misread would still be reported as
   * "never found" and withhold the frame.
   */
  matchedSpan?: string;
}

export interface TriageLimits {
  /** Spans the on-device NER found on this page. */
  spans?: string[];
  /**
   * Values the DOM channel detected and could not place on screen. Looked for
   * with the same matcher as `spans`, plus a tolerant pass — see spanRanges and
   * tolerantWordWindow for why: these are the values whose CLEARANCE decides
   * whether the frame ships, so a single missed glyph must not be the difference
   * between "found and destroyed" and "withheld forever".
   */
  requested?: string[];
  /** Require this much mean word confidence in a line before trusting it. */
  minLineConfidence?: number;
  /** Hard cap on boxes, so a dense page cannot become one black wall. */
  maxBoxes?: number;
}

export const MIN_LINE_CONFIDENCE = 30;
export const MAX_TRIAGE_BOXES = 40;
/** Overlap fraction of a box's own area that means "already redacted". */
export const COVERED_BOX_RATIO = 0.5;

/** A character range in the joined line text, and the word it came from. */
interface WordRange {
  start: number;
  end: number;
  word: OcrWord;
}

/**
 * Join a line's words into the string OCR would have reported, keeping each
 * word's character range. Matches are found on that string and mapped back to
 * words, so a multi-word span ("98765 43210", "Mr. John Doe") unions the boxes
 * of every word it covers instead of boxing only the first.
 */
function joinLine(words: OcrWord[]): { text: string; ranges: WordRange[] } {
  const ranges: WordRange[] = [];
  let text = "";
  for (const word of words) {
    const piece = (word.text ?? "").trim();
    if (!piece) continue;
    if (text.length > 0) text += " ";
    const start = text.length;
    text += piece;
    ranges.push({ start, end: text.length, word });
  }
  return { text, ranges };
}

/** Union of every word box a character range touches. */
function unionBoxFor(
  ranges: WordRange[],
  start: number,
  end: number,
): { x: number; y: number; width: number; height: number } | null {
  const touched = ranges.filter((r) => r.start < end && r.end > start);
  if (touched.length === 0) return null;
  const x0 = Math.min(...touched.map((r) => r.word.x));
  const y0 = Math.min(...touched.map((r) => r.word.y));
  const x1 = Math.max(...touched.map((r) => r.word.x + r.word.width));
  const y1 = Math.max(...touched.map((r) => r.word.y + r.word.height));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
}

/** Mean confidence of a line's words (0 when the engine reported none). */
function lineConfidence(words: OcrWord[]): number {
  const scored = words.filter((w) => typeof w.confidence === "number");
  if (scored.length === 0) return 100;
  return scored.reduce((sum, w) => sum + (w.confidence ?? 0), 0) / scored.length;
}

function boxArea(box: { width: number; height: number }): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function overlapArea(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

/**
 * Below this many characters (after folding), a tolerant match is refused
 * outright: a 2–3 character value has no shape left to recognise, and matching
 * one loosely would box unrelated words.
 */
export const MIN_FUZZY_SPAN_CHARS = 4;

/**
 * Fold a string down to what OCR "meant": case, separators and the classic
 * glyph confusions removed. Applied to BOTH sides of a comparison, so `rn`/`m`,
 * `0`/`O`, `1`/`l`/`I`, `5`/`S`, `8`/`B` stop deciding whether a value the
 * caller asked about is present in the frame.
 */
export function foldForOcrMatch(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    // Multi-character confusions first, so `rn` is not seen as two characters
    // that a later rule would rewrite individually.
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    // Then the single-glyph families. Each family folds to ONE symbol: `1`, `l`
    // and `i` all become `l`, because an engine that returns `Hark1rat` for
    // `Harkirat` is not wrong about the letters, only about which glyph it saw.
    .replace(/0/g, "o")
    .replace(/[1|]/g, "l")
    .replace(/i/g, "l")
    .replace(/5/g, "s")
    .replace(/8/g, "b")
    .replace(/2/g, "z");
}

/** Edit distance, abandoned as soon as it exceeds `maxEdits`. */
export function withinEditBudget(a: string, b: string, maxEdits: number): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > maxEdits) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxEdits) return false;
    previous = current;
  }
  return previous[b.length] <= maxEdits;
}

/** How many characters of a folded span may differ for a tolerant match. */
export function editBudgetFor(foldedSpan: string): number {
  return Math.max(1, Math.floor(foldedSpan.length / 6));
}

/**
 * Find a known value in a line when OCR did not spell it correctly.
 *
 * Compares the folded span against every window of the same WORD COUNT in the
 * line, so `"harkirat singh"` is still found when the engine returns
 * `"Harkırat Singh"` or `"Hark1rat Singh"`. The word count has to agree: this is
 * deliberately not a general fuzzy text search. A window that differs by more
 * than editBudgetFor (about one character in six) is not a match, which is what
 * keeps it from painting unrelated text.
 */
function tolerantWordWindow(
  ranges: WordRange[],
  span: string,
): { start: number; end: number; value: string } | null {
  const spanWords = span.trim().split(/\s+/).filter(Boolean);
  const foldedSpan = foldForOcrMatch(span);
  if (foldedSpan.length < MIN_FUZZY_SPAN_CHARS || spanWords.length === 0) return null;
  const budget = editBudgetFor(foldedSpan);
  for (let i = 0; i + spanWords.length <= ranges.length; i++) {
    const window = ranges.slice(i, i + spanWords.length);
    const text = window.map((r) => r.word.text ?? "").join(" ");
    const folded = foldForOcrMatch(text);
    // A window of a very different length is a different string, not a misread
    // one; comparing first saves the distance computation on most windows.
    if (Math.abs(folded.length - foldedSpan.length) > budget + 1) continue;
    if (withinEditBudget(folded, foldedSpan, budget)) {
      return { start: window[0].start, end: window[window.length - 1].end, value: text };
    }
  }
  return null;
}

/** Case-insensitive occurrence search for a known span inside a line. */
function spanRanges(lineText: string, span: string): Array<{ start: number; end: number }> {
  const needle = span.trim();
  if (needle.length < 3) return [];
  const haystack = lineText.toLowerCase();
  const target = needle.toLowerCase();
  const found: Array<{ start: number; end: number }> = [];
  let from = 0;
  let hit = haystack.indexOf(target, from);
  while (hit !== -1 && found.length < 8) {
    // Word-boundary check: a substring match inside a longer word ("Ann" in
    // "Annual") would box an unrelated word.
    const before = hit === 0 ? " " : haystack[hit - 1];
    const after = hit + target.length >= haystack.length ? " " : haystack[hit + target.length];
    const bounded = !/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after);
    if (bounded) found.push({ start: hit, end: hit + target.length });
    from = hit + target.length;
    hit = haystack.indexOf(target, from);
  }
  return found;
}

/**
 * Find every box worth painting in the OCR'd frame.
 *
 * Returns boxes in reading order, de-duplicated by value + position. The caller
 * drops the ones already covered by a redaction region and paints the rest.
 */
export function findTriageBoxes(lines: OcrLine[] | undefined, limits: TriageLimits = {}): TriageBox[] {
  const minConfidence = limits.minLineConfidence ?? MIN_LINE_CONFIDENCE;
  const spans = (limits.spans ?? []).map((s) => (s ?? "").trim()).filter((s) => s.length >= 3);
  const requested = (limits.requested ?? []).map((s) => (s ?? "").trim()).filter((s) => s.length >= 3);
  const boxes: TriageBox[] = [];
  const seen = new Set<string>();

  for (const line of lines ?? []) {
    const words = line?.words ?? [];
    if (words.length === 0) continue;
    // A line the engine itself is unsure about is noise, not text. Skipping it
    // cannot invent a box, and matching gibberish would box innocent pixels.
    //
    // REQUESTED values are the exception, and deliberately so: a low-confidence
    // line is exactly where a misread of a value we were asked to clear lives,
    // and the tolerant matcher — not the confidence floor — is what stops a
    // false match there. Pattern and NER matching still respect the floor.
    const confident = lineConfidence(words) >= minConfidence;
    if (!confident && requested.length === 0) continue;

    const { text, ranges } = joinLine(words);
    if (text.length < 3) continue;

    type Candidate = { start: number; end: number; value: string; kind: string; label: string; source: TriageBox["source"]; matchedSpan?: string };
    const candidates: Candidate[] = [];

    if (confident) {
      for (const match of matchPiiInText(text)) {
        candidates.push({
          start: match.start,
          end: match.end,
          value: match.value,
          // `${kind}_text` is the painter's opaque tier — see offscreen.ts.
          kind: `${match.kind}_text`,
          label: `${match.label} in image`,
          source: "pattern",
        });
      }
    }

    // Exact first, tolerant only as a fallback: a value OCR spelled correctly is
    // matched by the cheap path, and the tolerant pass never widens a box that
    // did not need widening.
    const addSpan = (span: string, source: TriageBox["source"], label: string, tolerant: boolean) => {
      const exact = spanRanges(text, span);
      for (const range of exact) {
        candidates.push({
          start: range.start,
          end: range.end,
          value: text.slice(range.start, range.end),
          kind: "ner_text",
          label,
          source,
          matchedSpan: span,
        });
      }
      if (exact.length > 0 || !tolerant) return;
      const near = tolerantWordWindow(ranges, span);
      if (!near) return;
      candidates.push({
        start: near.start,
        end: near.end,
        value: near.value,
        kind: "ner_text",
        label,
        source,
        matchedSpan: span,
      });
    };

    if (confident) {
      for (const span of spans) addSpan(span, "known_span", "Model-identified name in image", false);
    }
    for (const span of requested) {
      addSpan(span, "known_span", "Value the DOM could not place — read in image", true);
    }

    for (const candidate of candidates) {
      const box = unionBoxFor(ranges, candidate.start, candidate.end);
      if (!box || boxArea(box) <= 0) continue;
      // Same value at the same place, found by both channels (a name that is
      // also a cue-matched pattern) is one box.
      const key = `${candidate.value}\u0000${box.x},${box.y},${box.width},${box.height}`;
      if (seen.has(key)) continue;
      seen.add(key);
      boxes.push({
        ...box,
        value: candidate.value,
        kind: candidate.kind,
        label: candidate.label,
        source: candidate.source,
        ...(candidate.matchedSpan ? { matchedSpan: candidate.matchedSpan } : {}),
      });
    }
  }

  return boxes.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Drop boxes already covered by a redaction region.
 *
 * Runs on the redacted frame, so this is mostly about partial coverage: a
 * blurred field the OCR could still half-read, or a name the DOM scanner boxed
 * tightly while OCR's union is a few pixels wider. Keeping the covered box
 * would double-count a detection the pipeline already made.
 */
export function dropCoveredBoxes(
  boxes: TriageBox[] | undefined,
  covered: Array<{ x: number; y: number; width: number; height: number }> | undefined,
  coverage: number = COVERED_BOX_RATIO,
): TriageBox[] {
  const existing = covered ?? [];
  if (existing.length === 0) return [...(boxes ?? [])];
  return (boxes ?? []).filter((box) => {
    const area = boxArea(box);
    if (area <= 0) return false;
    return !existing.some((region) => overlapArea(box, region) / area >= coverage);
  });
}

/**
 * Apply the cap, reporting how many were dropped so the caller can say so
 * rather than implying the frame was fully triaged.
 */
export function capTriageBoxes(
  boxes: TriageBox[] | undefined,
  max: number = MAX_TRIAGE_BOXES,
): { kept: TriageBox[]; dropped: number } {
  const all = boxes ?? [];
  if (all.length <= max) return { kept: [...all], dropped: 0 };
  return { kept: all.slice(0, max), dropped: all.length - max };
}
