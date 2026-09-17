/**
 * Screenshot egress evidence — production and assembly (pure policy).
 *
 * WHY THIS EXISTS
 *
 * `ScreenshotProtection` is the contract `shared/screenshot-egress.ts` reads
 * before any image may leave the device. The contract was declared in
 * `shared/types.ts`, tested in `scripts/screenshot-egress-test.mjs` — and never
 * populated by anything. The only writer was the service worker's downgrade
 * helper, which hardcodes every flag `false`. So `screenshotSendDecision`
 * always returned `allowed: false` with the reason "Protection evidence
 * missing", `sendProtectedScreenshot` never invoked its send callback, and the
 * VLM vision path could not ship a single frame no matter how healthy the
 * pipeline was. The test passed because it hand-built the object production
 * could not produce.
 *
 * The split below mirrors what each process can actually witness:
 *
 *   - the OFFSCREEN document knows whether its own scans completed, so it
 *     produces the flags for the work it did (`deriveOffscreenProtection`);
 *   - the SERVICE WORKER knows whether the DOM text regions were collected and
 *     whether the region→image mapping was verified, so it assembles the final
 *     object and owns the geometry verdict (`applyCaptureEvidence`).
 *
 * Neither half is allowed to infer the other's evidence. An absent object fails
 * CLOSED (`missingProtection`), because the alternative — treating "no evidence"
 * as "nothing to worry about" — is how this pipeline shipped unverified frames.
 *
 * Deliberately NOT part of the egress contract: frame-text triage coverage. The
 * offscreen triage pass is documented as additive and best-effort (a frame that
 * is mostly whitespace is triaged and clean), so it is reported in the audit but
 * never blocks. Enforcement lives on the flags below, which have real producers.
 */

import type { ScreenshotProtection } from "./types";

/** What the offscreen document can prove about its own passes on this frame. */
export interface OffscreenProtectionEvidence {
  /** The face scan finished — at least one channel ran to completion. */
  faceScanRan: boolean;
  /** Why the face scan did not finish, when it did not. */
  faceScanFailure?: string;
  /**
   * The final pixel/OCR verification pass ran against the bytes that ship.
   * A frame with nothing to verify counts as ran: the pass completed and had
   * no regions to re-read, which is a result, not a gap.
   */
  finalScanRan: boolean;
  /** Why the final scan did not run, when it did not. */
  finalScanFailure?: string;
  /** Residual content the final scan proved still readable. Must be 0. */
  residualDetections: number;
  /** User policy fully enabled: faces destroyed AND credentials masked. */
  policyEnabled: boolean;
}

/**
 * Assemble the offscreen half of the evidence.
 *
 * `mappingValid` is false here on purpose: the offscreen document cannot see the
 * capture geometry (DPR, tile scale, scroll offset) that the mapping depends on.
 * The service worker sets it in `applyCaptureEvidence`. Leaving it false until
 * then means a frame that somehow skipped assembly is refused rather than sent.
 */
export function deriveOffscreenProtection(
  evidence: OffscreenProtectionEvidence,
): ScreenshotProtection {
  const reasons: string[] = [];
  if (!evidence.faceScanRan) {
    reasons.push(
      `Face scan did not complete${evidence.faceScanFailure ? `: ${evidence.faceScanFailure}` : ""}`,
    );
  }
  if (!evidence.finalScanRan) {
    reasons.push(
      `Final image scan did not run${evidence.finalScanFailure ? `: ${evidence.finalScanFailure}` : ""}`,
    );
  }
  const residual = Number.isFinite(evidence.residualDetections)
    ? Math.max(0, Math.trunc(evidence.residualDetections))
    : Number.POSITIVE_INFINITY;
  if (residual > 0) {
    reasons.push(`${residual} residual detection(s) survived the redaction pass`);
  }
  if (!evidence.policyEnabled) {
    reasons.push("Required protection disabled by settings");
  }

  return {
    facesComplete: evidence.faceScanRan,
    // The DOM text channel is the service worker's to witness (see
    // applyCaptureEvidence). Claiming it here would be evidence we do not have.
    textComplete: false,
    mappingValid: false,
    finalScanComplete: evidence.finalScanRan,
    residualDetections: residual,
    policyEnabled: evidence.policyEnabled,
    reasons,
  };
}

/**
 * Fail-closed evidence for a frame whose producer supplied none.
 *
 * This is what the guard already assumed (`!p` → "Protection evidence
 * missing"). Making it an explicit object means the reason survives into the
 * transcript instead of being indistinguishable from a healthy block.
 */
export function missingProtection(reason: string): ScreenshotProtection {
  return {
    facesComplete: false,
    textComplete: false,
    mappingValid: false,
    finalScanComplete: false,
    residualDetections: Number.POSITIVE_INFINITY,
    policyEnabled: false,
    reasons: [reason],
  };
}

/** What the service worker contributes to the final evidence object. */
export interface CaptureEvidence {
  /**
   * DOM text-region collection completed for the captured tab. A failed
   * collection means this frame's text PII was never handed to the pixel
   * channel, so it cannot be shipped.
   */
  textComplete: boolean;
  /**
   * Region→image geometry was verified for THIS image: the mapping resolved and
   * the capture was confirmed to match the page state it was measured against.
   */
  mappingValid: boolean;
  /** Extra refusal reasons, appended without duplicates. */
  reasons?: string[];
}

/**
 * Assemble the final evidence object: the offscreen half plus the service
 * worker's half.
 *
 * Note what this does NOT do any more: force `mappingValid` to false
 * unconditionally. The previous helper did, so even a verified mapping could
 * never be reported valid, and the flag was unreadable even after the flags
 * above were fixed. Geometry validity now comes from the caller, which is the
 * only process holding the numbers behind it.
 */
export function applyCaptureEvidence(
  protection: ScreenshotProtection | undefined,
  evidence: CaptureEvidence,
): ScreenshotProtection {
  const base = protection ?? missingProtection("Offscreen pipeline returned no protection evidence");
  return {
    ...base,
    textComplete: evidence.textComplete,
    mappingValid: evidence.mappingValid,
    reasons: [...new Set([...(base.reasons ?? []), ...(evidence.reasons ?? [])])],
  };
}
