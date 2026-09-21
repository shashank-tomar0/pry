/**
 * PII Detection Engine
 *
 * Runs on-device to detect sensitive data before it crosses any network boundary.
 * Three detection channels:
 *   1. Visual — face detection via Chrome FaceDetector / skin-color fallback
 *   2. DOM — credential fields, API keys, card numbers via regex + element metadata
 *   3. Text — Aadhaar, PAN, SSN, passport numbers via pattern matching
 *
 * ID-shaped numbers are not trusted on regex alone: Aadhaar candidates must
 * pass the Verhoeff checksum and card candidates must pass Luhn. Matches that
 * fail the checksum are surfaced as `rejected` candidates (a real false
 * positive signal) instead of being redacted — over-redaction is itself a
 * privacy failure.
 *
 * All detection is synchronous for DOM/text and returns bounding boxes for
 * visual detection so the redaction engine knows exactly what to blur/mask.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BoundingBox {
  /** Normalized 0–1 coordinates relative to the screenshot dimensions. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedPII {
  kind: "face" | "credential" | "id_number" | "api_key" | "pii_text" | "image_text";
  /** Bounding box for visual redaction (faces). */
  box?: BoundingBox;
  /** The original value that was detected (for DOM-based PII). */
  value?: string;
  /** DOM element reference for field-level redaction. */
  elementSelector?: string;
  /** Confidence 0–1. */
  confidence: number;
  /** Human-readable label for logging/transparency. */
  label: string;
}

import { isAadhaarNumber, isCardNumber } from "../shared/checksums";
// One email shape for both channels, built from the shared source rather than
// re-typed: the two copies drifted once already, and the result was a value
// tokenized for the model while staying readable pixels on screen.
import {
  API_KEY_SOURCES,
  CUE_NAME_RE,
  EMAIL_PATTERN_SOURCE,
  HONORIFIC_NAME_RE,
  matchCuedSecrets,
} from "../shared/text-pii-patterns";

// ─── DOM-Based PII Detection ───────────────────────────────────────────────

const CREDENTIAL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bpassword\b/i, label: "Password field" },
  { pattern: /\bpasscode\b/i, label: "Passcode field" },
  { pattern: /\bcvv\b/i, label: "CVV field" },
  { pattern: /\bcvc\b/i, label: "CVC field" },
  { pattern: /\bcard\s*number\b/i, label: "Card number field" },
  { pattern: /\bcredit\s*card\b/i, label: "Credit card field" },
  { pattern: /\bdebit\s*card\b/i, label: "Debit card field" },
  { pattern: /\bexpiry\b/i, label: "Expiry field" },
  { pattern: /\botp\b/i, label: "OTP field" },
  { pattern: /\bone[-\s]?time\s*(code|password)\b/i, label: "One-time code field" },
  { pattern: /\bsecret\b/i, label: "Secret field" },
  { pattern: /\bapi[-\s]?key\b/i, label: "API key field" },
];

const API_KEY_PATTERNS: Array<{ pattern: RegExp; label: string }> = API_KEY_SOURCES.map(
  ({ source, label }) => ({ pattern: new RegExp(`^(?:${source})`), label }),
);

const INDIAN_ID_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Aadhaar: 12 digits, may be grouped as XXXX XXXX XXXX
  { pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/, label: "Possible Aadhaar number" },
  // PAN: 5 letters + 4 digits + 1 letter
  { pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/, label: "PAN card number" },
  // IFSC code
  { pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/, label: "IFSC code" },
];

const INTERNATIONAL_ID_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // SSN: XXX-XX-XXXX
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, label: "SSN" },
  // Passport: 1-2 letters + 6-8 digits (simplified)
  { pattern: /\b[A-Z]{1,2}\d{6,8}\b/, label: "Possible passport number" },
];

