/**
 * PII Tokenizer
 *
 * Replaces sensitive values with opaque tokens before data crosses the wire.
 * The vault is held in memory only — never persisted to chrome.storage or
 * any other durable storage.
 *
 * Token format: `<TYPE_N>` where TYPE is ORG, PERSON, ID, CRED, KEY
 * and N is a monotonically increasing counter per type.
 *
 * The server receives tokens and can reference them in responses, but can
 * never resolve them back to real values.
 */

import type { DetectedPII } from "./pii-detector";

// ─── Token Vault ────────────────────────────────────────────────────────────

export interface TokenEntry {
  token: string;
  /** The original value — held only in memory. */
  original: string;
  kind: DetectedPII["kind"];
  createdAt: number;
}

export type TokenVault = Map<string, TokenEntry>;

/** Token type prefixes for different PII categories. */
const TOKEN_PREFIXES: Record<DetectedPII["kind"], string> = {
  face: "FACE",
  credential: "CRED",
  id_number: "ID",
  api_key: "KEY",
  pii_text: "PII",
};

// ─── Tokenizer Class ────────────────────────────────────────────────────────

export class PIITokenizer {
  private vault: TokenVault = new Map();
  private counters: Record<string, number> = {};

  /** True when a vault value is a letter-run we must word-bound — Latin, or any
   * script (Devanagari etc.). Letter-run values get word-boundary guards so a
   * short value never clobbers a longer word in either script. */
  private isLetterRun(value: string): boolean {
    return /^[\p{L}\p{M} ]+$/u.test(value);
  }

  private wordBoundPattern(escaped: string): RegExp {
    return new RegExp(`(^|[^\p{L}\p{M}])${escaped}(?=$|[^\p{L}\p{M}])`, "gu");
  }

  /**
   * Generate a unique token for a value.
   * If the value was already tokenized, return the existing token.
   */
  tokenize(value: string, kind: DetectedPII["kind"]): string {
    // Check if already tokenized.
    const existing = this.findToken(value);
    if (existing) return existing.token;

    const prefix = TOKEN_PREFIXES[kind] ?? "PII";
    const count = (this.counters[prefix] ?? 0) + 1;
    this.counters[prefix] = count;
    const token = `<${prefix}_${count}>`;

    this.vault.set(token, {
      token,
      original: value,
      kind,
      createdAt: Date.now(),
    });

    return token;
  }

  /**
   * Resolve a token back to its original value.
   * Only called at the last possible moment before executing an action.
   */
  resolve(token: string): string | undefined {
    return this.vault.get(token)?.original;
  }

  /**
   * Check if a string contains any tokens.
   */
  containsTokens(text: string): boolean {
    return /<[A-Z]+_\d+>/.test(text);
  }

  /**
   * Replace all tokens in a string with their original values.
   * Used when the server returns a command that references tokenized data.
   */
  resolveAll(text: string): string {
    return text.replace(/<[A-Z]+_\d+>/g, (match) => {
      return this.resolve(match) ?? match;
    });
  }

  /**
   * Find the token for a value (reverse lookup).
   */
  findToken(value: string): TokenEntry | undefined {
    for (const entry of this.vault.values()) {
      if (entry.original === value) return entry;
    }
    return undefined;
  }

  /** Return all active vault entries (for audit and egress assertion). */
  getEntries(): TokenEntry[] {
    return Array.from(this.vault.values());
  }

  /**
   * Tokenize sensitive patterns directly in the user prompt (Task-Level Tokenization).
   * Ensures that user-typed passwords, credit cards, emails, Aadhaar, and credentials
   * are placed into the vault and converted to tokens before the prompt ever reaches the LLM.
   */
  tokenizePrompt(prompt: string): { sanitized: string; tokenCount: number } {
    let text = prompt;
    let count = 0;

    // Credit cards (13-19 digits with separators)
    text = text.replace(/\b(?:\d[ -]*?){13,19}\b/g, (match) => {
      count++;
      return this.tokenize(match.trim(), "credential");
    });

    // Aadhaar numbers (12 digits in 4-4-4 format)
    text = text.replace(/\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, (match) => {
      count++;
      return this.tokenize(match.trim(), "id_number");
    });

    // PAN cards (5 letters + 4 digits + 1 letter)
    text = text.replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, (match) => {
      count++;
      return this.tokenize(match, "id_number");
    });

