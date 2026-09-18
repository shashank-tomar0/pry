/**
 * Tripwire alert aggregation.
 *
 * The MAIN-world tripwire fires on EVERY outbound request that carries a
 * PII-shaped payload — a busy site (Gmail, banking, social) can trigger
 * dozens within seconds. Emitting each as its own transcript entry floods the
 * chat and buries the agent's actual reasoning.
 *
 * This module collapses all alerts into ONE live summary that the panel patches
 * in place, while the detailed per-request log lives in the radar drawer. Pure
 * functions only — no chrome.*, safe to unit-test in Node.
 *
 * TWO CORRECTIONS LIVE HERE, and both are about a number being read as more
 * than it is:
 *
 *   1. Nothing is "intercepted". The tripwire observes and calls through — it
 *      has no power to block a request and never exercises any. The summary now
 *      says what happened (observed) and states the limit (not blocked).
 *   2. Not every flagged send is a leak. A page posting to its own backend is
 *      the site working as designed; only a different SITE is third-party
 *      egress. Same-site alerts stay visible in the radar, labelled, and are
 *      counted apart from the alarmed total — a live run showed "2 third-party
 *      PII leaks intercepted" for the address the user had asked PRY to email.
 */

// One definition, re-exported. This module used to declare its own copy of the
// alert shape, which is how a field added at one end (the tripwire's
// third-party verdict) can silently not exist at the other.
import type { TripwireAlertDetail } from "../shared/types";
export type { TripwireAlertDetail };

export interface TripwireAggregator {
  /** Register one alert; returns the new one-line summary text. */
  bump(detail: TripwireAlertDetail): string;
  /** Current one-line summary text. */
  summary(): string;
  /** Total alerts observed, both channels. */
  total(): number;
  /** Alerts to a DIFFERENT site than the page — the ones worth alarming about. */
  thirdPartyTotal(): number;
  /** Alerts to the page's own site. */
  sameSiteTotal(): number;
  /** Alert counts keyed by PII type (uppercase), third-party only. */
  counts(): ReadonlyMap<string, number>;
  /** Top offending third-party hosts (hostname -> count). */
  hosts(): ReadonlyMap<string, number>;
  reset(): void;
}

const UNKNOWN_TYPE = "PII";

export function createTripwireAggregator(): TripwireAggregator {
  let totalAlerts = 0;
  let thirdPartyAlerts = 0;
  let sameSiteAlerts = 0;
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

  /**
   * An alert is third-party unless it says otherwise.
   *
   * `undefined` means the producer could not classify the destination. Counting
   * that as third-party keeps the alert's original, louder reading rather than
   * silently downgrading egress nobody has evidence about — the downgrade has
   * to be earned by the tripwire, which knows the page's origin.
   */
  function isThirdParty(detail: TripwireAlertDetail): boolean {
    return detail.thirdParty !== false;
  }

  function buildSummary(): string {
    const kinds = [...byType.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([kind, count]) => `${kind} ×${count}`);

    // Name the channel explicitly. The wire log's "LEAK" count measures what
    // reached the PLANNER; this counter measures PII-shaped payloads leaving
    // the page for THIRD PARTIES. Saying "outbound leak" for both made the two
    // panels look like they contradicted each other (0 there, 5 here).
    const headline =
      thirdPartyAlerts === 0
        ? "No third-party PII egress observed"
        : thirdPartyAlerts === 1
          ? "1 third-party PII leak observed — not blocked"
          : `${thirdPartyAlerts} third-party PII leaks observed — not blocked`;

    // Same-site sends are stated rather than hidden: "0 third-party" on its own
    // reads as "nothing happened" when the page did in fact send an address
    // somewhere, and a panel that hides evidence it gathered is not a proof.
    const sameSite =
      sameSiteAlerts > 0
        ? ` · ${sameSiteAlerts} same-site send${sameSiteAlerts === 1 ? "" : "s"} (the site you are using)`
        : "";

    return kinds.length > 0 ? `${headline} · ${kinds.join(" · ")}${sameSite}` : `${headline}${sameSite}`;
  }

  return {
    bump(detail: TripwireAlertDetail): string {
      const kind = String(detail.piiType || UNKNOWN_TYPE).toUpperCase();
      totalAlerts++;
      const party = isThirdParty(detail);
      if (party) {
        thirdPartyAlerts++;
        byType.set(kind, (byType.get(kind) ?? 0) + 1);
        const host = hostOf(detail.url);
        byHost.set(host, (byHost.get(host) ?? 0) + 1);
      } else {
        sameSiteAlerts++;
      }
      return buildSummary();
    },
    summary: buildSummary,
    total: () => totalAlerts,
    thirdPartyTotal: () => thirdPartyAlerts,
    sameSiteTotal: () => sameSiteAlerts,
    counts: () => byType,
    hosts: () => byHost,
    reset: () => {
      totalAlerts = 0;
      thirdPartyAlerts = 0;
      sameSiteAlerts = 0;
      byType.clear();
      byHost.clear();
    },
  };
}
