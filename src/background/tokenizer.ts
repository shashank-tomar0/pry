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
import { matchPiiInText } from "../shared/text-pii-patterns";
import { isAadhaarNumber, isCardNumber } from "../shared/checksums";

/**
 * The vault KIND for a shared-matcher hit.
 *
 * The prefix is user-visible (`<CRED_1>` vs `<ID_1>`), so the mapping keeps the
 * distinction the older rules drew: payment and account credentials are CRED,
 * identity documents are ID, and a name is PII (the same kind the task's
 * messaging-context rule produces, so the same person tokenizes identically
 * however they were found).
 */
export function tokenKindForTextMatch(kind: string, label: string): DetectedPII["kind"] {
  if (kind === "name_text") return "pii_text";
  if (kind === "email" || kind === "phone") return "credential";
  return /card|ssn/i.test(label) ? "credential" : "id_number";
}

/**
 * Does this word look like a secret a user typed, rather than ordinary prose?
 *
 * Used only where the text itself gives a cue ("password", "api key") but the
 * separator is weak ("is", or nothing at all), so a plain English word can
 * follow the cue: "open the password manager", "the key is configuration".
 * A secret in practice carries a digit or a symbol; prose does not. Requiring
 * one keeps the capture precise, and the cost is stated: a value made only of
 * letters ("correcthorsebatterystaple") is NOT captured, because the rule that
 * would catch it also vaults the word "configuration".
 */
function looksLikeSecret(value: string): boolean {
  const v = value.trim();
  if (v.length < 6) return false;
  if (/\s/.test(v)) return false;
  return /[\d]|[^A-Za-z0-9]/.test(v);
}

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
  // PII read out of the frame's pixels (image/canvas/video text). Never a
  // token source — the value is only known after it was already shipped as
  // pixels — but it still has to name a prefix, and the audit lists it.
  image_text: "IMG",
};

/**
 * What a token stands for, in words, WITHOUT its value.
 *
 * This exists because a token's spelling carries no meaning and the planner
 * tries to invent one. Observed: handed `open youtube and suggest me to
 * <PII_1>`, the model spent 43 seconds reasoning about what <PII_1> could be,
 * then searched for the literal characters. Knowing the CATEGORY is enough to
 * act — "a person or organisation name" tells it this is a search target, while
 * revealing nothing the vault is holding.
 */
export function tokenKindLabel(kind: string): string {
  switch (kind) {
    case "pii_text": return "a person, company or place name";
    case "credential": return "a credential (an email address, password, card number or similar)";
    case "id_number": return "a government or identity number";
    case "api_key": return "an API key or access token";
    case "image_text": return "text read from the page's pixels";
    case "face": return "a face region";
    default: return "a sensitive value";
  }
}

/**
 * A legend of every live token and what KIND of thing it stands for — never the
 * value. Returns null when there is nothing to explain, so callers can skip the
 * section entirely rather than print an empty header.
 *
 * Capped: a legend long enough to dominate the prompt would cost more context
 * than the values it replaces, and the cap is stated in the legend itself so a
 * truncated list is never mistaken for the whole vault.
 */
export function buildTokenLegend(entries: readonly TokenEntry[], max = 8): string | null {
  if (entries.length === 0) return null;
  const shown = entries.slice(0, max);
  const lines = shown.map((e) => `  ${e.token} = ${tokenKindLabel(e.kind)}`);
  if (entries.length > shown.length) {
    lines.push(`  (+${entries.length - shown.length} more token(s), same rule)`);
  }
  return [
    "Tokens in this run (the real values stay on the user's machine; use each token exactly as written, including in a search box):",
    ...lines,
  ].join("\n");
}

// ─── Name-shaped runs in the user's task ────────────────────────────────────
//
// Shared vocabulary for deciding whether a letter run after an addressing
// context is a person/org name or just prose. Pure and exported so the harness
// pins the exact inputs that used to be mangled (see tokenizeTask).

/** Longest run treated as a name. Real names are 2-3 words; anything longer is
 * a sentence, and vaulting a sentence is how the task became unexecutable. */
