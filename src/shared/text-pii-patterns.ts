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
  kind: "email" | "phone" | "id_text" | "name_text" | "api_key" | "credential";
  label: string;
  start: number;
  end: number;
  value: string;
}

/**
 * An email address, including one whose domain part was typed or pasted without
 * its TLD.
 *
 * The reported leak: "open gmail and write a mail to shashank.tomar.work@gmail"
 * ran with **0 vault tokens** — the address reached the planner verbatim, was
 * quoted back in the model's own reasoning, and the run's whole subject was that
 * address. Both channels required `@host.tld`, so a recipient typed without
 * ".com" was invisible to a product whose job is to notice it. The earlier run
 * of the same instruction WAS redacted ("sh•••@gmail.com" → <CRED_1>) — the
 * difference was four characters in the user's typing.
 *
 * Three shapes, strongest first:
 *   1. the ordinary address, `name@example.com`;
 *   2. a DOTTED local part at a bare host — `shashank.tomar.work@gmail`. A
 *      dotted local part is unmistakably an address, and that is what keeps the
 *      shapes this must NOT eat out of it: `sprite@2x` and `icon@3x` (retina
 *      asset names) have undotted local parts, `@media`/`@scope` (CSS at-rules)
 *      and `@types/node` (scoped packages) have no local part at all;
 *   3. an undotted local part at a known mail host, `raj@gmail` — the other half
 *      of how a real address gets truncated by hand.
 *
 * Exported as a source string so the DOM channel (pii-detector.ts) builds its
 * matcher from the SAME shape: two definitions of "an email" is exactly how the
 * text channel came to redact what the pixel channel left readable.
 */
export const EMAIL_PATTERN_SOURCE = [
  "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}\\b",
  "\\b[A-Za-z0-9_%+-]+(?:\\.[A-Za-z0-9_%+-]+)+@[A-Za-z0-9-]+\\b",
  "\\b[A-Za-z0-9._%+-]{2,}@(?:gmail|googlemail|yahoo|outlook|hotmail|live|icloud|proton|protonmail|rediffmail|zoho|aol|gmx|mail)\\b",
].join("|");