    // Emails
    text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (match) => {
      count++;
      return this.tokenize(match, "credential");
    });

    // Explicit credential / key / password assignments (quoted or unquoted token)
    text = text.replace(/(?:password|pwd|secret|key|token)[:=]\s*(?:["']([^"']+)["']|(\S+))/gi, (full, qVal, uVal) => {
      const val = qVal ?? uVal;
      if (!val) return full;
      count++;
      const tok = this.tokenize(val, "credential");
      return full.replace(val, tok);
    });

    return { sanitized: text, tokenCount: count };
  }

  /**
   * Tokenize values that the detectors actually flagged.
   *
   * Detection and tokenization were previously disconnected: the detectors
   * found names/emails/phones in fields and ID numbers in text, but the
   * tokenizer only knew about password-role inputs and its own hardcoded ID
   * patterns. As a result the vault stayed empty and the audit had no tokens
   * to show even when PII was found.
   *
   * This closes that gap: every detection with a value gets that value
   * replaced by a vault token (in its element and/or in the page text).
   */
  tokenizeDetections(
    snapshot: {
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
    },
    detections: Array<{
      kind: string;
      value?: string;
      elementSelector?: string;
    }>,
  ): {
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
    tokenCount: number;
  } {
    const TOKEN_RE = /^<[A-Z]+_\d+>$/;
    const elements = snapshot.elements.map((el) => ({ ...el }));
    let text = snapshot.text;
    let tokenCount = 0;
    const elementsById = new Map(elements.map((el) => [el.id, el]));

    for (const det of detections) {
      if (!det.value || det.kind === "face") continue;
      const val = det.value;
      if (TOKEN_RE.test(val)) continue;

      // Map any detector kind onto a token kind the vault understands.
      const tokenKind = (det.kind === "pii_text" || det.kind === "person" || det.kind === "organization"
        ? "pii_text"
        : det.kind === "id_number" || det.kind === "api_key" || det.kind === "credential"
          ? det.kind
          : "credential") as DetectedPII["kind"];

      const token = this.tokenize(val, tokenKind);
      let replacedAny = false;

      // 1) Element path: replace the value on the element the detector flagged.
      const selMatch = det.elementSelector?.match(/data-pry-id="(\d+)"/);
      if (selMatch) {
        const el = elementsById.get(parseInt(selMatch[1], 10));
        if (el && el.value && el.value.includes(val) && !TOKEN_RE.test(el.value)) {
          el.value = el.value.split(val).join(token);
          replacedAny = true;
        }
      }

      // 2) Text path: replace remaining occurrences (guarded by length so we
      //    never mangle tiny substrings like "No" inside ordinary sentences,
      //    and word-bounded so "Singh" never corrupts "Singhania" — in any
      //    script, so "राम" doesn't corrupt a longer Devanagari word).
      if (val.length >= 4 && text.includes(val)) {
        const escaped = val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const isAlpha = this.isLetterRun(val);
        const bounded = isAlpha
          ? this.wordBoundPattern(escaped)
          : new RegExp(escaped, "g");
        const next = text.replace(bounded, (match, lead) => `${lead ?? ""}${token}`);
        if (next !== text) {
          text = next;
          replacedAny = true;
        }
      }

      if (replacedAny) tokenCount++;
    }

    return { ...snapshot, elements, text, tokenCount };
  }

  /**
   * Tokenize PII found in the user's task description.
   * This ensures the LLM sees the same tokens in the task as on screen,
   * so it can match "Sharma Traders" in the task to <ORG_3> on screen.
   */
  tokenizeTask(task: string): { task: string; tokenCount: number } {
    // 1. First run high-precision prompt tokenization for credentials, IDs, cards, emails
    const promptRes = this.tokenizePrompt(task);
    let result = promptRes.sanitized;
    let tokenCount = promptRes.tokenCount;

    // 2. Tokenize names that appear after common contextual patterns
    // "from Sharma Traders" → "from <PII_3>"
    // "to John Doe" → "to <PII_1>"
    // `[\p{L}][\p{L}\p{M}]+` matches name-like letter runs in ANY script, so
    // Devanagari/other Indian-script names are tokenized instead of riding raw.
    // The end guard is a negative lookahead, not \b: \b is ASCII-\w-based, so
    // it never fires after a non-Latin letter run.
    const namePatterns = [
      { pattern: /\b(from|to|sender|recipient|addressed to|sent by)\s+([\p{L}][\p{L}\p{M}]+(?:\s+[\p{L}][\p{L}\p{M}]+)+)(?![\p{L}\p{M}])/gu, kind: "pii_text" as const },
      { pattern: /\b(name|company|business|firm|organization|vendor|supplier|client)[:\s]+([\p{L}][\p{L}\p{M}]+(?:\s+[\p{L}][\p{L}\p{M}]+)+)(?![\p{L}\p{M}])/gu, kind: "pii_text" as const },
    ];

    for (const { pattern, kind } of namePatterns) {
      result = result.replace(pattern, (match, prefix, name) => {
        tokenCount++;
        const token = this.tokenize(name, kind);
        return `${prefix} ${token}`;
      });
    }

    return { task: result, tokenCount };
  }

  /**
   * Replace any vault value that appears in `text` back with its token.
   *
   * Called on action results BEFORE they reach the model or the transcript:
   * the executor resolves a token to the real value at execution time, and its
   * result detail echoes what was typed ("Typed shashank@gmail.com into …").
   * Without this re-tokenization the raw value would flow back into the LLM
   * context on the next turn — silently undoing the entire privacy pipeline.
   */
  redactValues(text: string): string {
    let out = String(text);
    const entries = Array.from(this.vault.values())
      .filter((e) => e.original.length >= 4)
      // Longest first so a value never partially clobbers a longer one.
      .sort((a, b) => b.original.length - a.original.length);
    for (const entry of entries) {
      const val = entry.original;
      if (out.includes(val)) {
        const escaped = val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const isAlpha = this.isLetterRun(val);
        const pattern = isAlpha
          ? this.wordBoundPattern(escaped)
          : new RegExp(escaped, "g");
        out = out.replace(pattern, (match, lead) => `${lead ?? ""}${entry.token}`);
        continue;
      }

      // The page often reformats a typed value (Aadhaar "4111 1111 1111" →
      // "4111-1111-1111", a card with spaces, a phone re-grouped). The exact
      // string no longer matches, so the raw secret would ride back into the
      // model context + stored transcript. For digit-bearing values, fall back
      // to a digit-run match that tolerates the separators the page added: we
      // any non-digit between each digit and replace the whole run. Only
      // matches when the digit sequence is 6+ long (short values risk
      // clobbering unrelated numbers), and the run stays exact in its digits
      // so it can't swallow a longer neighbouring number.
      const digits = val.replace(/\D/g, "");
      if (digits.length >= 6) {
        const optionalSep = `[\\s\\-._/]?`;
        const digitPattern = new RegExp(
          `(?<![0-9])${digits.split("").map((c) => c + optionalSep).join("")}(?![0-9])`,
          "g",
        );
        const before = out;
        out = out.replace(digitPattern, entry.token);
        if (out !== before) continue;
        // If the bounded digit match still fails (page encoded it differently),
        // leave the raw value rather than risk over-clobbering other numbers.
      }
    }
    return out;
  }

  /**
   * Replace every vault value still present in a snapshot's element values,
   * names, or page text back with its token — even on elements no detector
   * flagged.
   *
   * Why this exists: after the agent types a resolved value into a field, the
   * re-perceived snapshot carries it in the input's `value`. Page-text
   * detectors often never see it (e.g. Gmail's compose dialog is outside the
   * `[role=main]` container pageText() reads), so the element value would ride
   * raw into the next planner turn. The vault knows every value ever
   * tokenized, so this sweep guarantees no snapshot that reaches the model
   * contains a raw vault value, regardless of what the detectors saw.
   */
  redactVaultValuesInSnapshot(snapshot: {
    elements: Array<{ id: number; role: string; name: string; value?: string; attrs?: Record<string, string> }>;
    text: string;
  }): {
    elements: Array<{ id: number; role: string; name: string; value?: string; attrs?: Record<string, string> }>;
    text: string;
  } {
    const entries = Array.from(this.vault.values())
      .filter((e) => e.original.length >= 4)
      .sort((a, b) => b.original.length - a.original.length);
    if (entries.length === 0) {
      return { elements: snapshot.elements, text: snapshot.text };
    }

    const replaceIn = (text: string): string => {
      let out = String(text);
      for (const entry of entries) {
        const val = entry.original;
        if (!out.includes(val)) continue;
        const escaped = val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const isAlpha = this.isLetterRun(val);
        const pattern = isAlpha
          ? this.wordBoundPattern(escaped)
          : new RegExp(escaped, "g");
        out = out.replace(pattern, (match, lead) => `${lead ?? ""}${entry.token}`);
      }
      return out;
    };

    const elements = snapshot.elements.map((el) => {
      let changed = false;
      const next = { ...el };
      if (next.value && this.vaultHasValue(next.value)) {
        const replaced = replaceIn(next.value);
        if (replaced !== next.value) {
          next.value = replaced;
          changed = true;
        }
      }
      if (next.name && this.vaultHasValue(next.name)) {
        const replaced = replaceIn(next.name);
        if (replaced !== next.name) {
          next.name = replaced;
          changed = true;
        }
      }
      return changed ? next : el;
    });

    const text = this.vaultHasValue(snapshot.text) ? replaceIn(snapshot.text) : snapshot.text;
    return { elements, text };
  }

  /** True when `text` contains any vault original value (cheap pre-check). */
  private vaultHasValue(text: string): boolean {
    if (!text) return false;
    for (const entry of this.vault.values()) {
      if (entry.original.length >= 4 && text.includes(entry.original)) return true;
    }
    return false;
  }

  /**
   * Get a summary of all tokenized values (for debugging/demo).
   * Does NOT expose the original values — just the token→kind mapping plus a
   * masked sample ("r•••@gmail.com") so the UI can show what was tokenized.
   */
  getTokenSummary(): Array<{ token: string; kind: string; sample?: string }> {
    return Array.from(this.vault.values()).map((entry) => ({
      token: entry.token,
      kind: entry.kind,
      sample: maskSample(entry.original),
    }));
  }

  /**
   * Clear the entire vault. Called when the task ends or the user resets.
   */
  clear(): void {
    this.vault.clear();
    this.counters = {};
  }

  /**
   * Number of tokens in the vault.
   */
  get size(): number {
    return this.vault.size;
  }
}

