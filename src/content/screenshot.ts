/**
 * Screenshot Capture — Content Script Side
 *
 * Content scripts CANNOT call chrome.tabs.captureVisibleTab or
 * chrome.offscreen.createDocument. Screenshot capture and privacy
 * processing are handled entirely by the service worker.
 *
 * This file is kept as a thin interface so the content script's
 * message handler doesn't break if other code references it.
 */

// Content script only handles DOM perception and actions.
// Screenshot capture is orchestrated by the service worker.
