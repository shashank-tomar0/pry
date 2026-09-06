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
