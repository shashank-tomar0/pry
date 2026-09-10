/**
 * Content Script
 *
 * The page-side half of the PRY agent. It owns the only code that reads
 * or touches the DOM; the service worker drives it entirely through messages.
 *
 * Perception channel: DOM perception — flattens interactive elements into
 * a numbered list. Screenshot capture is handled by the service worker
 * because chrome.tabs.captureVisibleTab and chrome.offscreen are not
 * available in content script context.
 */

import type { ContentRequest, ActionResult } from "../shared/types";
import { act } from "./act";
import { snapshot, getSensitiveRegions } from "./perceive";

chrome.runtime.onMessage.addListener(
  (request: ContentRequest, _sender, sendResponse: (r: unknown) => void) => {
    switch (request.kind) {
      case "ping":
        sendResponse({ ok: true, detail: "alive" } satisfies ActionResult);
        return false;

      case "snapshot":
        sendResponse({ ok: true, detail: "snapshot", snapshot: snapshot() } satisfies ActionResult);
        return false;

      case "act":
        // Async work requires keeping the message channel open (return true).
        // The catch matters: if the page navigates mid-action the context is
        // destroyed, and an unresolved channel surfaces in the background as
        // "the message channel closed before a response was received".
        act(request.action)
          .then(sendResponse)
          .catch((err) =>
            sendResponse({
              ok: false,
              detail: `Action interrupted: ${err instanceof Error ? err.message : String(err)}`,
            } satisfies ActionResult),
          );
        return true;

      case "capture-screenshot":
        sendResponse({
          ok: false,
          detail: "Screenshot capture must be handled by the service worker",
        } satisfies ActionResult);
        return false;

      case "get-sensitive-regions":
        sendResponse({
          ok: true,
          detail: "sensitive-regions",
          sensitiveRegions: getSensitiveRegions(),
          dpr: window.devicePixelRatio || 1,
        });
        return false;

      case "capture-and-act":
        // Same — screenshots are service-worker territory.
        // But we can still perform the action part.
        (async () => {
          try {
            const actionResult = await act(request.action);
            sendResponse({
              ok: actionResult.ok,
              detail: actionResult.detail,
              snapshot: actionResult.snapshot,
            } satisfies ActionResult);
          } catch (error) {
            sendResponse({
              ok: false,
              detail: `Action failed: ${error instanceof Error ? error.message : String(error)}`,
            } satisfies ActionResult);
          }
        })();
        return true;

      default:
        sendResponse({ ok: false, detail: "Unknown request" } satisfies ActionResult);
        return false;
    }
  },
);

// Forward tripwire network leak alerts from MAIN world to background service worker
window.addEventListener("__PRY_TRIPWIRE_ALERT__", (event: Event) => {
  const customEvent = event as CustomEvent;
  if (customEvent.detail) {
    chrome.runtime.sendMessage({
      type: "TRIPWIRE_ALERT",
      detail: customEvent.detail,
    }).catch(() => {
      // Background worker may be sleeping
    });
  }
});

