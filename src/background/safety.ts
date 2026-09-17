/**
 * Safety Gate
 *
 * The single enforcement point for all sensitive-action checks. Runs before
 * every action — the planner's own judgement is a suggestion, not the authority.
 *
 * Three verdicts:
 *   - allow: action proceeds immediately
 *   - confirm: user must approve before the action runs
 *   - refuse: action is blocked outright, planner gets an error explaining why
 *
 * This module also handles prompt injection detection: page text that attempts
 * to instruct the AI agent is flagged and ignored.
 */

import type { AgentAction, PageElement, PageSnapshot } from "../shared/types";
import { isAadhaarNumber, isCardNumber } from "../shared/checksums";
import { normalizeForMatch } from "../shared/text-target";

// ─── Credential Patterns ────────────────────────────────────────────────────

/**
 * Field-level credential detection. If a target element matches any of these
 * patterns, typing into it is refused regardless of what the planner asked.
 */
const CREDENTIAL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bpassword\b/i, label: "Password field" },
  { pattern: /\bpasscode\b/i, label: "Passcode field" },
  { pattern: /\bcvv\b/i, label: "CVV field" },
  { pattern: /\bcvc\b/i, label: "CVC field" },
  { pattern: /\bcard\s*number\b/i, label: "Card number field" },
  { pattern: /\bcredit\s*card\b/i, label: "Credit card field" },
  { pattern: /\bdebit\s*card\b/i, label: "Debit card field" },
  { pattern: /\bexpiry\b/i, label: "Expiry field" },
  { pattern: /\bssn\b/i, label: "SSN field" },
  { pattern: /\bsocial\s*security\b/i, label: "Social security field" },
  { pattern: /\baadhaar\b/i, label: "Aadhaar field" },
  { pattern: /\bpan\s*(card|number)\b/i, label: "PAN card field" },
  { pattern: /\bpassport\b/i, label: "Passport field" },
  { pattern: /\bifsc\b/i, label: "IFSC field" },
  { pattern: /\baccount\s*number\b/i, label: "Account number field" },
  { pattern: /\bone[-\s]?time\s*(code|password)\b/i, label: "One-time code field" },
  { pattern: /\botp\b/i, label: "OTP field" },
  { pattern: /\bapi[-\s]?key\b/i, label: "API key field" },
  { pattern: /\bsecret\b/i, label: "Secret field" },
  { pattern: /\bprivate[-\s]?key\b/i, label: "Private key field" },
  { pattern: /\bsigning[-\s]?key\b/i, label: "Signing key field" },
  { pattern: /\bbank\s*account\b/i, label: "Bank account field" },
  { pattern: /\brouting\s*number\b/i, label: "Routing number field" },
  { pattern: /\bpin\b/i, label: "PIN field" },
];

/**
 * Value-level patterns for secrets that have NO checksum to validate against.
 *
 * Their shapes are self-identifying (a `sk-ant-` prefix is not a coincidence),
 * so an anchored shape test is the strongest evidence available: there is no
 * arithmetic that could confirm or refute one.
 */
const VALUE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // API keys
  { pattern: /^sk-ant-[a-zA-Z0-9_-]{20,}/, label: "Anthropic API key" },
  { pattern: /^sk-[a-zA-Z0-9]{20,}/, label: "OpenAI API key" },
  { pattern: /^ghp_[a-zA-Z0-9]{36}/, label: "GitHub personal access token" },
  { pattern: /^gho_[a-zA-Z0-9]{36}/, label: "GitHub OAuth token" },
  { pattern: /^ghs_[a-zA-Z0-9]{36}/, label: "GitHub server-to-server token" },
  { pattern: /^xox[baprs]-[a-zA-Z0-9-]+/, label: "Slack token" },
  { pattern: /^AKIA[0-9A-Z]{16}/, label: "AWS access key" },
  { pattern: /^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\./, label: "JWT token" },
  { pattern: /^-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, label: "Private key" },
  // SSN: XXX-XX-XXXX. No checksum exists, so the shape is the whole test.
  { pattern: /^\d{3}-\d{2}-\d{4}$/, label: "SSN" },
];

