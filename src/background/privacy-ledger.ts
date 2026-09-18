/**
 * Privacy Budget Ledger
 *
 * Creates an immutable, cryptographically hashed audit trail of every
 * privacy-relevant action the agent takes. Each entry is SHA-256 hashed
 * and chained to the previous entry, making tampering detectable.
 *
 * Entries are persisted to chrome.storage.local so the ledger survives
 * service worker restarts and can be queried from the dashboard.
 *
 * Storage key: "pry-privacy-ledger"
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LedgerEntry {
  /** Sequential entry number. */
  seq: number;
  /** Timestamp. */
  timestamp: number;
  /** Type of event. */
  type: "snapshot" | "detection" | "tokenize" | "redact" | "resolve" | "action" | "verification";
  /** Event-specific data. */
  data: Record<string, unknown>;
  /** SHA-256 hash of this entry's content. */
  hash: string;
  /** Hash of the previous entry (chain). */
  prevHash: string;
}

export interface PrivacyLedger {
  /** Session ID. */
  sessionId: string;
  /** All entries in order. */
  entries: LedgerEntry[];
  /** Summary statistics. */
  summary: {
    totalSnapshots: number;
    totalDetections: number;
    totalTokensCreated: number;
    totalRedactions: number;
    totalActions: number;
    verificationPassed: boolean;
    /** Whether the chain is valid (every digest and every retained link). */
    chainValid: boolean;
    /** Whether every retained entry still hashes to its recorded digest. */
    chainHashesIntact: boolean;
    /**
     * True when older entries were trimmed, so the first kept entry's link to
     * its predecessor cannot be checked. Distinct from `chainValid`: an
     * unverifiable link is not evidence of tampering, and reporting it as
     * either INTACT or TAMPERED would be a claim we cannot back.
     */
    chainHeadUnverifiable: boolean;
    /** Entries written by the CURRENT session, out of `entries.length`. */
    sessionEntries: number;
  };
}

/**
 * Result of re-deriving the ledger's integrity from the stored bytes.
 *
 * `valid` means every retained entry hashes to its recorded digest AND every
 * retained link matches. The head link is reported separately because a trimmed
 * log genuinely cannot answer it — conflating "cannot check" with "tampered"
 * would make the badge cry wolf, and conflating it with "intact" would be the
 * vacuous check this replaces.
 */
export interface ChainVerification {
  hashesIntact: boolean;
  linksIntact: boolean;
  valid: boolean;
  entries: number;
  /** `seq` of the first entry whose digest did not match, when one did not. */
  firstBadSeq?: number;
  /** True when entries were trimmed, so the head's link is unverifiable. */
  headLinkUnverifiable: boolean;
  /** True when the retained head is not the first entry ever written. */
  trimmed: boolean;
  reasons: string[];
}

// ─── Storage ────────────────────────────────────────────────────────────────

const STORAGE_KEY = "pry-privacy-ledger";
const MAX_ENTRIES = 500;

interface LedgerStore {
  entries: LedgerEntry[];
  entryCounter: number;
  lastHash: string;
  /**
   * Session boundary, written by `initLedger()` at the start of each run.
   * Optional because stores written before this existed have no boundary, and
   * an upgrade must not make an existing ledger unreadable.
   */
  sessionId?: string;
  sessionStartedAt?: number;
  /** `seq` the current session started at (its first entry's seq). */
  sessionStartSeq?: number;
}

/**
 * Ledger writes are read-modify-write cycles over one storage key. The agent
 * fires many of them concurrently (one per snapshot, detection, redaction,
 * action, verification), and without serialization each write reads the same
 * store state and overwrites the others — entries silently vanish. Every write
 * chains through this queue so cycles never interleave.
 */
let writeQueue: Promise<unknown> = Promise.resolve();
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(op, op);
  // Keep the chain alive regardless of individual failures.
  writeQueue = next.catch(() => undefined);
  return next;
}

async function loadStore(): Promise<LedgerStore> {
  const { [STORAGE_KEY]: store } = await chrome.storage.local.get(STORAGE_KEY);
  if (store && Array.isArray(store.entries)) {
    return store as LedgerStore;
  }
  return { entries: [], entryCounter: 0, lastHash: "0".repeat(64) };
}

