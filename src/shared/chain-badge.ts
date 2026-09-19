/**
 * The privacy ledger's tamper verdict, as pure policy.
 *
 * WHY THIS IS A MODULE AND NOT THREE TERNARIES IN THE PANEL
 *
 * The badge used to be built inline in `sidepanel.ts` from two fields of the
 * ledger summary, and it could not see `chainValid` — the one field the verifier
 * computes from BOTH halves of the chain (`hashesIntact && linksIntact`). So a
 * ledger whose links did not join while every digest it could re-derive matched
 * rendered as **INTACT***, and in the one case where the mangled entry was also
 * the first retained entry it rendered as a clean **INTACT**. That is the same
 * mistake the comment above the old code had just been fixed to stop making about
 * the trimmed head: a badge asserting something the check computed the opposite
 * of.
 *
 * A link that does not join is a COMPUTED finding, which is what separates it
 * from the trimmed head (nothing could be checked there at all) and from an entry
 * written under a digest rule this build does not implement (also nothing to
 * check). The first is reported as TAMPERED; the other two are the partial state.
 * It lives here so the verdict can be driven by real summary shapes in the
 * harness instead of asserted against the panel's source text.
 *
 * Pure: no DOM, no chrome APIs, no HTML escaping (the renderer owns that).
 */

export interface LedgerSummaryForBadge {
  /** `hashesIntact && linksIntact`, from the verifier. */
  chainValid?: boolean;
  /** Every digest the current build can derive was re-derived and matched. */
  chainHashesIntact?: boolean;
  /** Older entries were trimmed, so the oldest surviving link cannot be checked. */
  chainHeadUnverifiable?: boolean;
  /** Entries whose digest this build cannot re-derive at all. */
  chainLegacyUnverifiable?: number;
  /** The verifier's single finding, or the note explaining what it could not check. */
  chainReasons?: string[];
}

export interface ChainBadge {
  /** CSS class for the chain number. */
  className: "verified" | "partial" | "tampered";
  label: "INTACT" | "INTACT*" | "TAMPERED";
  /** One sentence to render under the badge. Unescaped; the renderer escapes it. */
  note: string;
}

export function chainBadge(
  summary: LedgerSummaryForBadge | null | undefined,
): ChainBadge {
  const ls = summary ?? {};
  const reason = (ls.chainReasons ?? [])[0];
  // Absent means "the worker did not say", which is not a finding: an older
  // worker's summary has no `chainValid`, and inventing tampering from a missing
  // field would be the same class of mistake in the opposite direction.
  const hashesOk = ls.chainHashesIntact !== false;
  const linksOk = ls.chainValid !== false;
  const headUnknown = ls.chainHeadUnverifiable === true;
  const legacyUnverifiable =
    typeof ls.chainLegacyUnverifiable === "number" ? ls.chainLegacyUnverifiable : 0;
  const partial = headUnknown || legacyUnverifiable > 0;

  if (!hashesOk) {
    return {
      className: "tampered",
      label: "TAMPERED",
      note: `Hash mismatch: ${reason ?? "an entry does not match its recorded digest"}`,
    };
  }

  if (!linksOk) {
    return {
      className: "tampered",
      label: "TAMPERED",
      note: `Link mismatch: ${reason ?? "an entry does not link to the entry before it"}`,
    };
  }

  if (partial) {
    return {
      className: "partial",
      label: "INTACT*",
      note:
        reason ??
        "Every retained digest verified; part of the chain could not be checked.",
    };
  }

  return {
    className: "verified",
    label: "INTACT",
    note: "Every retained entry re-hashed and matched its recorded digest.",
  };
}
