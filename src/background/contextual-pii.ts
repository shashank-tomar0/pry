/**
 * Contextual PII Detector
 *
 * Goes beyond regex pattern matching by analyzing:
 * 1. DOM structure - input field context (labels, nearby text, autocomplete)
 * 2. Page context - page type affects what's likely PII
 * 3. Element proximity - nearby labels/headers indicate field purpose
 * 4. Value patterns - combined with context for higher confidence
 *
 * This catches PII that pure regex misses:
 * - Names in "From:", "To:", "Sender:" fields
 * - Addresses in shipping/billing forms
 * - Phone numbers without standard formatting
 * - Organization names in company fields
 */

import type { DetectedPII } from "./pii-detector";

// ─── Contextual Field Patterns ──────────────────────────────────────────────

/**
 * Fields that commonly contain names (person or organization).
 * Detected by label text, placeholder, aria-label, or nearby text.
 */
const NAME_FIELD_PATTERNS: Array<{ pattern: RegExp; label: string; kind: "person" | "organization" }> = [
  { pattern: /\b(name|full\s*name|your\s*name|first\s*name|last\s*name|sender|from|recipient|to)\b/i, label: "Name field", kind: "person" },
  { pattern: /\b(company|organization|business|firm|vendor|supplier|client|employer)\b/i, label: "Organization field", kind: "organization" },
  { pattern: /\b(card\s*holder|account\s*holder|beneficiary)\b/i, label: "Account holder field", kind: "person" },
  { pattern: /\b(МЕСТО|Имя|ФИО)\b/, label: "Russian name field", kind: "person" },
];

/**
 * Fields that commonly contain addresses.
 */
const ADDRESS_FIELD_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(address|street|city|state|zip|postal|country|billing|shipping|location)\b/i, label: "Address field" },
  { pattern: /\b(landmark|area|district|pin\s*code)\b/i, label: "Indian address field" },
];

/**
 * Fields that commonly contain contact info.
 */
const CONTACT_FIELD_PATTERNS: Array<{ pattern: RegExp; label: string; kind: "phone" | "email" }> = [
  { pattern: /\b(phone|mobile|tel|contact|cell|fax)\b/i, label: "Phone field", kind: "phone" },
  { pattern: /\b(email|e-mail|mail)\b/i, label: "Email field", kind: "email" },
];

/**
 * Fields that commonly contain financial data.
 */
const FINANCIAL_FIELD_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(account|iban|routing|sort\s*code|bic|swift)\b/i, label: "Bank account field" },
  { pattern: /\b(card|credit|debit|visa|mastercard|amex)\b/i, label: "Card field" },
  { pattern: /\b(expiry|exp|valid\s*thru|cvc|cvv|cvv2)\b/i, label: "Card detail field" },
];

// ─── Text Value Patterns (Contextual) ───────────────────────────────────────

/** True when `word` looks like a name part in ANY script — Latin title-case
 * (Rahul, Dr., Kumari) or a run of Unicode letters/marks (राम, शर्मा, தமிழ்).
 * ASCII-only `[A-Z][a-z]+` missed every non-Latin name, which for Indian
 * users (Devanagari, Tamil, Telugu, …) let raw names ride past the pipeline. */
function isNameWord(word: string): boolean {
  if (/^[A-Z][a-z]+$/.test(word)) return true; // Latin title-case
  if (/^[A-Z]\.?$/.test(word)) return true; // single initial "A."
  if (/^(Mr|Mrs|Ms|Dr|Prof|Shri|Smt|Kumari|Sir|Madam)\.?$/i.test(word)) return true;
  // Any-script: ≥2 Unicode letters/marks, no digits — covers Devanagari etc.
  return /^[\p{L}\p{M}]{2,}$/u.test(word);
}

/**
 * Detect person names in text values using contextual clues.
 * Names typically: 2-4 words, each a name-like word (any script), no digits.
 */
function looksLikePersonName(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 80) return false;

  // Must be 2-4 words.
  const words = trimmed.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;

  let nameWords = 0;
  for (const word of words) nameWords += isNameWord(word) ? 1 : 0;

  // At least 70% of words should look like name parts.
  return nameWords / words.length >= 0.7;
}

/**
 * Detect organization names in text values.
 */
function looksLikeOrgName(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 100) return false;

  // Common org suffixes.
  const orgSuffixes = /\b(Inc|LLC|Ltd|Pvt|Corp|Co|Company|Solutions|Technologies|Tech|Services|Group|Associates|Partners|Enterprises|Stores|Traders|Trading)\b/i;
  if (orgSuffixes.test(trimmed)) return true;

  // 2+ words, no digits, and either all Latin title-case OR all Unicode-letter
  // words (covers Devanagari/other-script org names).
  const words = trimmed.split(/\s+/);
  if (words.length >= 2 && words.length <= 6) {
    const hasNoDigits = !/\d/.test(trimmed);
    const allTitleCase = words.every((w) => /^[A-Z]/.test(w));
    const allScriptWords = words.every((w) => /^[\p{L}\p{M}]+$/u.test(w));
    if (hasNoDigits && (allTitleCase || allScriptWords)) return true;
  }

  return false;
}

/**
 * Detect addresses in text values.
 */