/**
 * Remove digit-concatenation corruption from tokens in tool-call input.
 *
 * Models occasionally glue digits onto unfamiliar token syntax in type/click
 * calls — "7<CRED_1>" instead of "<CRED_1>" — which would type the digit
 * into the field ("7shashank@gmail.com"). A digit directly touching a token
 * with no whitespace is never intentional; strip it so the resolved value is
 * exactly the vault value.
 *
 * Models also sometimes emit INVISIBLE characters (zero-width spaces,
 * BOM, joiners) between the digit and the token. Those defeat a strict
 * "digit immediately before <" match while the resolver still finds the
 * token, so the digit silently survives into the typed value (observed in
 * the field: Gmail received "7" + email). All zero-width/invisible
 * characters are therefore stripped from the string outright — they are
 * never intentional in typed text — before the digit repairs run.
 * Characters other than digits are left untouched.
 */
export function repairTokenConcatenation(text: string): string {
  return String(text)
    // Invisible separators break both the repair and any strict matching.
    .replace(/[\u200b\u200c\u200d\u2060\u2061-\u2064\ufeff]/g, "")
    // "7<CRED_1>" (digit BEFORE token, not preceded by a letter/number)
    .replace(/(?<![A-Za-z0-9])\d+<([A-Z]+_\d+)>/g, "<$1>")
    // "<CRED_1>7" (digit AFTER token, not followed by a letter/number)
    .replace(/<([A-Z]+_\d+)>\d+(?![A-Za-z0-9])/g, "<$1>");
}

