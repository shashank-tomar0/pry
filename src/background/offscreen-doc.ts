/**
 * Offscreen document lifecycle.
 *
 * The offscreen document hosts every on-device model (BlazeFace, NER, the
 * injection guard), the canvas redaction pipeline, and Tesseract OCR. Only the
 * service worker may create it.
 *
 * This lives in its own module because more than one caller needs it: the
 * screenshot path obviously does, and so does the ML bridge. Without that
 * second caller the very first NER/guard call of a run had no receiving end —
 * `chrome.runtime.sendMessage` rejected, the bridge degraded to its fallback,
 * and the first screenshot shipped without the NER→pixel black boxes because
 * no spans had ever been produced. Cheap to call, safe to call repeatedly.
 */

let creating: Promise<void> | null = null;

export async function ensureOffscreenDocument(): Promise<void> {
  try {
    const existingContexts = await (chrome.runtime as unknown as {
      getContexts?: (filter: { contextTypes: string[] }) => Promise<unknown[]>;
    }).getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (existingContexts && existingContexts.length > 0) return;
  } catch {
    // getContexts may not be available in older Chrome versions.
  }

  // Concurrent callers must not race two createDocument calls: the second one
  // rejects with "Only a single offscreen document may be created".
  if (creating) return creating;

  creating = (async () => {
    try {
      await (chrome.offscreen as unknown as {
        createDocument: (options: {
          url: string;
          reasons: string[];
          justification: string;
        }) => Promise<void>;
      }).createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS", "BLOBS"],
        justification:
          "Canvas screenshot redaction, on-device ML inference, and adversarial OCR verification",
      });
    } catch {
      // Already exists (or creation raced) — either way it is usable.
    } finally {
      creating = null;
    }
  })();

  return creating;
}
