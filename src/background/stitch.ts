/**
 * Full-Page Screenshot Stitcher (Background-side)
 *
 * Orchestrates viewport captures down a scrollable page and stitches them
 * onto an OffscreenCanvas, honoring devicePixelRatio and avoiding header repetition.
 */

import type { PageMetrics } from "../content/fullpage";

const CAPTURE_INTERVAL_MS = 500;
const MAX_IMAGE_HEIGHT = 16000;
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
}

export async function captureAndStitchFullPage(
  tabId: number,
  windowId: number,
): Promise<StitchResult | null> {
  // 1. Initialize full-page mode in content script
  const startMetrics = await sendTab<PageMetrics>(tabId, { kind: "fullpage-begin" });
  if (!startMetrics) return null;

  const { pageWidth, pageHeight, viewportHeight, dpr } = startMetrics;
  const canvasWidth = Math.round(pageWidth * dpr);
  const canvasHeight = Math.min(MAX_IMAGE_HEIGHT, Math.round(pageHeight * dpr));

  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    await sendTab(tabId, { kind: "fullpage-restore" });
    return null;
  }

  let currentY = 0;
  let tileCount = 0;
  let lastReportedY = -1;

  try {
    while (currentY < pageHeight && tileCount < MAX_TILES) {
      // Scroll to position
      const metrics = await sendTab<PageMetrics>(tabId, {
        kind: "fullpage-scroll",
        y: currentY,
        hideSticky: tileCount > 0,
      });

      if (!metrics) break;
      if (metrics.scrollY === lastReportedY && tileCount > 0) {
        // Page hit the bottom and didn't move further
        break;
      }
      lastReportedY = metrics.scrollY;

      // Capture active viewport
      await delay(CAPTURE_INTERVAL_MS);
      const viewportDataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      const res = await fetch(viewportDataUrl);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);

      // Draw onto canvas at actual scroll offset
      const destY = Math.round(metrics.scrollY * dpr);
      ctx.drawImage(bitmap, 0, destY);
      bitmap.close();

      tileCount++;
      currentY += Math.max(100, Math.round(viewportHeight * 0.85)); // 15% overlap
    }
  } finally {
    // Restore page scroll and sticky visibility
    await sendTab(tabId, { kind: "fullpage-restore" });
  }

  const resultBlob = await canvas.convertToBlob({ type: "image/png" });
  const dataUrl = await blobToDataUrl(resultBlob);

  return {
    dataUrl,
    width: canvasWidth,
    height: canvasHeight,
    tiles: tileCount,
    dpr,
  };
}
