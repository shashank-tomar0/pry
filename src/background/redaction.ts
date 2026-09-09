/**
 * Redaction Engine — DOM channel
 *
 * Replaces sensitive values in a DOM snapshot before it reaches the model:
 * credential fields become [REDACTED] (or keep their vault token when the
 * tokenizer already replaced the value), ID numbers in page text become
 * [ID_REDACTED], and redacted hrefs lose their target.
 *
 * The screenshot (pixel) half of redaction lives in the offscreen document,
 * which owns canvas redaction with deterministic blur — this module is
 * text-only and DOM-free so the verification harness can exercise it.
 */

import type { DetectedPII } from "./pii-detector";

// ─── DOM Redaction ──────────────────────────────────────────────────────────

/**
 * Redacts sensitive values in a DOM snapshot by replacing them with tokens.
 * This is separate from image redaction — it handles the text/structured data
 * channel.
 */
export function redactSnapshot(
  snapshot: {
    elements: Array<{
      id: number;
      role: string;
      name: string;
      value?: string;
      attrs?: Record<string, string>;
    }>;
    text: string;
  },
  detections: DetectedPII[],
): {
  elements: Array<{
    id: number;
    role: string;
    name: string;
    value?: string;
    attrs?: Record<string, string>;
  }>;
  text: string;
  redactedCount: number;
} {
  let redactedCount = 0;

  // Build a set of element IDs that have detected PII.
  const credentialIds = new Set(
    detections
      .filter((d) => d.kind === "credential" || d.kind === "api_key")
      .map((d) => {
        const match = d.elementSelector?.match(/data-pry-id="(\d+)"/);
        return match ? parseInt(match[1], 10) : -1;
      })
      .filter((id) => id >= 0),
  );

  const TOKEN_RE = /^<[A-Z]+_\d+>$/;

  const elements = snapshot.elements.map((el) => {
    if (credentialIds.has(el.id)) {
      // If the value was already tokenized, keep the token — the LLM needs it
      // to reference the value at action time. Only raw values become [REDACTED].
      if (el.value && TOKEN_RE.test(el.value)) {
        return el;
      }
      redactedCount++;
      return {
        ...el,
        value: el.value ? "[REDACTED]" : undefined,
        attrs: el.attrs
          ? Object.fromEntries(
              Object.entries(el.attrs).map(([k, v]) =>
                k === "href" ? [k, "[REDACTED]"] : [k, v],
              ),
            )
          : undefined,
      };
    }
    return el;
  });

  // Redact ID numbers from page text.
  let text = snapshot.text;
  for (const det of detections.filter((d) => d.kind === "id_number" && d.value)) {
    text = text.replaceAll(det.value!, "[ID_REDACTED]");
    redactedCount++;
  }

  return { elements, text, redactedCount };
}
