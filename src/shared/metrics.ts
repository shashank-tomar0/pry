/**
 * Accuracy metrics shared by the dashboard and the verification harness.
 *
 * PRY records three measured outcomes per detection: true positives
 * (detected AND redacted), false positives (checksum rejects, learned-rule
 * suppressions, user corrections) and misses (re-OCR leaks). Precision and
 * recall are derived from those counts — never asserted, always measured.
 */

export interface AccuracyMetrics {
  /** TP / (TP + FP) — how often a detection is right. Null when no signal. */
  precision: number | null;
  /** TP / (TP + FN) — how much of the PII present was caught. Null when no signal. */
  recall: number | null;
}

// ─── Run redaction tally ────────────────────────────────────────────────────

/**
 * The run's redaction counts, with each part named by the CHANNEL that made it.
 *
 * Two channels redact, and they count different things:
 *
 *   - `pageItems` — values tokenized or masked in the DOM/text channel, counted
 *     once per perception (the page's own PII, and anything the agent typed).
 *   - `frameRegions` — regions actually painted on captured frames, counted
 *     per frame by the painter.
 *
 * They were accumulated into one variable and reported by different processes
 * from different sources, which is how a single run showed 231 "items redacted"
 * in the transcript, 227 "Redacted" on the audit chip (frame regions only, and
 * only over the frames the audit still held) and 2 "Vault Tokens" — three
 * numbers for one run, none of them wrong, and no way for a reader to tell.
 * Keeping the parts apart and summing them in ONE place makes
 * `pageItems + frameRegions === total` true by construction, so every surface
 * that shows a total can show what it is made of.
 */
export interface RedactionTally {
  /** Values tokenized/redacted in the DOM + text channel (per perception). */
  pageItems: number;
  /** Regions painted on captured frames (per frame). */
  frameRegions: number;
  /** Unique vault tokens created this run — a population, not an addend. */
  tokens: number;
  /** `pageItems + frameRegions`. The only number a run should call a total. */
  total: number;
}

/** Build a run tally. Pure, so both processes and the harness derive it identically. */
export function redactionTally(
  pageItems: number,
  frameRegions: number,
  tokens: number,
): RedactionTally {
  const page = Math.max(0, Math.round(pageItems));
  const frames = Math.max(0, Math.round(frameRegions));
  return {
    pageItems: page,
    frameRegions: frames,
    tokens: Math.max(0, Math.round(tokens)),
    total: page + frames,
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * One sentence naming every part of the tally.
 *
 * Shared by the transcript's end-of-run line and the audit chip so the two can
 * never describe the same run differently — the drift this file exists to stop.
 */
export function describeRedactionTally(tally: RedactionTally): string {
  return (
    `${plural(tally.total, "redaction", "redactions")} ` +
    `(${plural(tally.frameRegions, "masked frame region", "masked frame regions")} + ` +
    `${plural(tally.pageItems, "page item", "page items")}) · ` +
    `${plural(tally.tokens, "vault token", "vault tokens")}`
  );
}

// ─── Per-frame verification, rolled up over the whole run ───────────────────

/** One frame's verification evidence, as the audit holds it. */
export interface FrameVerificationInput {
  verification?: {
    verified: boolean;
    regionsChecked: number;
    leakedPatterns?: string[];
  };
  /** Why the protection gate refused to let this frame's pixels leave. */
  withheld?: string[];
  /** True when this frame's redacted image actually reached a VLM. */
  shipped?: boolean;
}

/**
 * What the run as a whole can claim about its frames.
 *
 * The audit chip used to read ONLY the newest frame's verdict while showing
 * run-wide counts beside it, so a run in which one frame's mask verification
 * failed and its screenshot was withheld still badged "✓ REDACTIONS VERIFIED"
 * as long as some later frame passed. Every frame is counted here instead, and
 * the outcomes that are NOT passes are named rather than folded into one
 * boolean: a frame with nothing to check is not a failure, and a withheld frame
 * is not a pass.
 */
export interface AuditVerificationRollup {
  framesTotal: number;
  /** Frames whose re-OCR pass checked ≥1 region and found them destroyed. */
  framesVerified: number;
  /** Frames whose re-OCR pass found content still readable — the failures. */
  framesFailed: number;
  /** Frames with no verification evidence (nothing to check, or none ran). */
  framesUnchecked: number;
  /** Frames the protection gate refused to ship (residual/mask unresolved). */
  framesWithheld: number;
  /** Frames whose redacted image actually left the device (VLM vision on). */
  framesShipped: number;
  /**
   * True only when at least one frame was checked AND none failed AND none was
   * withheld. `framesUnchecked > 0` alone does not falsify it: a frame with no
   * regions has nothing a check could have found.
   */
  allVerified: boolean;
  /** Deduped leak patterns across failed frames — worst-case evidence first. */
  leakedPatterns: string[];
  /** One line naming every outcome, so a pass is never confused with a gap. */
  summary: string;
}

/** Roll a run's frame verification into the claim the audit badge may make. */
export function rollupFrameVerification(
  frames: FrameVerificationInput[],
): AuditVerificationRollup {
  let framesVerified = 0;
  let framesFailed = 0;
  let framesUnchecked = 0;
  let framesWithheld = 0;
  let framesShipped = 0;
  const leaked = new Set<string>();

  for (const frame of frames) {
    if (frame.shipped === true) framesShipped++;
    if ((frame.withheld?.length ?? 0) > 0) framesWithheld++;
    const v = frame.verification;
    if (!v || v.regionsChecked <= 0) {
      framesUnchecked++;
      continue;
    }
    if (v.verified) {
      framesVerified++;
    } else {
      framesFailed++;
      for (const pattern of v.leakedPatterns ?? []) leaked.add(pattern);
    }
  }

  const framesTotal = frames.length;
  const allVerified = framesFailed === 0 && framesWithheld === 0 && framesVerified > 0;

  const parts: string[] = [];
  if (framesVerified > 0) parts.push(`${framesVerified} verified`);
  if (framesFailed > 0) parts.push(`${framesFailed} FAILED re-OCR`);
  if (framesWithheld > 0) parts.push(`${framesWithheld} withheld from egress`);
  if (framesUnchecked > 0) parts.push(`${framesUnchecked} with nothing to check`);
  const detail = parts.length > 0 ? `: ${parts.join(" · ")}` : "";
  const summary =
    framesTotal === 0
      ? "No frames were captured this run."
      : `${plural(framesTotal, "frame", "frames")}${detail}` +
        (framesShipped > 0 ? ` · ${framesShipped} shipped to the vision model` : " · none left the device");

  return {
    framesTotal,
    framesVerified,
    framesFailed,
    framesUnchecked,
    framesWithheld,
    framesShipped,
    allVerified,
    leakedPatterns: [...leaked],
    summary,
  };
}

export function accuracyMetrics(
  truePositives: number,
  falsePositives: number,
  falseNegatives: number,
): AccuracyMetrics {
  const tp = Math.max(0, truePositives);
  const fp = Math.max(0, falsePositives);
  const fn = Math.max(0, falseNegatives);
  return {
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    recall: tp + fn > 0 ? tp / (tp + fn) : null,
  };
}