async function saveStore(store: LedgerStore): Promise<void> {
  // Trim to max entries.
  if (store.entries.length > MAX_ENTRIES) {
    store.entries = store.entries.slice(store.entries.length - MAX_ENTRIES);
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}

// ─── SHA-256 Helper ─────────────────────────────────────────────────────────

async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Ledger Implementation ──────────────────────────────────────────────────

/**
 * The exact bytes a `LedgerEntry.hash` is a digest of.
 *
 * One function, used by both the writer and the verifier, because the digest is
 * over a JSON string and JSON preserves key ORDER: if the two ever assembled
 * this object separately, every entry would fail verification for a reason that
 * has nothing to do with tampering.
 */
function hashContent(entry: Pick<LedgerEntry, "seq" | "timestamp" | "type" | "data" | "prevHash">): string {
  return JSON.stringify({
    seq: entry.seq,
    timestamp: entry.timestamp,
    type: entry.type,
    data: entry.data,
    prevHash: entry.prevHash,
  });
}

/**
 * Initialize the ledger for a new session.
 *
 * Entry history is APPENDED, not cleared: the ledger is meant to grow across
 * sessions. What this writes is the boundary of the new session, because
 * `sessionId` used to be derived from the FIRST ENTRY EVER WRITTEN — so it never
 * changed, one "session" covered the lifetime of the install, and a per-session
 * audit proof could not be produced from it at all.
 */
export async function initLedger(): Promise<void> {
  const sessionId = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await enqueue(async () => {
    const store = await loadStore();
    store.sessionId = sessionId;
    store.sessionStartedAt = Date.now();
    store.sessionStartSeq = store.entryCounter + 1;
    await saveStore(store);
  });
}

/**
 * Add an entry to the ledger and persist to storage.
 */
export async function addEntry(
  type: LedgerEntry["type"],
  data: Record<string, unknown>,
): Promise<LedgerEntry> {
  // Serialize the read-modify-write cycle against every other ledger write.
  return enqueue(async () => {
    const store = await loadStore();
    const seq = store.entryCounter + 1;
    const timestamp = Date.now();

    // Build the content to hash (excluding hash fields).
    const hash = await sha256(hashContent({ seq, timestamp, type, data, prevHash: store.lastHash }));

    const entry: LedgerEntry = {
      seq,
      timestamp,
      type,
      data,
      hash,
      prevHash: store.lastHash,
    };

    store.lastHash = hash;
    store.entryCounter = seq;
    store.entries.push(entry);

    await saveStore(store);

    return entry;
  });
}

/**
 * Record a page snapshot capture.
 */
export async function recordSnapshot(url: string, title: string, elementCount: number): Promise<LedgerEntry> {
  return addEntry("snapshot", { url, title, elementCount });
}

/**
 * Record PII detections.
 */
export async function recordDetections(
  detections: Array<{ kind: string; method: string; confidence: number; label: string }>,
): Promise<LedgerEntry> {
  return addEntry("detection", {
    count: detections.length,
    kinds: [...new Set(detections.map((d) => d.kind))],
    methods: [...new Set(detections.map((d) => d.method))],
  });
}

/**
 * Record token creation.
 */
export async function recordTokenization(tokens: Array<{ token: string; kind: string }>): Promise<LedgerEntry> {
  // Never store the original values - only the token→kind mapping.
  return addEntry("tokenize", {
    count: tokens.length,
    tokenTypes: [...new Set(tokens.map((t) => t.kind))],
  });
}

/**
 * Record a redaction event.
 */
export async function recordRedaction(redactedCount: number, method: string): Promise<LedgerEntry> {
  return addEntry("redact", { redactedCount, method });
}

/**
 * Record an action execution.
 */
export async function recordAction(tool: string, success: boolean, elementId?: number): Promise<LedgerEntry> {
  return addEntry("action", { tool, success, elementId });
}

/**
 * Record re-OCR verification result.
 */
export async function recordVerification(passed: boolean, regionsChecked: number, leakedCount: number): Promise<LedgerEntry> {
  return addEntry("verification", { passed, regionsChecked, leakedCount });
}

/**
 * Re-derive the ledger's integrity from the stored bytes.
 *
 * Every retained entry is re-hashed, INCLUDING the first one. The previous
 * check seeded its expected previous-hash from the stored head (`prevHash =
 * entries[0].prevHash`), so the comparison for entry 0 was tautological and a
 * tampered head was structurally invisible — and `getLedgerSummary`, the
 * function behind the panel's "CHAIN INTACT" badge, re-hashed nothing at all
 * and only walked links. A badge that asserts more than it computed is worse
 * than no badge.
 */
export async function verifyLedgerChain(entries: LedgerEntry[]): Promise<ChainVerification> {
  const reasons: string[] = [];
  let hashesIntact = true;
  let linksIntact = true;
  let firstBadSeq: number | undefined;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const expected = await sha256(hashContent(entry));
    if (expected !== entry.hash) {
      hashesIntact = false;
      if (firstBadSeq === undefined) firstBadSeq = entry.seq;
      // Do NOT push a reason per entry: one tampered entry is one finding.
      // The entry's TYPE is named because it is the only handle an operator has
      // on which write went wrong — "entry 1512" alone sent the reader looking at
      // a ledger of 500 without saying whether it was a snapshot, a redaction or
      // a verification, and those are three different code paths.
      if (reasons.length === 0) {
        reasons.push(`entry ${entry.seq} (${entry.type}) does not match its recorded digest`);
      }
    }
    if (i > 0 && entry.prevHash !== entries[i - 1].hash) {
      linksIntact = false;
      if (reasons.length === 0) {
        reasons.push(`entry ${entry.seq} does not link to entry ${entries[i - 1].seq}`);
      }
    }
  }

  const trimmed = entries.length > 0 && entries[0].seq > 1;
  if (trimmed && reasons.length === 0) {
    reasons.push(`head link unverifiable: ${entries[0].seq - 1} earlier entr(ies) were trimmed`);
  }

  return {
    hashesIntact,
    linksIntact,
    valid: hashesIntact && linksIntact,
    entries: entries.length,
    firstBadSeq,
    headLinkUnverifiable: trimmed,
    trimmed,
    reasons,
  };
}