const EMAIL_RE = new RegExp(EMAIL_PATTERN_SOURCE, "gi");
// Indian mobile: +91 prefix or bare 10 digits starting 6-9, with an optional
// internal separator ("98765 43210" / "98765-43210" / contiguous). Bounded so
// a 12-digit Aadhaar fragment cannot be eaten as a phone.
const PHONE_RE = /(?<!\d)(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g;

/** Honorific followed by capitalised name (Mr. John Doe, Dr. Jane Smith, etc.) */
export const HONORIFIC_NAME_RE = /\b(?:Mr\.|Mrs\.|Ms\.|Miss|Dr\.|Prof\.|Shri|Smt\.)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g;

/**
 * Cue phrase followed by name (Name: John Doe, From: Jane Smith, etc.).
 *
 * The cue WORDS are case-insensitive but the NAME shape is case-sensitive by
 * construction: the old whole-pattern /i flag also relaxed `[A-Z]` to match
 * lowercase, so "From: Anita Desai ok" captured "Anita Desai ok" — and once
 * the text channel consumed this matcher, the trailing "ok" was vaulted as
 * part of the person. Inline `(?i:…)` scopes insensitivity to the cue words
 * (Chrome 116+, Node 20+).
 */
export const CUE_NAME_RE = /\b(?i:Name|Patient|Customer|Employee|Cardholder|Account\s+Holder|From|To|Sender|Recipient|Author|User|Contact)\s*:\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g;

/**
 * Provider-issued API key prefixes, as unanchored sources so every channel
 * builds from the same list: the pixel matcher compiles them global, the DOM
 * channel (pii-detector.ts) anchors them for field values and compiles them
 * global for free text.
 *
 * Reported live: a Discord message reading `api_key = sk-or-v1-…`,
 * `OPENROUTER_API_KEY = sk-or-v1-…`, `GEMINI_API_KEY = AIza…` shipped with
 * every key fully readable — no channel knew `sk-or-v1-`, `nvapi-`, `gsk_`
 * or `AIza` at all (the old list stopped at OpenAI/Anthropic/GitHub/Slack/
 * AWS/JWT), and the free-text scan never checked API keys in the first
 * place. Prefix-anchored and length-floored: the prefix is the authority,
 * so `sk-or-v1-` needs fewer trailing characters than a bare `sk-`.
 */
export const API_KEY_SOURCES: Array<{ source: string; label: string }> = [
  { source: "\\bsk-or-v1-[A-Za-z0-9]{16,}\\b", label: "OpenRouter API key" },
  { source: "\\bnvapi-[A-Za-z0-9_\\-]{16,}\\b", label: "NVIDIA API key" },
  { source: "\\bgsk_[A-Za-z0-9]{16,}\\b", label: "Groq API key" },
  { source: "\\bAIza[0-9A-Za-z_\\-]{20,}\\b", label: "Google API key" },
  { source: "\\bsk-ant-[A-Za-z0-9_\\-]{20,}\\b", label: "Anthropic API key" },
  { source: "\\bsk-proj-[A-Za-z0-9_\\-]{16,}\\b", label: "OpenAI project key" },
  { source: "\\bsk-[A-Za-z0-9]{20,}\\b", label: "OpenAI API key" },
  { source: "\\bsk_[A-Za-z0-9]{20,}\\b", label: "API key" },
  { source: "\\bgh[ops]_[A-Za-z0-9]{36}\\b", label: "GitHub token" },
  { source: "\\bxox[baprs]-[A-Za-z0-9\\-]+\\b", label: "Slack token" },
  { source: "\\bxai-[A-Za-z0-9]{16,}\\b", label: "xAI API key" },
  { source: "\\bAKIA[0-9A-Z]{16}\\b", label: "AWS access key" },
  {
    source: "\\beyJ[A-Za-z0-9_\\-]{8,}\\.[A-Za-z0-9_\\-]{8,}\\.[A-Za-z0-9_\\-]{8,}\\b",
    label: "JWT token",
  },
];

/**
 * Does this word look like a secret a user typed, rather than ordinary prose?
 *
 * Single source for the cue-secret gate: the tokenizer's task pass and the
 * shared cued-secret matcher below must agree, or a value vaulted from the
 * task stays readable in pixels (and vice versa). A secret in practice
 * carries a digit or a symbol; prose does not. Requiring one keeps the
 * capture precise, and the cost is stated: a value made only of letters
 * ("correcthorsebatterystaple") is NOT captured, because the rule that would
 * catch it also vaults the word "configuration".
 */
export function looksLikeSecret(value: string): boolean {
  const v = value.trim();
  if (v.length < 6) return false;
  if (/\s/.test(v)) return false;
  return /[\d]|[^A-Za-z0-9]/.test(v);
}

/** An OTP-shaped value after an explicit code cue ("Your OTP is 482916"). */
const OTP_CUE_RE =
  /\b(?:otp|one[-\s]?time(?:\s+(?:code|password|passcode))?|verification\s+code|security\s+code)\b\s*(?:is|:|=)?\s*(\d{4,8})\b/gi;
/**
 * A labelled secret ("password = hunter2x", "OPENROUTER_API_KEY = sk-or-…").
 * The optional vendor prefix is what the bare `api key` cue missed live: the
 * boundary after the cue word still has to hold, so `keyboard = x` never
 * qualifies — only a real cue word does.
 */
const LABELLED_SECRET_RE =
  /\b(?:password|passphrase|pwd|passcode|pin|(?:[\w-]+[_-])?api[\s_-]?key|(?:[\w-]+[_-])?apikey|key|secret|access[\s_-]?token|token)\b\s*(?:is|:|=)\s*([^\s,;]+)/gi;
/** The bare form ("with password hunter2copy"): no separator, so the value has
 *  to look like a secret on its own — and only the password-family cues count. */
const BARE_SECRET_RE = /\b(?:password|passphrase|pwd|passcode)\b\s+([^\s,;]+)/gi;

export interface CuedSecret {
  start: number;
  end: number;
  value: string;
  label: string;
}

/**
 * Secrets that have no distinguishing shape — an OTP is six digits, a
 * password is whatever was chosen — found by their cue words instead, in any
 * text (tasks, page bodies, single text nodes). The cue word is what makes
 * these safe to capture, and `looksLikeSecret` is what stops "open the
 * password manager" from vaulting the word "manager".
 */
export function matchCuedSecrets(text: string): CuedSecret[] {
  const out: CuedSecret[] = [];
  const take = (re: RegExp, label: string): void => {
    // Fresh global per clause: these regexes carry lastIndex state, and a
    // shared instance would resume mid-text on the second caller.
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of text.matchAll(global)) {
      if (m.index === undefined || !m[1]) continue;
      const value = m[1].trim();
      if (!looksLikeSecret(value) && label !== "OTP code") continue;
      const start = m.index + m[0].indexOf(m[1]);
      out.push({ start, end: start + m[1].length, value, label });
    }
  };
  take(OTP_CUE_RE, "OTP code");
  take(LABELLED_SECRET_RE, "Secret value");
  take(BARE_SECRET_RE, "Secret value");
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  return out;
}

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
  collect(HONORIFIC_NAME_RE, "name_text", "Person name");
  for (const shape of ID_SHAPES) collect(shape.re, "id_text", shape.label, shape.validate);
  for (const key of API_KEY_SOURCES) {
    collect(new RegExp(key.source, "g"), "api_key", key.label);
  }
  // Cued secrets carry no shape of their own — the cue word plus the
  // looks-like-a-secret gate is the whole signal. Only the VALUE span is
  // kept (not the cue), so the painted box and the vault token cover the
  // secret and nothing around it.
  for (const s of matchCuedSecrets(text)) {
    matches.push({ kind: "credential", label: s.label, start: s.start, end: s.end, value: s.value });
  }

  for (const m of text.matchAll(CUE_NAME_RE)) {
    if (m.index === undefined || !m[1]) continue;
    const nameStart = m.index + m[0].indexOf(m[1]);
    matches.push({ kind: "name_text", label: "Person name", start: nameStart, end: nameStart + m[1].length, value: m[1] });
  }

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
