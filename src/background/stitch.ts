/**
 * Full-Page Screenshot Stitcher (Background-side)
 *
 * Orchestrates viewport captures down a scrollable page and stitches them
 * onto an OffscreenCanvas, honoring devicePixelRatio and avoiding header repetition.
 */

import type { PageMetrics } from "../shared/types";

/**
 * Settle time between scroll and capture.
 *
 * The content script already waits 100ms for layout, but paint + compositor
 * upload on a heavy page needs longer. At 150ms tiles were captured mid-scroll
 * and the stitched image came out torn/duplicated — which reads as a
 * "distorted screenshot" in the audit view. 400ms is the value this shipped
 * with before the timing was tightened.
 */
const CAPTURE_INTERVAL_MS = 400;
const MAX_IMAGE_HEIGHT = 8192;
/** Tiles at 85% viewport steps: 20 tiles covers ~17 viewports of page. */
const MAX_TILES = 20;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTab<T>(tabId: number, msg: unknown): Promise<T | null> {
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as T;
  } catch {
    return null;
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export interface StitchResult {
  dataUrl: string;
  width: number;
  height: number;
  tiles: number;
  dpr: number;
  /** All tiles matched the target tab and expected geometry; no gaps/truncation. */
  captureVerified: boolean;
}

export async function captureAndStitchFullPage(
  tabId: number,
  windowId: number,
): Promise<StitchResult | null> {
  // Ensure the target tab is active in its window so captureVisibleTab captures it
  const activated = await chrome.tabs.update(tabId, { active: true }).catch(() => null);
  if (!activated || activated.windowId !== windowId) return null;

  // 1. Initialize full-page mode in content script
  const startMetrics = await sendTab<PageMetrics>(tabId, { kind: "fullpage-begin" });
  if (!startMetrics) return null;

  const { pageWidth, pageHeight, viewportWidth, viewportHeight, dpr } = startMetrics;
  if (![pageWidth, pageHeight, viewportWidth, viewportHeight, dpr].every(
    (n) => Number.isFinite(n) && n > 0,
  ) || !Number.isFinite(startMetrics.scrollX) || !Number.isFinite(startMetrics.scrollY)) {
    await sendTab(tabId, { kind: "fullpage-restore" });
    return null;
  }
  const canvasWidth = Math.max(1, Math.round(pageWidth * dpr));
  const canvasHeight = Math.max(1, Math.min(MAX_IMAGE_HEIGHT, Math.round(pageHeight * dpr)));

  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    await sendTab(tabId, { kind: "fullpage-restore" });
    return null;
  }

  let currentY = 0;
  let tileCount = 0;
  let lastReportedY = -1;
  let coveredUntil = 0;
  let captureVerified = pageWidth === viewportWidth && startMetrics.scrollX === 0 &&
    pageHeight * dpr <= MAX_IMAGE_HEIGHT;

  try {
    while (currentY < pageHeight && tileCount < MAX_TILES) {
      // Scroll to position
      const metrics = await sendTab<PageMetrics>(tabId, {
        kind: "fullpage-scroll",
        y: currentY,
        hideSticky: tileCount > 0,
      });

      if (!metrics || !Number.isFinite(metrics.scrollY) || metrics.scrollY < 0 ||
          metrics.viewportWidth !== viewportWidth || metrics.viewportHeight !== viewportHeight ||
          metrics.dpr !== dpr || metrics.pageWidth !== pageWidth || metrics.pageHeight !== pageHeight ||
          metrics.scrollX !== startMetrics.scrollX) {
        captureVerified = false;
        break;
      }
      if (metrics.scrollY === lastReportedY && tileCount > 0) {
        // Page hit the bottom and didn't move further
        break;
      }
      lastReportedY = metrics.scrollY;

      // Capture active viewport
      await delay(CAPTURE_INTERVAL_MS);
      const [activeBefore] = await chrome.tabs.query({ active: true, windowId });
      if (activeBefore?.id !== tabId) return null;
      const viewportDataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      const [activeAfter] = await chrome.tabs.query({ active: true, windowId });
      if (activeAfter?.id !== tabId) return null;
      // Read-only post-capture check: do not scroll again to hide a race.
      const [check] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({ scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY),
          width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio,
          url: location.href }),
      });
      const actual = check?.result;
      if (!actual || actual.scrollX !== metrics.scrollX || actual.scrollY !== metrics.scrollY ||
          actual.width !== viewportWidth || actual.height !== viewportHeight ||
          actual.dpr !== dpr || actual.url !== activated.url) captureVerified = false;
      const res = await fetch(viewportDataUrl);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);

      // Draw onto canvas at the actual scroll offset, scaled to the canvas
      // width. Canvas width is pageWidth*dpr while a tile is viewportWidth*dpr;
      // on a page with horizontal overflow those differ, and an unscaled tile
      // left a blank strip down the right edge of the stitched image.
      if (bitmap.width <= 0 || bitmap.height <= 0) {
        bitmap.close();
        return null;
      }
      if (Math.abs(bitmap.width - viewportWidth * dpr) > 1 ||
          Math.abs(bitmap.height - viewportHeight * dpr) > 1) captureVerified = false;
      const scaleRatio = canvasWidth / bitmap.width;
      const tileHeight = Math.round(bitmap.height * scaleRatio);
      const destY = Math.round(metrics.scrollY * canvasWidth / viewportWidth);
      if (destY > coveredUntil) captureVerified = false;
      coveredUntil = Math.max(coveredUntil, destY + tileHeight);
      ctx.drawImage(bitmap, 0, destY, canvasWidth, tileHeight);
      bitmap.close();

      tileCount++;
      currentY += Math.max(100, Math.round(viewportHeight * 0.85)); // 15% overlap
    }
  } finally {
    // Restore page scroll and sticky visibility
    await sendTab(tabId, { kind: "fullpage-restore" });
  }

  if (tileCount === 0) return null;
  captureVerified = captureVerified && coveredUntil >= canvasHeight;
  const resultBlob = await canvas.convertToBlob({ type: "image/png" });
  const dataUrl = await blobToDataUrl(resultBlob);

  return {
    dataUrl,
    width: canvasWidth,
    height: canvasHeight,
    tiles: tileCount,
    dpr,
    captureVerified,
  };
}