/**
 * Shared singleton tokenizer instance.
 * Lives for the duration of one task run, then gets cleared.
 */
export const tokenizer = new PIITokenizer();

/**
 * Produces a display-safe sample of a tokenized value so the audit UI can show
 * WHAT was tokenized without ever exposing the raw value.
 *
 * Masking policy (audited against real PII shapes — no partial-value leaks):
 *
 *   "rahul@gmail.com"      → "ra•••@gmail.com"    (2 chars of local part max)
 *   "1234 5678 9012"       → "•••• •••• ••••"     (Aadhaar: zero real digits)
 *   "4111-1111-1111-1111"  → "••••-••••-••••-••••" (card: zero real digits)
 *   "+91 98765 43210"      → "+•• ••••• •••••"    (phone: zero real digits)
 *   "ABCDE1234F"           → "••••••••••"         (PAN: zero real alphanumerics)
 *   "Rahul Sharma"         → "Ra••••••••"         (name: first 2 chars only)
 *
 * The sample never contains a recoverable fragment: numeric values
 * (Aadhaar/card/phone/SSN) lose every digit, alphanumeric IDs (PAN/passport)
 * lose every character, and emails expose at most two characters of the
 * local part (never enough to identify the account, and nothing else).
 */
export function maskSample(value: string): string {
  const v = String(value).trim();
  if (v.length === 0) return "••";
  if (v.length <= 2) return "•".repeat(Math.max(2, v.length));

  // Emails keep their domain visible so the kind is obvious. Only the first
  // two characters of the local part stay real — never the full account name.
  const at = v.indexOf("@");
  if (at > 0 && v.includes(".") && v.length > at + 2) {
    const local = v.slice(0, at);
    const domain = v.slice(at + 1);
    return `${local.slice(0, 2)}•••@${domain}`;
  }

  const hasLetters = /[A-Za-z]/.test(v);
  const digitCount = (v.match(/\d/g) ?? []).length;
  const alnumCount = (v.match(/[A-Za-z0-9]/g) ?? []).length;

  // Alphanumeric identifiers (PAN `ABCDE1234F`, passports, API keys): mask
  // every letter AND digit — none of the characters are safe to reveal.
  if (hasLetters && digitCount > 0 && alnumCount >= 6 && !/\s/.test(v.trim())) {
    return maskAlnum(v);
  }

  // Numeric values (Aadhaar, card, SSN, phone, OTP): every digit is replaced
  // with a bullet. Separators (spaces/dashes/+) are kept so the shape — and
  // therefore the kind — stays recognisable without leaking a single digit.
  if (digitCount >= 4) {
    return maskDigits(v);
  }

  // Plain text (names, organisations): first two characters only.
  return `${v.slice(0, 2)}${"•".repeat(Math.min(10, Math.max(6, v.length - 2)))}`;
}

/** Replace every digit with a bullet, preserving separators and structure. */
function maskDigits(value: string): string {
  let out = "";
  for (const ch of value) {
    out += /\d/.test(ch) ? "•" : ch;
  }
  return out;
}

/** Replace every letter and digit with a bullet, preserving separators. */
function maskAlnum(value: string): string {
  let out = "";
  for (const ch of value) {
    out += /[A-Za-z0-9]/.test(ch) ? "•" : ch;
  }
  return out;
}