const CARD_NUMBER_PATTERN = /\b(?:\d{4}[\s-]?){3}\d{4}\b/;
const EMAIL_PATTERN = new RegExp(EMAIL_PATTERN_SOURCE, "i");
// Indian mobile: +91 prefix or bare 10 digits starting 6-9, optional internal
// separator ("98765 43210"). Matches the pixel-channel matcher in
// shared/text-pii-patterns.ts so both channels see the same classes.
const PHONE_PATTERN = /(?<!\d)(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g;
// Generic phone-looking numbers used inside phone-labeled fields are handled
// contextually — this free-text channel only flags unambiguous patterns.


/**
 * Scans the DOM tree for PII in element names, values, labels, and attributes.
 * Returns detected PII with element selectors for targeted redaction.
 */
export function detectDOMPII(snapshot: {
  elements: Array<{
    id: number;
    role: string;
    name: string;
    value?: string;
    attrs?: Record<string, string>;
  }>;
  text: string;
}): DetectedPII[] {
  const results: DetectedPII[] = [];

  for (const el of snapshot.elements) {
    const haystack = `${el.name} ${el.role} ${el.value ?? ""} ${Object.values(el.attrs ?? {}).join(" ")}`;

    // Check for credential fields
    for (const { pattern, label } of CREDENTIAL_PATTERNS) {
      if (pattern.test(haystack)) {
        results.push({
          kind: "credential",
          value: el.value,
          elementSelector: `[data-pry-id="${el.id}"]`,
          confidence: 0.9,
          label,
        });
        break; // One match per element is enough
      }
    }

    // Check if the value itself is an API key
    if (el.value) {
      for (const { pattern, label } of API_KEY_PATTERNS) {
        if (pattern.test(el.value)) {
          results.push({
            kind: "api_key",
            value: el.value,
            elementSelector: `[data-pry-id="${el.id}"]`,
            confidence: 0.95,
            label,
          });
          break;
        }
      }

      // Check for card numbers in field values. A field explicitly about a
      // card is trusted regardless; a generic 16-digit string only counts when
      // it passes Luhn, so order/reference numbers are not redacted as cards.
      if (CARD_NUMBER_PATTERN.test(el.value)) {
        const cardish = /card|credit|debit|cc[-_\s]|card_/i.test(haystack);
        if (cardish || isCardNumber(el.value)) {
          results.push({
            kind: "credential",
            value: el.value,
            elementSelector: `[data-pry-id="${el.id}"]`,
            confidence: cardish ? 0.9 : 0.85,
            label: cardish ? "Card number in card field" : "Card number (Luhn valid)",
          });
        }
      }
    }
  }

  return results;
}

interface TextPattern {
  pattern: RegExp;
  kind: DetectedPII["kind"];
  label: string;
  /** Validator: when present, hits that fail it become `rejected` candidates. */
  validate?: (match: string) => boolean;
  /**
   * Match group carrying the VALUE. The cue-name pattern matches "From: Jane
   * Smith" but only group 1 ("Jane Smith") is PII — vaulting the whole match
   * would eat the cue label everywhere it appears.
   */
  valueGroup?: number;
}

/**
 * Scans free text for ID numbers (Aadhaar, PAN, SSN, etc.), email addresses,
 * and phone numbers. Aadhaar candidates must pass the Verhoeff checksum;
 * lookalikes are returned in `rejected` so they can be measured as false
 * positives instead of silently redacted.
 */
export function detectTextPIIDetailed(text: string): {
  detections: DetectedPII[];
  rejected: DetectedPII[];
} {
  const detections: DetectedPII[] = [];
  const rejected: DetectedPII[] = [];

  const patterns: TextPattern[] = [
    ...INDIAN_ID_PATTERNS.map((p): TextPattern => {
      const isAadhaar = p.label === "Possible Aadhaar number";
      return {
        pattern: p.pattern,
        kind: "id_number",
        label: isAadhaar ? "Aadhaar number (Verhoeff ✓)" : p.label,
        validate: isAadhaar ? (m) => isAadhaarNumber(m) : undefined,
      };
    }),
    ...INTERNATIONAL_ID_PATTERNS.map((p): TextPattern => ({ pattern: p.pattern, kind: "id_number", label: p.label })),
    ...API_KEY_SOURCES.map(
      ({ source, label }): TextPattern => ({
        pattern: new RegExp(source, "g"),
        kind: "api_key",
        label,
      }),
    ),
    // Regex-visible names: the NER model catches bare names, but honorific
    // and cue-labelled names are deterministic — the pixel channel already
    // paints them, so the text channel must tokenize them too.
    {
      pattern: new RegExp(HONORIFIC_NAME_RE.source, HONORIFIC_NAME_RE.flags),
      kind: "pii_text",
      label: "Person name",
    },
    {
      pattern: new RegExp(CUE_NAME_RE.source, CUE_NAME_RE.flags),
      kind: "pii_text",
      label: "Person name",
      valueGroup: 1,
    },
    // Bare card numbers (Luhn-checked like the pixel channel) and cue-word
    // secrets (OTP, passwords): neither has a detector of its own, so page
    // text carrying them reached the planner raw while pixels were painted.
    {
      pattern: /\b(?:\d{4}[\s-]?){3}\d{4}\b/g,
      kind: "credential",
      label: "Card number (Luhn valid)",
      validate: (m) => isCardNumber(m),
    },
    { pattern: EMAIL_PATTERN, kind: "credential", label: "Email address" },
    { pattern: PHONE_PATTERN, kind: "credential", label: "Phone number" },
  ];

  // Cued secrets report value spans (not whole matches), so they join below
  // rather than through the pattern table.
  for (const s of matchCuedSecrets(text)) {
    detections.push({ kind: "credential", value: s.value, confidence: 0.9, label: s.label });
  }

  for (const { pattern, kind, label, validate, valueGroup } of patterns) {
    const globalRegex = pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + "g");
    const matches = text.matchAll(globalRegex);
    for (const match of matches) {
      if (match.index === undefined) continue;
      const hit = valueGroup !== undefined ? (match[valueGroup] ?? "") : match[0];
      if (!hit) continue;
      if (validate && !validate(hit)) {
        rejected.push({
          kind,
          value: hit,
          confidence: 0.15,
          label: `${label} lookalike (checksum failed)`,
        });
        continue;
      }
      detections.push({
        kind,
        value: hit,
        confidence: kind === "credential" ? 0.9 : 0.7,
        label,
      });
    }
  }

  return { detections, rejected };
}

/**
 * Combined PII detection across all channels, with rejected lookalikes.
 * Called before any data leaves the client.
 */
export function detectAllPIIDetailed(
  snapshot: {
    elements: Array<{
      id: number;
      role: string;
      name: string;
      value?: string;
      attrs?: Record<string, string>;
    }>;
    text: string;
  },
): {
  detections: DetectedPII[];
  rejected: DetectedPII[];
} {
  const text = detectTextPIIDetailed(snapshot.text);
  return {
    detections: [...detectDOMPII(snapshot), ...text.detections],
    rejected: text.rejected,
  };
}

/**
 * Combined PII detection across all channels (accepted candidates only).
 * Called before any data leaves the client.
 */
export function detectAllPII(
  snapshot: {
    elements: Array<{
      id: number;
      role: string;
      name: string;
      value?: string;
      attrs?: Record<string, string>;
    }>;
    text: string;
  },
): DetectedPII[] {
  return detectAllPIIDetailed(snapshot).detections;
}
