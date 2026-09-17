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
}

export interface TriageLimits {
  /** Spans the on-device NER found on this page. */
  spans?: string[];
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
  const boxes: TriageBox[] = [];
  const seen = new Set<string>();

  for (const line of lines ?? []) {
    const words = line?.words ?? [];
    if (words.length === 0) continue;
    // A line the engine itself is unsure about is noise, not text. Skipping it
    // cannot invent a box, and matching gibberish would box innocent pixels.
    if (lineConfidence(words) < minConfidence) continue;

    const { text, ranges } = joinLine(words);
    if (text.length < 3) continue;

    const candidates: Array<{ start: number; end: number; value: string; kind: string; label: string; source: TriageBox["source"] }> = [];

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

    for (const span of spans) {
      for (const range of spanRanges(text, span)) {
        candidates.push({
          start: range.start,
          end: range.end,
          value: text.slice(range.start, range.end),
          kind: "ner_text",
          label: "Model-identified name in image",
          source: "known_span",
        });
      }
    }

    for (const candidate of candidates) {
      const box = unionBoxFor(ranges, candidate.start, candidate.end);
      if (!box || boxArea(box) <= 0) continue;
      // Same value at the same place, found by both channels (a name that is
      // also a cue-matched pattern) is one box.
      const key = `${candidate.value}\u0000${box.x},${box.y},${box.width},${box.height}`;
      if (seen.has(key)) continue;
      seen.add(key);
      boxes.push({ ...box, value: candidate.value, kind: candidate.kind, label: candidate.label, source: candidate.source });
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
