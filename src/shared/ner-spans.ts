/**
 * NER span normalization — pure, runtime-free.
 *
 * Kept separate from src/ml/ner.ts (which imports the transformers.js runtime)
 * so the verification harness and the model evaluator can pin this behavior
 * without pulling the ML runtime into the bundle, the same reason
 * src/shared/ner-labels.ts exists.
 *
 * WHY THIS EXISTS — the token-classification pipeline returns TWO different
 * shapes depending on the checkpoint and how the pipeline was constructed:
 *
 *   1. Pre-aggregated: `{ entity_group: "PER", word: "Priya Sharma", score }`
 *      — one already-merged entity per entry.
 *   2. Token-level:    `{ entity: "B-PER", word: "P", score }`,
 *                      `{ entity: "I-PER", word: "##riya", score }`, …
 *      — raw tags and subword pieces that must be merged by hand.
 *
 * Shape 2 is the dangerous one. Its labels carry BIO prefixes ("B-PER"), which
 * fail a plain PER/ORG/LOC policy check, so every span is discarded and the
 * on-device NER silently contributes nothing: names are never tokenized in the
 * text channel and never black-boxed in the pixel channel, while the self-test
 * (which lists raw spans without the policy filter) still cheerfully reports
 * that the model found entities. Silent zero is the failure mode this module
 * exists to prevent.
 */

export interface NerSpan {
  text: string;
  /** Normalized entity type: PER, ORG, LOC, or a PII class, uppercase. */
  label: string;
  score: number;
}

/** Raw shape returned by a token-classification pipeline. */
export interface NerRawSpan {
  entity_group?: string;
  entity?: string;
  label?: string;
  word?: string;
  score?: number | number[];
}

/** BIO / IOB2 / BILOU prefixes: B-PER, I-ORG, E-LOC, S-PER, U-PER, L-PER. */
const BIO_PREFIX_RE = /^([BIESUL])-/i;
/** WordPiece continuation: this token glues onto the previous one. */
const WORDPIECE_RE = /^##/;
/** SentencePiece marker: this token STARTS a word (the ▁ is a space). */
const SENTENCEPIECE_RE = /^\u2581/;
const MARKER_STRIP_RE = /^(##|\u2581)+/;
/** Tags that CONTINUE the previous entity rather than start a new one. */
const CONTINUES_PREVIOUS = new Set(["I", "E", "L", ""]);

/** Model scores arrive as a number, or as a per-label array in raw output. */
function coerceScore(score: number | number[] | undefined): number {
  if (Array.isArray(score)) {
    const best = score.filter((n) => Number.isFinite(n));
    return best.length > 0 ? Math.max(...best) : 0;
  }
  return Number(score ?? 0);
}

/**
 * Normalize model output into whole, labeled, marker-free spans.
 *
 * Merging rules, in order of precedence:
 *   - A subword marker (`##riya`, `▁Delhi`) always continues the previous span
 *     of the same type; `##` glues, `▁` joins with a space.
 *   - In token-level output, an `I-`/`E-`/`L-` (or unprefixed) tag continues
 *     the previous span of the same type; `B-`/`S-`/`U-` starts a new entity.
 *   - In pre-aggregated output nothing is merged by adjacency — each entry is
 *     already one entity, so fusing same-type neighbours would black-box two
 *     unrelated names together.
 */
export function normalizeSpans(raw: NerRawSpan[] | null | undefined): NerSpan[] {
  const out: NerSpan[] = [];
  for (const e of raw ?? []) {
    // `entity_group` marks pre-aggregated output; `entity` marks raw tags.
    const preAggregated = e?.entity_group !== undefined;
    const rawLabel = String(e?.entity_group ?? e?.entity ?? e?.label ?? "").trim();
    const prefix = BIO_PREFIX_RE.exec(rawLabel);
    const tag = prefix ? prefix[1].toUpperCase() : "";
    const type = rawLabel.replace(BIO_PREFIX_RE, "").trim().toUpperCase();
    // "O" is outside any entity; a blank type carries no information at all.
    if (!type || type === "O") continue;

    const rawWord = String(e?.word ?? "").replace(/\s+/g, " ").trim();
    // No surface text means the entry is unusable downstream: every consumer
    // matches on the literal string. Drop it rather than emit an empty span.
    if (!rawWord) continue;

    const isWordPiece = WORDPIECE_RE.test(rawWord);
    const isSentencePiece = SENTENCEPIECE_RE.test(rawWord);
    const clean = rawWord.replace(MARKER_STRIP_RE, "").trim();
    if (!clean) continue;

    const prev = out[out.length - 1];
    const sameType = prev !== undefined && prev.label === type;
    const marked = isWordPiece || isSentencePiece;
    const continues =
      sameType && (marked || (!preAggregated && CONTINUES_PREVIOUS.has(tag)));

    if (prev && continues) {
      const joiner = isWordPiece ? "" : " ";
      prev.text = (prev.text + joiner + clean).replace(/\s+/g, " ").trim();
      // Keep the weakest link: a merged span is only as confident as its least
      // confident fragment, so the detector's threshold stays honest.
      prev.score = Math.min(prev.score, coerceScore(e?.score));
      continue;
    }

    out.push({ text: clean, label: type, score: coerceScore(e?.score) });
  }
  return out;
}
