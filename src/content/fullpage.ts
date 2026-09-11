/**
 * Full-Page Screenshot Capture (Content-side Scroller)
 *
 * Handles DOM scrolling, metric tracking, and fixed/sticky element hiding
 * so full-page screenshots can be stitched without duplicate headers.
 */

interface HiddenElement {
  el: HTMLElement;
  visibility: string;
}

let hiddenSticky: HiddenElement[] = [];
let initialScroll: { x: number; y: number } | undefined;
let initialScrollBehavior: string | undefined;

import type { PageMetrics } from "../shared/types";
export type { PageMetrics };

export function getPageMetrics(): PageMetrics {
  const doc = document.documentElement;
  return {
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    pageWidth: Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0, window.innerWidth),
    pageHeight: Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0, window.innerHeight),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    stickyHidden: hiddenSticky.length,
  };
}

export function beginFullPageCapture(): PageMetrics {
  initialScroll = { x: window.scrollX, y: window.scrollY };
  initialScrollBehavior = document.documentElement.style.scrollBehavior;
  document.documentElement.style.scrollBehavior = "auto";
  hiddenSticky = [];
  return getPageMetrics();
}

function findStickyElements(): HTMLElement[] {
  if (!document.body) return [];
  const elements: HTMLElement[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!(node instanceof HTMLElement)) continue;
    const style = window.getComputedStyle(node);
    if (style.position === "fixed" || style.position === "sticky") {
      const rect = node.getBoundingClientRect();
      if (rect.width > 4 && rect.height > 4 && rect.bottom >= 0 && rect.top <= window.innerHeight) {
        elements.push(node);
      }
    }
  }
  return elements;
}

export function hideStickyElements(): void {
  for (const el of findStickyElements()) {
    if (hiddenSticky.some((h) => h.el === el)) continue;
    hiddenSticky.push({ el, visibility: el.style.visibility });
    el.style.visibility = "hidden";
  }
}

export async function scrollToY(y: number, hideSticky: boolean): Promise<PageMetrics> {
  if (hideSticky) {
    hideStickyElements();
  }
  window.scrollTo(window.scrollX, y);
  // Wait a moment for layout/render to settle
  await new Promise((resolve) => setTimeout(resolve, 100));
  return getPageMetrics();
}

export function restoreFullPageCapture(): void {
  for (const { el, visibility } of hiddenSticky) {
    el.style.visibility = visibility;
  }
  hiddenSticky = [];
  if (initialScroll) {
    window.scrollTo(initialScroll.x, initialScroll.y);
  }
  if (initialScrollBehavior !== undefined) {
    document.documentElement.style.scrollBehavior = initialScrollBehavior;
  }
}