/** Counts by entry type, shared by both readers. */
function tally(entries: LedgerEntry[]): {
  totalSnapshots: number;
  totalDetections: number;
  totalTokensCreated: number;
  totalRedactions: number;
  totalActions: number;
  verificationPassed: boolean;
} {
  const totals = {
    totalSnapshots: 0,
    totalDetections: 0,
    totalTokensCreated: 0,
    totalRedactions: 0,
    totalActions: 0,
    verificationPassed: true,
  };
  for (const entry of entries) {
    switch (entry.type) {
      case "snapshot": totals.totalSnapshots++; break;
      case "detection": totals.totalDetections += (entry.data.count as number) ?? 0; break;
      case "tokenize": totals.totalTokensCreated += (entry.data.count as number) ?? 0; break;
      case "redact": totals.totalRedactions += (entry.data.redactedCount as number) ?? 0; break;
      case "action": totals.totalActions++; break;
      case "verification":
        if (!entry.data.passed) totals.verificationPassed = false;
        break;
    }
  }
  return totals;
}

/** Entries written by the current session, given the stored boundary. */
function sessionEntries(store: LedgerStore): number {
  const boundary = store.sessionStartSeq;
  if (typeof boundary !== "number" || !Number.isFinite(boundary)) return 0;
  return store.entries.filter((e) => e.seq >= boundary).length;
}

/**
 * Get the complete ledger with chain integrity verification.
 */
export async function getLedger(): Promise<PrivacyLedger> {
  const store = await loadStore();
  const chain = await verifyLedgerChain(store.entries);

  return {
    sessionId: store.sessionId ?? `session-${store.entries[0]?.timestamp ?? Date.now()}`,
    entries: store.entries,
    summary: {
      ...tally(store.entries),
      chainValid: chain.valid,
      chainHashesIntact: chain.hashesIntact,
      chainHeadUnverifiable: chain.headLinkUnverifiable,
      sessionEntries: sessionEntries(store),
    },
  };
}

/**
 * Get just the summary. Unlike the previous version this DOES verify the
 * chain, because the panel renders its result as an integrity badge.
 */