function looksLikeAddress(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 10 || trimmed.length > 200) return false;

  // Address indicators.
  const addressIndicators = /\b(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|place|pl|circle|way|nagar|colony|sector|block|floor|flat|apt|suite|building|house|no\.|number)\b/i;
  const hasNumbers = /\d/.test(trimmed);
  const hasComma = /,/.test(trimmed);

  return addressIndicators.test(trimmed) && hasNumbers && hasComma;
}

/**
 * Detect phone numbers that don't match standard regex patterns.
 * Contextual: found in phone-labeled fields.
 */
function looksLikePhoneInContext(value: string): boolean {
  const trimmed = value.replace(/[\s\-().]/g, "");
  // Pure digits, 7-15 characters.
  if (!/^\+?\d{7,15}$/.test(trimmed)) return false;
  // If it starts with +91 or 91 and has 10 digits after, it's Indian.
  if (/^(\+?91)?[6-9]\d{9}$/.test(trimmed)) return true;
  // US format: 10-11 digits.
  if (/^1?\d{10}$/.test(trimmed)) return true;
  // General: 8-12 digits.
  if (/^\d{8,12}$/.test(trimmed)) return true;
  return false;
}

// ─── Main Detection ─────────────────────────────────────────────────────────

export interface ContextualDetection {
  kind: "person" | "organization" | "address" | "phone" | "email" | "financial";
  value: string;
  confidence: number;
  label: string;
  elementId?: number;
}

/**
 * Analyze a snapshot's elements and text for contextual PII.
 * This runs AFTER the regex detector and catches what regex misses.
 */
export function detectContextualPII(snapshot: {
  elements: Array<{
    id: number;
    role: string;
    name: string;
    value?: string;
    attrs?: Record<string, string>;
  }>;
  text: string;
  url: string;
  title: string;
}): ContextualDetection[] {
  const results: ContextualDetection[] = [];

  for (const el of snapshot.elements) {
    if (!el.value || el.value.length < 2) continue;

    const haystack = `${el.name} ${el.role} ${JSON.stringify(el.attrs ?? {})}`.toLowerCase();
    const value = el.value;

    // Check name fields.
    for (const { pattern, label, kind } of NAME_FIELD_PATTERNS) {
      if (pattern.test(haystack)) {
        // If the value looks like a name, flag it.
        if (kind === "person" && looksLikePersonName(value)) {
          results.push({ kind: "person", value, confidence: 0.85, label, elementId: el.id });
          break;
        }
        if (kind === "organization" && looksLikeOrgName(value)) {
          results.push({ kind: "organization", value, confidence: 0.8, label, elementId: el.id });
          break;
        }
      }
    }

    // Check address fields.
    for (const { pattern, label } of ADDRESS_FIELD_PATTERNS) {
      if (pattern.test(haystack) && looksLikeAddress(value)) {
        results.push({ kind: "address", value, confidence: 0.8, label, elementId: el.id });
        break;
      }
    }

    // Check phone fields.
    for (const { pattern, label, kind } of CONTACT_FIELD_PATTERNS) {
      if (pattern.test(haystack)) {
        if (kind === "phone" && looksLikePhoneInContext(value)) {
          results.push({ kind: "phone", value, confidence: 0.85, label, elementId: el.id });
          break;
        }
        if (kind === "email" && value.includes("@") && value.includes(".")) {
          results.push({ kind: "email", value, confidence: 0.9, label, elementId: el.id });
          break;
        }
      }
    }

    // Check financial fields.
    for (const { pattern, label } of FINANCIAL_FIELD_PATTERNS) {
      if (pattern.test(haystack) && /\d/.test(value) && value.replace(/\D/g, "").length >= 8) {
        results.push({ kind: "financial", value, confidence: 0.85, label, elementId: el.id });
        break;
      }
    }
  }

// Scan page text for names near identity keywords. Only STRUCTURED forms
  // count ("From:", "To:", "addressed to X", "sent by X") — bare mid-sentence
  // "to X" / "from X" matches video titles and prose on every site ("...go to
  // Learn DevOps Bootcamp..."), which produced phantom person detections.
  // `[\p{L}][\p{L}\p{M}]+` matches a name-like run of letters in ANY script.
  // End guard is a negative lookahead, not \b (\b is ASCII-\w-based and never
  // fires after a Devanagari/other-script letter run).
  const nameKeywordPattern = /\b((?:from|to|sender|recipient|name|company): *|addressed to |sent by )([\p{L}][\p{L}\p{M}]+(?: +[\p{L}][\p{L}\p{M}]+){1,3})(?![\p{L}\p{M}])/giu;
  let match;
  while ((match = nameKeywordPattern.exec(snapshot.text)) !== null) {
    const name = match[2];
    if (looksLikePersonName(name)) {
      // Avoid duplicates.
      if (!results.some((r) => r.value === name)) {
        results.push({ kind: "person", value: name, confidence: 0.7, label: "Name in page text" });
      }
    }
  }

  return results;
}

/**
 * Convert contextual detections to DetectedPII format for integration
 * with the existing privacy pipeline.
 */
export function contextualToDetectedPII(detections: ContextualDetection[]): DetectedPII[] {
  return detections.map((d) => ({
    kind: d.kind === "person" || d.kind === "organization" ? "pii_text" as const
      : d.kind === "phone" || d.kind === "email" ? "credential" as const
      : d.kind === "address" ? "pii_text" as const
      : "credential" as const,
    value: d.value,
    elementSelector: d.elementId !== undefined ? `[data-pry-id="${d.elementId}"]` : undefined,
    confidence: d.confidence,
    label: d.label,
  }));
}
