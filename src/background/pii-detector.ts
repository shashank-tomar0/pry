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
  kind: "face" | "credential" | "id_number" | "api_key" | "pii_text";
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

const API_KEY_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^sk-ant-[a-zA-Z0-9_-]{20,}/, label: "Anthropic API key" },
  { pattern: /^sk-[a-zA-Z0-9]{20,}/, label: "OpenAI API key" },
  { pattern: /^ghp_[a-zA-Z0-9]{36}/, label: "GitHub personal access token" },
  { pattern: /^gho_[a-zA-Z0-9]{36}/, label: "GitHub OAuth token" },
  { pattern: /^ghs_[a-zA-Z0-9]{36}/, label: "GitHub server-to-server token" },
  { pattern: /^xox[baprs]-[a-zA-Z0-9-]+/, label: "Slack token" },
  { pattern: /^AKIA[0-9A-Z]{16}/, label: "AWS access key" },
  { pattern: /^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\./, label: "JWT token" },
];

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
const EMAIL_PATTERN = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/;
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
    { pattern: EMAIL_PATTERN, kind: "credential", label: "Email address" },
    { pattern: PHONE_PATTERN, kind: "credential", label: "Phone number" },
  ];

  for (const { pattern, kind, label, validate } of patterns) {
    const globalRegex = pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + "g");
    const matches = text.matchAll(globalRegex);
    for (const match of matches) {
      if (match.index === undefined) continue;
      if (validate && !validate(match[0])) {
        rejected.push({
          kind,
          value: match[0],
          confidence: 0.15,
          label: `${label} lookalike (checksum failed)`,
        });
        continue;
      }
      detections.push({
        kind,
        value: match[0],
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