/**
 * Identifier shapes that CAN be validated, and are therefore only refused when
 * the arithmetic agrees.
 *
 * This used to be three bare regexes, and the cost was real: `/\b\d{4}\s?\d{4}\s?\d{4}\b/`
 * refuses any twelve-digit run with optional single spaces — an order number, a
 * reference, a phone-plus-extension — with a message claiming it "looks like an
 * Aadhaar number". The rest of this codebase is built on the opposite principle,
 * stated in `shared/checksums.ts`: regex hits become validated detections and
 * lookalikes become MEASURED false positives instead of over-redaction. The same
 * standard belongs on the typing gate, so a value is refused when a real Aadhaar
 * (Verhoeff, never 0/1-led) or a real card (Luhn) is found in it.
 *
 * Scanning without anchors rather than matching the whole string is deliberate:
 * "my aadhaar is 2345 6789 0123" typed into a field still contains the identity
 * number, and refusing only when the value IS the number would let that through.
 *
 * PAN keeps a shape-only test because PAN has no checkable digit — but its
 * pattern is 10 characters in a strictly alternating letter/digit form, so it is
 * not the false-positive source that a bare digit run is.
 */
export function matchedIdentifierLabel(text: string): string | undefined {
  // Cards: 13-19 digits with optional separators, validated by Luhn.
  for (const m of text.matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)) {
    if (isCardNumber(m[0])) return "Card number";
  }
  // Aadhaar: exactly 12 digits, 4-4-4 or contiguous, validated by Verhoeff.
  for (const m of text.matchAll(/(?<!\d)\d{4}[ -]?\d{4}[ -]?\d{4}(?!\d)/g)) {
    if (isAadhaarNumber(m[0])) return "Aadhaar number";
  }
  if (/\b[A-Z]{5}\d{4}[A-Z]\b/.test(text)) return "PAN number";
  return undefined;
}

// ─── Irreversible Action Patterns ───────────────────────────────────────────

const IRREVERSIBLE_PATTERNS: Array<RegExp> = [
  /\b(buy|purchase|place\s*order|checkout|pay|payment)\b/i,
  /\b(send|reply|forward|post|publish|tweet|share)\b/i,
  /\b(delete|remove|discard|erase|deactivate|close\s*account)\b/i,
  /\b(confirm|submit|book\s*now|reserve|apply\s*now)\b/i,
  /\b(transfer|withdraw|donate|subscribe|upgrade)\b/i,
  /\b(sign\s*up|create\s*account|register)\b/i,
  /\b(accept|agree)\b/i,
];

// ─── Gate Decision ──────────────────────────────────────────────────────────

export type Gate =
  | { verdict: "allow" }
  | { verdict: "refuse"; reason: string }
  | { verdict: "confirm"; summary: string };

function elementOf(snapshot: PageSnapshot | undefined, id: unknown): PageElement | undefined {
  if (!snapshot || typeof id !== "number") return undefined;
  return snapshot.elements.find((e) => e.id === id);
}

function looksCredential(el: PageElement | undefined): boolean {
  if (!el) return false;
  if (el.role === "password") return true;
  if (el.attrs?.inputType === "password") return true;
  const haystack = `${el.name} ${el.attrs?.inputType ?? ""} ${el.role}`;
  return CREDENTIAL_PATTERNS.some((p) => p.pattern.test(haystack));
}

function credentialLabel(el: PageElement | undefined): string {
  if (!el) return "credential field";
  const haystack = `${el.name} ${el.attrs?.inputType ?? ""} ${el.role}`;
  for (const { pattern, label } of CREDENTIAL_PATTERNS) {
    if (pattern.test(haystack)) return label;
  }
  return "credential field";
}

function matchesValuePattern(text: string): string | undefined {
  for (const vp of VALUE_PATTERNS) {
    if (vp.pattern.test(text)) return vp.label;
  }
  return undefined;
}

/**
 * The main safety gate. Called before every action the planner requests.
 */
