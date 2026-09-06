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
    /** Whether the chain is valid (no tampering). */
    chainValid: boolean;
  };
}

// ─── Storage ────────────────────────────────────────────────────────────────

const STORAGE_KEY = "pry-privacy-ledger";
const MAX_ENTRIES = 500;

interface LedgerStore {
  entries: LedgerEntry[];
  entryCounter: number;
  lastHash: string;
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
 * Initialize the ledger for a new session.
 * Loads existing entries from storage and resets for a new session.
 */
export async function initLedger(): Promise<void> {
  // We don't clear existing entries - we append to them.
  // This way the ledger grows across sessions.
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
    const content = JSON.stringify({ seq, timestamp, type, data, prevHash: store.lastHash });
    const hash = await sha256(content);

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
 * Record a token resolution (token → real value at action time).
 */
export async function recordResolution(token: string, kind: string): Promise<LedgerEntry> {
  // Never store the resolved value - only that a resolution happened.
  return addEntry("resolve", { token, kind });
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
 * Get the complete ledger with chain integrity verification.
 */
export async function getLedger(): Promise<PrivacyLedger> {
  const store = await loadStore();
  const summary = {
    totalSnapshots: 0,
    totalDetections: 0,
    totalTokensCreated: 0,
    totalRedactions: 0,
    totalActions: 0,
    verificationPassed: true,
    chainValid: true,
  };

  // Verify chain integrity.
  let prevHash = store.entries.length > 0 && store.entries[0].seq > 1
    ? store.entries[0].prevHash
    : "0".repeat(64);
  for (const entry of store.entries) {
    // Check chain link.
    if (entry.prevHash !== prevHash) {
      summary.chainValid = false;
    }

    // Verify hash.
    const content = JSON.stringify({
      seq: entry.seq,
      timestamp: entry.timestamp,
      type: entry.type,
      data: entry.data,
      prevHash: entry.prevHash,
    });
    const expectedHash = await sha256(content);
    if (expectedHash !== entry.hash) {
      summary.chainValid = false;
    }

    // Count by type.
    switch (entry.type) {
      case "snapshot": summary.totalSnapshots++; break;
      case "detection": summary.totalDetections += (entry.data.count as number) ?? 0; break;
      case "tokenize": summary.totalTokensCreated += (entry.data.count as number) ?? 0; break;
      case "redact": summary.totalRedactions += (entry.data.redactedCount as number) ?? 0; break;
      case "action": summary.totalActions++; break;
      case "verification":
        if (!entry.data.passed) summary.verificationPassed = false;
        break;
    }

    prevHash = entry.hash;
  }

  return {
    sessionId: `session-${store.entries[0]?.timestamp ?? Date.now()}`,
    entries: store.entries,
    summary,
  };
}

/**
 * Get just the summary (lighter than full getLedger, no chain verification).
 */
export async function getLedgerSummary(): Promise<{
  totalEntries: number;
  chainValid: boolean;
  totalSnapshots: number;
  totalDetections: number;
  totalRedactions: number;
  totalActions: number;
  lastEntryType: string | null;
}> {
  const store = await loadStore();
  const entries = store.entries;
  let totalSnapshots = 0;
  let totalDetections = 0;
  let totalRedactions = 0;
  let totalActions = 0;

  // Quick chain check (just links, no hash re-verification for speed).
  let chainValid = true;
  let prevHash = "0".repeat(64);
  for (const entry of entries) {
    if (entry.prevHash !== prevHash) {
      chainValid = false;
    }
    switch (entry.type) {
      case "snapshot": totalSnapshots++; break;
      case "detection": totalDetections += (entry.data.count as number) ?? 0; break;
      case "redact": totalRedactions += (entry.data.redactedCount as number) ?? 0; break;
      case "action": totalActions++; break;
    }
    prevHash = entry.hash;
  }

  return {
    totalEntries: entries.length,
    chainValid,
    totalSnapshots,
    totalDetections,
    totalRedactions,
    totalActions,
    lastEntryType: entries.length > 0 ? entries[entries.length - 1].type : null,
  };
}

/**
 * Export the ledger as a downloadable JSON.
 */
export async function exportLedger(): Promise<string> {
  const ledger = await getLedger();
  return JSON.stringify(ledger, null, 2);
}

/**
 * Clear the ledger.
 */
export async function clearLedger(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