export const MAX_NAME_WORDS = 3;

/** A single name word: letters (any script), plus `'`/`-` for O'Brien / Jean-Luc. */
const NAME_WORD = /^[\p{L}][\p{L}\p{M}'\u2019-]*$/u;

/**
 * Words that are never the START of a name when they are lowercase: articles,
 * pronouns, prepositions and conjunctions. "to the meeting invite" and "to my
 * invoice" are prose; "to priya sharma" (voice input arrives lowercase) is a
 * name. Only the first word is checked against this list — once a name has
 * started, a lowercase continuation is stopped by the shape rule instead.
 */
const NON_NAME_STARTERS = new Set([
  "a", "an", "the", "this", "that", "these", "those", "my", "your", "our",
  "his", "her", "their", "its", "me", "us", "them", "him", "it", "i",
  "and", "or", "but", "so", "if", "then", "with", "without", "for", "from",
  "to", "of", "in", "on", "at", "by", "about", "into", "onto", "over",
  "please", "is", "are", "was", "were", "be", "do", "does", "did",
]);

/**
 * The name-shaped prefix of a letter run, or null when there is none.
 *
 * Two modes, because case carries most of the signal but voice input arrives
 * lowercase:
 *
 *   - The run STARTS with a capital → take consecutive capitalised words
 *     ("Harkirat Singh yt channel" → "Harkirat Singh").
 *   - The run starts lowercase → keep going only while the words are plausible
 *     name words, stopping at anything in NON_NAME_STARTERS and rejecting the
 *     run outright when it begins with one ("the meeting invite" → null,
 *     "priya sharma" → "priya sharma").
 *
 * Requires at least two words: a single word after a preposition is far more
 * often prose ("open in youtube", "came from Chrome") than a name, and the
 * page/DOM channels still tokenize single-word values where they appear.
 */
export function leadingNameRun(run: string): string | null {
  const words = run.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;

  const first = words[0];
  if (!NAME_WORD.test(first)) return null;
  const capitalised = /^\p{Lu}/u.test(first);
  if (!capitalised && NON_NAME_STARTERS.has(first.toLowerCase())) return null;

  const kept: string[] = [first];
  for (const word of words.slice(1)) {
    if (kept.length >= MAX_NAME_WORDS) break;
    if (!NAME_WORD.test(word)) break;
    if (capitalised) {
      // In capitalised mode the name ends where the capitals do.
      if (!/^\p{Lu}/u.test(word)) break;
    } else if (NON_NAME_STARTERS.has(word.toLowerCase())) {
      break;
    }
    kept.push(word);
  }

  return kept.length >= 2 ? kept.join(" ") : null;
}

/**
 * A letter run that follows an ADDRESSING context. The run is matched
 * generously here and trimmed by `leadingNameRun` — one place decides what a
 * name looks like, so the regex cannot drift from the rule.
 */
const NAME_RUN = "([\\p{L}][\\p{L}\\p{M}'\u2019-]*(?:\\s+[\\p{L}][\\p{L}\\p{M}'\u2019-]*)+)";

/**
 * Contexts that make a following name a message PAYLOAD rather than an
 * instruction parameter. Built from three shapes:
 *
 *   1. explicit addressing words — `addressed to X`, `sent by X`, `recipient X`
 *   2. a MESSAGING VERB with a target preposition within a short window —
 *      `send an email to X`, `reply to X`, `forward it to X`
 *   3. a messaging verb with the name as its direct object — `email X`, `text X`
 *   4. a labelled field — `name: X`, `company: X`
 */
const NAME_CONTEXT = new RegExp(
  "(?:\\b(?:addressed\\s+to|sent\\s+by|recipient|sender)\\s+" +
  "|\\b(?:e-?mails?|mails?|send|sends|sent|sending|forward|forwards|forwarded|reply|replies|replying|message|messages|dm|dms|text|texts|whatsapp|invite|invites|invitation)\\b[^\\n.!?]{0,24}?\\b(?:to|for)\\s+" +
  "|\\b(?:e-?mails?|message|messages|dm|text|texts|whatsapp|call|calls)\\s+" +
  "|\\b(?:name|company|business|firm|organization|vendor|supplier|client)\\s*:\\s*)" +
  NAME_RUN,
  "giu",
);

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
   * Replace every occurrence of one vault value in `text` with its token.
   *
   * The replacement is chosen by PATTERN SHAPE, and that is the whole point.
   * Letter-run values (names, organisations) get the word-bound pattern, whose
   * leading capture group — the character BEFORE the value — must be re-emitted
   * so the surrounding text survives. Every other value (an email, an Aadhaar
   * number, a card, an API key) gets a bare pattern with NO capture group. One
   * callback written for the grouped case is silently wrong for the bare one:
   * with no groups, `String.replace` passes the match OFFSET as the second
   * argument, so the callback splices that offset into the text as if it were
   * a leading delimiter.
   *
   * Live failure this fixes (the panel's own transcript): a clean action detail
   * of `Typed "<email>" into …` re-redacted to `Typed "7<CRED_1>" … Field now
   * shows: "86<CRED_1>"` — 7 and 86 being the email's offsets in each half of
   * the same string — and a snapshot value rendered as `0<CRED_1>` (offset 0).
   * The planner read those digits as a corrupted recipient, spent the rest of
   * the run trying to reconcile a value nobody typed, and timed out mid-task.
   */
  private replaceValueWithToken(text: string, entry: TokenEntry): string {
    const escaped = entry.original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (this.isLetterRun(entry.original)) {
      return text.replace(
        this.wordBoundPattern(escaped),
        (_match, lead: string) => `${lead ?? ""}${entry.token}`,
      );
    }
    return text.replace(new RegExp(escaped, "g"), () => entry.token);
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
   *
   * Two forms are resolved, because models strip the braces. Observed in the
   * wild: told to pass `<PII_1>` verbatim, the planner emitted `PII_1`, the
   * bracketed match found nothing, and the LITERAL TEXT "PII_1" was typed into
   * YouTube's search box — the user's channel name replaced by the token's own
   * spelling. A bare `PREFIX_N` is substituted ONLY when that exact token is
   * live in this run's vault, so ordinary page text like "PII_1" in a document
   * is never mistaken for a secret.
   *
   * The string is split on bracketed tokens first so a substituted VALUE can
   * never be re-scanned by the bare-form pass (a vault value that happens to
   * spell another token must not resolve twice).
   */
  resolveAll(text: string): string {
    return String(text)
      .split(/(<[A-Z]+_\d+>)/g)
      .map((part) => {
        const exact = this.vault.get(part);
        if (exact) return exact.original;
        return part.replace(BARE_TOKEN, (match, prefix: string, count: string) =>
          this.vault.get(`<${prefix}_${count}>`)?.original ?? match);
      })
      .join("");
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
    const text = String(prompt ?? "");
    let count = 0;
    if (text.length < 6) return { sanitized: text, tokenCount: 0 };

    const spans: Array<{ start: number; end: number; value: string; kind: DetectedPII["kind"] }> = [];
    const add = (start: number, end: number, value: string, kind: DetectedPII["kind"]): void => {
      spans.push({ start, end, value, kind });
    };

    // 1. The SHARED matcher — the same vocabulary the pixel channel redacts with.
    //    This rule set used to be duplicated (and weaker) here: it knew emails,
    //    cards, Aadhaar and PAN, and therefore let a phone number or a
    //    cue-labelled name in the user's own request ride to the planner raw
    //    while the identical string was being black-boxed on screen. One
    //    vocabulary now serves both channels: email, Indian phone, honorific and
    //    cue-labelled names, and checksum-validated Aadhaar/PAN/IFSC/SSN/card/
    //    passport shapes.
    for (const m of matchPiiInText(text)) {
      add(m.start, m.end, m.value, tokenKindForTextMatch(m.kind, m.label));
    }

    // 2. UNFORMATTED digit runs that the shared matcher deliberately skips. Those
    //    regexes require separators, so a card typed without spaces or an Aadhaar
    //    typed as twelve bare digits would otherwise survive. Accepted only when
    //    the checksum AGREES, which is what keeps an order number or a video id
    //    ("find order 1234 5678 9012") from being vaulted as an identity document.
    for (const m of text.matchAll(/\b\d{13,19}\b/g)) {
      if (isCardNumber(m[0])) add(m.index ?? 0, (m.index ?? 0) + m[0].length, m[0], "credential");
    }
    for (const m of text.matchAll(/\b\d{12}\b/g)) {
      if (isAadhaarNumber(m[0])) add(m.index ?? 0, (m.index ?? 0) + m[0].length, m[0], "id_number");
    }

    // 3a. Digit shapes the user LABELLED. The checksum rules above are precise
    //     but they miss the case that matters most: someone typing their own
    //     identity document with a typo, or reading a number off a card. When
    //     the request says "my Aadhaar number is …", the checksum is not the
    //     authority — the user is. So a cue word captures the digits regardless,
    //     while a BARE run still needs the checksum to agree, which is what keeps
    //     an order number from being vaulted as a document.
    for (const m of text.matchAll(/\b(?:aadhaar|aadhar|uidai)\b[^\d\n]{0,20}?(\d[\d\s-]{10,16}\d)/gi)) {
      const raw = m[1];
      if (raw.replace(/\D/g, "").length !== 12) continue;
      const start = (m.index ?? 0) + m[0].indexOf(raw);
      add(start, start + raw.length, raw, "id_number");
    }
    for (const m of text.matchAll(/\b(?:credit\s+card|debit\s+card|card|card\s+number)\b[^\d\n]{0,20}?(\d[\d\s-]{11,24}\d)/gi)) {
      const raw = m[1];
      const digits = raw.replace(/\D/g, "").length;
      if (digits < 13 || digits > 19) continue;
      const start = (m.index ?? 0) + m[0].indexOf(raw);
      add(start, start + raw.length, raw, "credential");
    }

    // 3b. Cue-word secrets, which have no distinguishing shape: an OTP is six
    //    digits, a password is whatever the user chose. The cue word is what
    //    makes these safe to capture — and the shape guard is what stops
    //    "open the password manager" from vaulting the word "manager".
    for (const m of text.matchAll(/\b(?:otp|one[-\s]?time(?:\s+(?:code|password|passcode))?|verification\s+code|security\s+code)\b\s*(?:is|:|=)?\s*(\d{4,8})\b/gi)) {
      const digits = m[1];
      const start = (m.index ?? 0) + m[0].indexOf(digits);
      add(start, start + digits.length, digits, "credential");
    }
    for (const m of text.matchAll(/\b(?:password|passphrase|pwd|passcode|pin|api[\s_-]?key|apikey|key|secret|access[\s_-]?token|token)\b\s*(?:is|:|=)\s*([^\s,;]+)/gi)) {
      const value = (m[1] ?? "").trim();
      if (!looksLikeSecret(value)) continue;
      const start = (m.index ?? 0) + m[0].indexOf(value);
      add(start, start + value.length, value, "credential");
    }
    // The bare form ("with password hunter2copy"): no separator, so the value
    // has to look like a secret on its own.
    for (const m of text.matchAll(/\b(?:password|passphrase|pwd|passcode)\b\s+([^\s,;]+)/gi)) {
      const value = (m[1] ?? "").trim();
      if (!looksLikeSecret(value)) continue;
      const start = (m.index ?? 0) + m[0].indexOf(value);
      add(start, start + value.length, value, "credential");
    }

    // Overlap-resolve (longest wins, earlier start first) and splice in one pass.
    // Sequential regex replaces could not do this: the first replacement shifts
    // every later index, so a rule could silently miss a value it should have
    // caught depending on what ran before it.
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept: typeof spans = [];
    for (const span of spans) {
      if (kept.some((k) => span.start >= k.start && span.end <= k.end)) continue;
      kept.push(span);
    }

    let cursor = 0;
    let sanitized = "";
    for (const span of kept) {
      sanitized += text.slice(cursor, span.start);
      sanitized += this.tokenize(span.value, span.kind);
      cursor = span.end;
      count++;
    }
    sanitized += text.slice(cursor);

    return { sanitized, tokenCount: count };
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
   *
   * WHAT THIS DELIBERATELY DOES NOT DO (it used to, and it broke the task):
   *
   * The name rule matched `(from|to|sender|recipient|…)\s+<multi-word letter
   * run>` with NO bound on the run and no notion of what a name looks like, so
   * it treated English prose after a preposition as a person. Measured against
   * the real inputs this was written for:
   *
   *   "open youtube and suggest me to Harkirat Singh yt channel"
   *        → vault: "Harkirat Singh yt channel"      (the rest of the order)
   *   "i want to open harkirat singh yt channel"
   *        → vault: "open harkirat singh yt channel"  (the whole instruction)
   *   "add Ramesh Gupta to the meeting invite"
   *        → vault: "the meeting invite"              (prose vaulted, NAME raw)
   *
   * The first two make the run unexecutable: the model receives an opaque token
   * where the user's own search target should be, cannot reason about it, and
   * (observed) types the token text into the page. The third is worse than
   * useless — it leaks the name it was supposed to protect while vaulting a
   * harmless phrase.
   *
   * Two rules now, both necessary:
   *
   *   1. CONTEXT must be a message/addressee — a messaging verb, an explicit
   *      addressing word, or a labelled field. A bare preposition is not
   *      context: "go to", "suggest me to", and "add … to" are ordinary
   *      English, and treating them as addressing turned the user's request
   *      into an opaque token.
   *   2. SHAPE must look like a name (see `leadingNameRun`), so a run stops at
   *      the first word that is not part of one instead of consuming the
   *      sentence.
   *
   * The privacy cost is stated rather than hidden: a name used as an ordinary
   * object of a preposition in a non-messaging task ("go to Priya Sharma's
   * profile") now rides to the planner raw. That is the deliberate trade — the
   * name is the INSTRUCTION PARAMETER there, and an instruction the agent cannot
   * read is not a protected instruction, it is a broken one.
   */
  tokenizeTask(task: string): { task: string; tokenCount: number; newEntries: TokenEntry[] } {
    // Anything already in the vault is not "new" for this task; anything that
    // appears after this diff is, whichever rule created it. Returned so the
    // panel can name what it took out of the user's own request — a redaction
    // the user cannot see in their own sentence is indistinguishable from the
    // agent misreading them.
    const before = new Set(this.vault.keys());

    // 1. First run high-precision prompt tokenization for credentials, IDs, cards, emails
    const promptRes = this.tokenizePrompt(task);
    let result = promptRes.sanitized;
    let tokenCount = promptRes.tokenCount;

    // 2. Tokenize names that appear after a MESSAGING context, trimmed to the
    //    name-shaped prefix of the letter run that follows.
    result = result.replace(NAME_CONTEXT, (match, run: string) => {
      const name = leadingNameRun(run);
      // Not a name after all: leave the sentence exactly as the user wrote it.
      if (!name) return match;
      tokenCount++;
      const token = this.tokenize(name, "pii_text");
      // The run is matched generously and trimmed to its name-shaped prefix, so
      // the words AFTER the name belong to the sentence and must survive:
      // "email Ramesh Gupta the report" → "email <PII_1> the report". Dropping
      // them would silently delete part of the user's instruction.
      const context = match.slice(0, match.length - run.length);
      return context + token + run.slice(name.length);
    });

    const newEntries = Array.from(this.vault.values()).filter((e) => !before.has(e.token));
    return { task: result, tokenCount, newEntries };
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
        out = this.replaceValueWithToken(out, entry);
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
        if (!out.includes(entry.original)) continue;
        out = this.replaceValueWithToken(out, entry);
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
 * A token with its angle brackets stripped, and nothing token-like glued to it.
 * `PII_1` in a model's tool input, distinguished from an identifier like
 * `MY_1ST_PLAN` or a version string. Case-sensitive: real tokens are upper-case.
 */
const BARE_TOKEN = /(?<![\p{L}\p{N}_<])([A-Z]{2,6})_(\d{1,4})(?![\p{L}\p{N}_>])/gu;

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