export function gate(
  action: AgentAction,
  snapshot: PageSnapshot | undefined,
  confirmRisky: boolean,
): Gate {
  const el = elementOf(snapshot, action.input.element_id);

  // ── Type action safety ──
  if (action.name === "type") {
    // Check if the target field is a credential.
    if (looksCredential(el)) {
      return {
        verdict: "refuse",
        reason:
          `Refusing to type into ${JSON.stringify(el?.name ?? "this field")} — ` +
          `${credentialLabel(el)}. Tell the user to fill it in themselves, ` +
          `then continue once they confirm they have.`,
      };
    }

    // Check if the value itself is a secret.
    const text = String(action.input.text ?? "");
    const matchLabel = matchesValuePattern(text);
    if (matchLabel) {
      return {
        verdict: "refuse",
        reason:
          `Refusing to type that value — it looks like a ${matchLabel}. ` +
          `The user should enter it themselves.`,
      };
    }

    // Check whether the value CONTAINS a checksum-valid identifier. Validating
    // rather than shape-matching is the difference between refusing a real
    // Aadhaar/card and refusing every twelve-digit run with spaces in it.
    const identifier = matchedIdentifierLabel(text);
    if (identifier) {
      return {
        verdict: "refuse",
        reason:
          `Refusing to type that value — it validates as a ${identifier}. ` +
          `Identity and payment documents are the user's to enter, not the agent's; ` +
          `ask them to fill the field, then continue once they confirm.`,
      };
    }
  }

  // A text-anchored click with no usable text is not a click, it is a blind
  // click — refused whether or not confirmations are enabled, because there is
  // no target to confirm and the click would land on whatever happens to be
  // under the pointer.
  if (action.name === "click_text" && normalizeForMatch(String(action.input.text ?? "")).length < 2) {
    return {
      verdict: "refuse",
      reason: "click_text needs the visible text of the target (at least 2 characters).",
    };
  }

  // ── If confirmations are disabled, allow everything that passed the checks above ──
  if (!confirmRisky) return { verdict: "allow" };

  // ── Click action safety ──
  if (action.name === "click" && el) {
    const label = `${el.name} ${el.role}`;
    if (IRREVERSIBLE_PATTERNS.some((p) => p.test(label))) {
      return {
        verdict: "confirm",
        summary: `Click ${JSON.stringify(el.name)} on ${snapshot?.title ?? "this page"}?`,
      };
    }
  }

  // A text-anchored click has no element to inspect, so the REQUESTED TEXT is
  // what gets checked. Without this, click_text would be a hole in the same
  // confirmation the id-based path enforces: "Delete account" is just as
  // irreversible typed as it is resolved.
  if (action.name === "click_text") {
    const text = String(action.input.text ?? "");
    if (IRREVERSIBLE_PATTERNS.some((p) => p.test(text))) {
      return {
        verdict: "confirm",
        summary: `Click ${JSON.stringify(text)} on ${snapshot?.title ?? "this page"}?`,
      };
    }
  }

  // ── Form submission safety ──
  if (action.name === "type" && action.input.submit === true && el) {
    const isSearch = /search|query|find|filter/i.test(`${el.name} ${el.role}`);
    if (!isSearch) {
      return {
        verdict: "confirm",
        summary: `Fill ${JSON.stringify(el.name)} and submit the form on ${snapshot?.title ?? "this page"}?`,
      };
    }
  }

  return { verdict: "allow" };
}

// ─── Prompt Injection Detection ─────────────────────────────────────────────

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /\b(system\s*prompt|you\s+are\s+now)\b/i,
  /\bas\s+an?\s+ai\s+(agent|assistant)[,:]/i,
  /\bdisregard\s+(your|the)\s+(instructions|rules)\b/i,
  /\bpretend\s+(you\s+are|to\s+be)\b/i,
  /\bjailbreak\b/i,
  /\bdo\s+anything\s+now\b/i,
  /\bdeveloper\s+mode\b/i,
  /\bunrestricted\s+mode\b/i,
];

/**
 * Checks if page text contains instructions aimed at an AI agent.
 * Returns the matched pattern if found, undefined otherwise.
 */
export function detectInjection(snapshot: PageSnapshot): string | undefined {
  const combined = `${snapshot.text} ${snapshot.title}`;
  for (const pattern of INJECTION_PATTERNS) {
    const match = combined.match(pattern);
    if (match) return match[0];
  }
  return undefined;
}

