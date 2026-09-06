/**
 * Tripwire alert aggregation.
 *
 * The MAIN-world tripwire fires on EVERY outbound request that carries a
 * PII-shaped payload — a busy site (Gmail, banking, social) can trigger
 * dozens within seconds. Emitting each as its own transcript entry floods
 * the chat and buries the agent's actual reasoning.
 *
 * This module collapses all intercepts into ONE live summary that the panel
 * patches in place, while the detailed per-request log lives in the radar
 * drawer. Pure functions only — no chrome.*, safe to unit-test in Node.
 */

export interface TripwireAlertDetail {
  url: string;
  method: string;
  piiType: string;
  sample: string;
  timestamp: number;
}

export interface TripwireAggregator {
  /** Register one intercept; returns the new one-line summary text. */
  bump(detail: TripwireAlertDetail): string;
  /** Current one-line summary text. */
  summary(): string;
  /** Total intercepts since the last reset. */
  total(): number;
  /** Intercept counts keyed by PII type (uppercase). */
  counts(): ReadonlyMap<string, number>;
  /** Top offending hosts (hostname -> intercept count). */
  hosts(): ReadonlyMap<string, number>;
  reset(): void;
}

const UNKNOWN_TYPE = "PII";

export function createTripwireAggregator(): TripwireAggregator {
  let totalIntercepts = 0;
  const byType = new Map<string, number>();
  const byHost = new Map<string, number>();

  function hostOf(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace(/^www\./, "") || "(unknown)";
    } catch {
      return "(unknown)";
    }
  }

  function buildSummary(): string {
    const kinds = [...byType.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([kind, count]) => `${kind} ×${count}`);
    const headline =
      totalIntercepts === 1
        ? "1 outbound PII leak blocked"
        : `${totalIntercepts} outbound PII leaks blocked`;
    return kinds.length > 0 ? `${headline} · ${kinds.join(" · ")}` : headline;
  }

  return {
    bump(detail: TripwireAlertDetail): string {
      const kind = String(detail.piiType || UNKNOWN_TYPE).toUpperCase();
      totalIntercepts++;
      byType.set(kind, (byType.get(kind) ?? 0) + 1);
      const host = hostOf(detail.url);
      byHost.set(host, (byHost.get(host) ?? 0) + 1);
      return buildSummary();
    },
    summary: buildSummary,
    total: () => totalIntercepts,
    counts: () => byType,
    hosts: () => byHost,
    reset: () => {
      totalIntercepts = 0;
      byType.clear();
      byHost.clear();
    },
  };
}