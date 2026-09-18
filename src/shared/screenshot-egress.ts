import type { ProcessedScreenshotResult } from "./types";

/** Evidence of completed checks, NOT a claim of perfect detector recall. */
export function screenshotSendDecision(frame: ProcessedScreenshotResult): { allowed: boolean; reasons: string[] } {
  const p = frame.protection;
  const reasons: string[] = [];
  if (!p) reasons.push("Protection evidence missing");
  else {
    if (p.policyEnabled !== true) reasons.push("Required protection disabled");
    if (p.facesComplete !== true) reasons.push("Face scan incomplete");
    if (p.textComplete !== true) reasons.push("Text scan incomplete");
    if (p.mappingValid !== true) reasons.push("Capture mapping unverified");
    if (p.finalScanComplete !== true) reasons.push("Final image scan incomplete");
    // The residual count and the verifier's leaked patterns are the SAME finding:
    // `residualDetections` is derived from `leakedPatterns`. Reporting both — plus
    // a second "Mask verification unsuccessful" below — is how one region became
    // three lines in the transcript, reading as three independent problems when
    // the user's actual question was WHICH region. `p.reasons` carries the detail.
    const residualNamed = p.reasons.some((r) => /residual detection\(s\) survived/.test(r));
    if (p.residualDetections !== 0 && !residualNamed) reasons.push("Residual sensitive content detected");
    reasons.push(...p.reasons);
  }
  const v = frame.verification;
  if (!v || v.verified !== true || v.regionsChecked !== v.regionsRedacted || v.leakedPatterns.length > 0) {
    // Skip the generic phrase when the masks the verifier rejected are exactly the
    // residuals already named above — otherwise the same sentence appears twice.
    const alreadyNamed =
      p !== undefined &&
      v !== undefined &&
      v.leakedPatterns.length > 0 &&
      p.residualDetections === v.leakedPatterns.length &&
      v.regionsChecked === v.regionsRedacted + v.leakedPatterns.length;
    if (!alreadyNamed) reasons.push("Mask verification unsuccessful");
  }
  if (!/^data:image\/(?:png|jpeg);base64,/.test(frame.redactedDataUrl)) reasons.push("Invalid screenshot encoding");
  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** Only this callback receives image bytes; blocked frames never invoke it. */
export async function sendProtectedScreenshot<T>(
  frame: ProcessedScreenshotResult,
  send: (dataUrl: string) => Promise<T>,
): Promise<{ sent: false; reasons: string[] } | { sent: true; value: T }> {
  const decision = screenshotSendDecision(frame);
  if (!decision.allowed) return { sent: false, reasons: decision.reasons };
  return { sent: true, value: await send(frame.redactedDataUrl) };
}
