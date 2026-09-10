/**
 * Detection v2 — fusion layer.
 *
 * Combines two detection sources into one detection list without letting
 * either dominate:
 *
 *   regex/checksum (v1.0) — high precision on structured IDs, near-zero FP
 *   NER spans (Tier 0)    — high recall on names/orgs/locations, any casing
 *
 * Fusion rules (pure, pinned by the harness):
 *   1. NER spans become pii_text detections with the model's confidence.
 *   2. A NER span whose text is contained in — or contains — a regex
 *      detection's value is dropped as a duplicate; the regex/checksum
 *      detection wins because checksums are mathematically certain.
 *   3. Everything else passes through unchanged.
 */

import type { DetectedPII } from "../background/pii-detector";

export interface NerSpanInput {
  text: string;
  label: string;
  score: number;
}

const LABEL_NAMES: Record<string, string> = {
  PER: "Person name",
  ORG: "Organization",
  LOC: "Location",
};

export function fuseDetections(
  base: DetectedPII[],
  nerSpans: NerSpanInput[],
): { detections: DetectedPII[]; added: number } {
  const values = base
    .map((d) => d.value)
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  const added: DetectedPII[] = [];
  for (const span of nerSpans) {
    const text = span.text.trim();
    if (text.length < 3) continue;
    // Duplicate if the span appears inside any known value or vice versa.
    const overlapping = values.some(
      (v) => v.includes(text) || text.includes(v),
    );
    if (overlapping) continue;
    // A span that repeats another NER span's text is also a duplicate.
    if (added.some((a) => a.value === text)) continue;

    added.push({
      kind: "pii_text",
      value: text,
      confidence: Math.min(0.95, Math.max(0.5, span.score)),
      label: `NER ${LABEL_NAMES[span.label] ?? span.label}`,
    });
  }

  return { detections: [...base, ...added], added: added.length };
}
