/**
 * Shared PII-in-text matchers for the redaction pixel channel.
 *
 * Why this exists: PRY's two privacy channels were disconnected. The TEXT
 * channel (pii-detector.ts) tokenizes emails, phones and names before the
 * LLM sees them — but the PIXEL channel (perceive.ts getSensitiveRegions)
 * only looked for input fields and ID-shaped numbers. Plain text carrying an
 * email — exactly what an opened text file is — was tokenized for the model
 * while remaining fully readable in the screenshot. Both channels must see
 * the same classes of PII.
 *
 * Pure functions only: no DOM, no chrome APIs. The content script consumes
 * this per text node to build redaction regions; the verification harness
 * pins the same matchers headlessly.
 */

import { isAadhaarNumber, isCardNumber } from "./checksums";

export interface TextPiiMatch {
  kind: "email" | "phone" | "id_text";
  label: string;
  start: number;
  end: number;
  value: string;
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Indian mobile: +91 prefix or bare 10 digits starting 6-9, with an optional
// internal separator ("98765 43210" / "98765-43210" / contiguous). Bounded so
// a 12-digit Aadhaar fragment cannot be eaten as a phone.
const PHONE_RE = /(?<!\d)(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g;

/** Checksum-validated ID shapes (formatted or raw where unambiguous). */
const ID_SHAPES: Array<{ re: RegExp; label: string; validate: (v: string) => boolean }> = [
  { re: /\b\d{4}[ -]\d{4}[ -]\d{4}\b/g, label: "Aadhaar number", validate: isAadhaarNumber },
  { re: /\b[A-Z]{5}\d{4}[A-Z]\b/g, label: "PAN card", validate: () => true },
  { re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, label: "IFSC code", validate: () => true },
  { re: /\b\d{3}-\d{2}-\d{4}\b/g, label: "SSN", validate: () => true },
  { re: /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b/g, label: "Card number", validate: isCardNumber },
  { re: /\b[A-Z]{2}\d{6,8}\b/g, label: "Passport number", validate: () => true },
];

/**
 * Find every PII span in `text` with checksum validation and overlap
 * de-duplication (a formatted Aadhaar must not also match as a phone).
 * Returns matches sorted by position so callers can build Ranges.
 */
export function matchPiiInText(text: string): TextPiiMatch[] {
  if (!text || text.length < 6) return [];
  const matches: TextPiiMatch[] = [];

  const collect = (re: RegExp, kind: TextPiiMatch["kind"], label: string, validate?: (v: string) => boolean): void => {
    const global = re.global ? re : new RegExp(re.source, re.flags + "g");
    for (const m of text.matchAll(global)) {
      if (m.index === undefined) continue;
      if (validate && !validate(m[0])) continue;
      matches.push({ kind, label, start: m.index, end: m.index + m[0].length, value: m[0] });
    }
  };

  collect(EMAIL_RE, "email", "Email address");
  collect(PHONE_RE, "phone", "Phone number");
  for (const shape of ID_SHAPES) collect(shape.re, "id_text", shape.label, shape.validate);

  // Drop matches fully contained inside an earlier, longer match (the
  // formatted-Aadhaar-inside-a-card-number case). Sorted so containment is
  // checkable in one pass.
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: TextPiiMatch[] = [];
  for (const m of matches) {
    const inside = kept.some((k) => m.start >= k.start && m.end <= k.end);
    if (!inside) kept.push(m);
  }
  return kept;
}
