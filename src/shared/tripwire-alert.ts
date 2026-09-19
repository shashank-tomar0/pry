import type { TripwireAlertDetail } from "./types";

/**
 * Shape a raw `TRIPWIRE_ALERT` message into the detail the aggregator consumes.
 *
 * WHY THIS IS A MODULE AND NOT THREE LINES IN THE RELAY
 *
 * The tripwire runs in the page's MAIN world, where it can see the page's own
 * origin, and it is the only producer that can say whether a request left the
 * site the user is on. That verdict has to survive the message hop into the
 * service worker. It did not: the relay rebuilt the detail from a field list
 * that omitted `thirdParty`, and the aggregator reads a missing verdict as
 * third-party on purpose (it will not downgrade egress nobody classified). The
 * result was that every PII-shaped request looked like exfiltration — a live
 * Gmail run reported "5 third-party PII leaks observed — not blocked · EMAIL ×5"
 * for the address the user had asked PRY to email, while the tripwire's own
 * console line called the same request same-site.
 *
 * Keeping the mapping in one exported function is what stops that recurring: the
 * test drives THIS function with the producer's real payload instead of asserting
 * on the relay's source text, so dropping a field fails the suite.
 */
export function normalizeTripwireAlert(raw: unknown): TripwireAlertDetail | null {
  if (!raw || typeof raw !== "object") return null;
  const detail = raw as Record<string, unknown>;

  // A verdict travels only when it IS a verdict. `undefined` means the producer
  // could not classify the destination, which is a different fact from "same
  // site" and must not be rendered as one.
  const thirdParty =
    typeof detail.thirdParty === "boolean" ? detail.thirdParty : undefined;

  return {
    url: String(detail.url ?? ""),
    method: String(detail.method ?? "REQUEST"),
    piiType: String(detail.piiType ?? "pii"),
    sample: String(detail.sample ?? ""),
    thirdParty,
    timestamp: Number(detail.timestamp) || Date.now(),
  };
}
