/**
 * A record of everything that has left this browser to an LLM.
 *
 * Two reasons this exists rather than a console.log:
 *
 * First, it is the only honest way to answer "what did the model actually
 * see?". Every other view in this extension shows an intermediate — findings,
 * the vault, the audit. This shows the payload.
 *
 * Second, the detector re-runs over the outgoing payload at the moment of
 * sending. The tests assert nothing leaks on fixtures; this asserts it on
 * whatever page the user is really on, every turn, and says so loudly when
 * something survives. A privacy claim that is only checked in CI is a claim
 * about CI.
 *
 * The log holds sanitized payloads by definition — they are what was sent —
 * so it is safe to display. Nothing here ever sees a raw capture.
 *
 * Kept in memory on purpose: screenshots would dominate a storage-backed log,
 * and a log that grows without limit in a service worker is a memory leak
 * with a nice name.
 */

import { matchPiiInText } from "../shared/text-pii-patterns";
import { maskSample } from "./tokenizer";

export interface WireMessage {
  role: string;
  text: string;
}

export interface WireLeak {
  label: string;
  /** Masked sample — never the raw value. */
  sample: string;
}

export interface WireRecord {
  id: string;
  turn: number;
  at: number;
  /** Which provider and model received this. */
  destination: string;
  /** Characters of system prompt. Constant, so only its size is interesting. */
  systemChars: number;
  /** Every message, rendered exactly as it was sent. */
  messages: WireMessage[];
  /** Tokens present in the outgoing text, deduplicated and sorted. */
  tokens: string[];
  /**
   * Re-running detection over the outgoing payload. Anything here is PII that
   * reached the wire. It should always be empty.
   */
  leaked: WireLeak[];
  /** Total characters sent, for cost intuition. */
  totalChars: number;
}

const MAX_RECORDS = 24;

let records: WireRecord[] = [];
let sequence = 0;

/** Every vault token in a string, deduplicated and sorted. */
export function tokensIn(text: string): string[] {
  return [...new Set(text.match(/<[A-Z][A-Z0-9]*_\d+>/g) ?? [])].sort();
}

/**
 * Re-run the pixel/text-channel matchers over an outgoing payload. Anything
 * found is PII that reached the wire despite the pipeline. Values are masked
 * immediately so the log itself never holds a raw secret.
 */
export function scanForLeaks(payload: string): WireLeak[] {
  if (!payload) return [];
  // Token syntax must never count as a leak: <CRED_1> is the sanitized form.
  const withoutTokens = payload.replace(/<[A-Z][A-Z0-9]*_\d+>/g, " ");
  return matchPiiInText(withoutTokens).map((m) => ({
    label: m.label,
    sample: maskSample(m.value),
  }));
}

export function recordWire(entry: Omit<WireRecord, "id" | "at">): WireRecord {
  const record: WireRecord = { ...entry, id: `w${++sequence}`, at: Date.now() };
  records.push(record);
  if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
  return record;
}

export function wireRecords(): WireRecord[] {
  return records;
}

export function clearWire(): void {
  records = [];
  sequence = 0;
}
