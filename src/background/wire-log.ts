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
 * Persistence: MV3 suspends the service worker within ~30s of idle, which
 * used to wipe the in-memory array — the panel opened after a run showed an
 * empty log. Records now persist to chrome.storage.local (write-behind) and
 * reload lazily, so the audit survives the worker and the browser.
 */

import { matchPiiInText } from "../shared/text-pii-patterns";
import { maskSample } from "./tokenizer";
import { persistedSet } from "./storage-guard";

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

const STORAGE_KEY = "pry-wire-log";
const MAX_RECORDS = 24;

let records: WireRecord[] = [];
let sequence = 0;
let loaded = false;

/**
 * What one persisted message may hold. Full turn payloads (tens of KB of page
 * reads) live in memory for the run; only a bounded head is written to disk —
 * otherwise 24 full turns steadily eat the extension storage quota until a
 * write fails mid-run (`FILE_ERROR_NO_SPACE` reached a live transcript that
 * way). The truncation marker states the omitted count, so a trimmed record
 * never passes as a complete payload.
 */
const PERSISTED_MESSAGE_CHARS = 2000;

export function trimRecordForStorage(record: WireRecord): WireRecord {
  return {
    ...record,
    messages: record.messages.map((m) =>
      m.text.length > PERSISTED_MESSAGE_CHARS
        ? {
            ...m,
            text:
              m.text.slice(0, PERSISTED_MESSAGE_CHARS) +
              `\n[… ${m.text.length - PERSISTED_MESSAGE_CHARS} more characters not stored]`,
          }
        : m,
    ),
  };
}

async function persist(): Promise<void> {
  // Best-effort: on a storage failure the in-memory log (full text) still
  // serves this run, and the next load simply starts empty.
  await persistedSet({ [STORAGE_KEY]: records.map(trimRecordForStorage) });
}

/** Lazily reload persisted records (after a service-worker suspension). */
export async function loadWire(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const { [STORAGE_KEY]: stored } = await chrome.storage.local.get(STORAGE_KEY);
    if (Array.isArray(stored) && stored.length > 0) {
      records = stored.slice(-MAX_RECORDS);
      // Resume the sequence past the highest stored id (ids are w<n>).
      for (const r of records) {
        const n = Number(String(r.id ?? "").slice(1));
        if (Number.isFinite(n) && n > sequence) sequence = n;
      }
    }
  } catch {
    // Storage unavailable — start empty.
  }
}

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
  void persist();
  return record;
}

/** Awaits the lazy reload, then returns the persisted log. */
export async function wireRecords(): Promise<WireRecord[]> {
  await loadWire();
  return records;
}

export function clearWire(): void {
  records = [];
  sequence = 0;
  loaded = true;
  void chrome.storage.local.remove(STORAGE_KEY).catch(() => undefined);
}