export async function getLedgerSummary(): Promise<{
  totalEntries: number;
  chainValid: boolean;
  /** Every retained digest re-derived and matched. */
  chainHashesIntact: boolean;
  /** Older entries were trimmed, so the head link cannot be checked. */
  chainHeadUnverifiable: boolean;
  chainReasons: string[];
  sessionId: string;
  /** Entries written by the current session, out of `totalEntries`. */
  sessionEntries: number;
  totalSnapshots: number;
  totalDetections: number;
  totalRedactions: number;
  totalActions: number;
  lastEntryType: string | null;
}> {
  const store = await loadStore();
  const entries = store.entries;
  const chain = await verifyLedgerChain(entries);
  const totals = tally(entries);

  return {
    totalEntries: entries.length,
    chainValid: chain.valid,
    chainHashesIntact: chain.hashesIntact,
    chainHeadUnverifiable: chain.headLinkUnverifiable,
    chainReasons: chain.reasons,
    sessionId: store.sessionId ?? `session-${entries[0]?.timestamp ?? Date.now()}`,
    sessionEntries: sessionEntries(store),
    totalSnapshots: totals.totalSnapshots,
    totalDetections: totals.totalDetections,
    totalRedactions: totals.totalRedactions,
    totalActions: totals.totalActions,
    lastEntryType: entries.length > 0 ? entries[entries.length - 1].type : null,
  };
}

/**
 * Merkle root over the entry hashes of the RETAINED ledger window.
 *
 * Scope note, because it is easy to overstate: the root is computed over the
 * entries currently held (capped at MAX_ENTRIES). Once the cap trims the log,
 * the root changes, so this is a root over a moving window — not an append-only
 * log's root. It proves that the entries you were given have not been altered;
 * it does NOT prove that no entry was dropped, and callers must state the
 * window (see `coverage` in exportCertifiedAuditProof) rather than presenting
 * the root alone as a compliance artefact.
 */
export async function computeMerkleRoot(): Promise<string> {
  const store = await loadStore();
  if (store.entries.length === 0) return "0".repeat(64);

  let currentLevel = store.entries.map((e) => e.hash);
  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left;
      const combined = await sha256(left + right);
      nextLevel.push(combined);
    }
    currentLevel = nextLevel;
  }
  return currentLevel[0];
}

/**
 * Export a cryptographically certified audit proof document with Merkle root.
 */
export async function exportCertifiedAuditProof(): Promise<{
  sessionId: string;
  generatedAt: number;
  /** Total entries in the retained window (see `coverage`). */
  totalEntries: number;
  /** Entries written by the CURRENT session, out of totalEntries. */
  sessionEntries: number;
  merkleRoot: string;
  /** True only when every retained digest and link verified. */
  chainValid: boolean;
  chainHashesIntact: boolean;
  chainHeadUnverifiable: boolean;
  chainReasons: string[];
  /**
   * What the proof actually covers. Without this the consumer of the file has
   * no way to know the root is over a trimmed window, or that the head link is
   * unverifiable because earlier entries were dropped to the cap.
   */
  coverage: {
    retainedFromSeq: number | null;
    retainedToSeq: number | null;
    trimmed: boolean;
    maxEntries: number;
  };
  entries: LedgerEntry[];
}> {
  const store = await loadStore();
  const ledger = await getLedger();
  const merkleRoot = await computeMerkleRoot();
  const first = store.entries[0];
  const last = store.entries[store.entries.length - 1];
  return {
    sessionId: ledger.sessionId,
    generatedAt: Date.now(),
    totalEntries: ledger.entries.length,
    sessionEntries: ledger.summary.sessionEntries,
    merkleRoot,
    chainValid: ledger.summary.chainValid,
    chainHashesIntact: ledger.summary.chainHashesIntact,
    chainHeadUnverifiable: ledger.summary.chainHeadUnverifiable,
    chainReasons: (await verifyLedgerChain(store.entries)).reasons,
    coverage: {
      retainedFromSeq: first ? first.seq : null,
      retainedToSeq: last ? last.seq : null,
      trimmed: Boolean(first && first.seq > 1),
      maxEntries: MAX_ENTRIES,
    },
    entries: ledger.entries,
  };
}

/**
 * Export the ledger as a downloadable JSON.
 */
export async function exportLedger(): Promise<string> {
  const proof = await exportCertifiedAuditProof();
  return JSON.stringify(proof, null, 2);
}

/**
 * Clear the ledger.
 */
export async function clearLedger(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
