/**
 * Small, platform-free helpers that more than one context needs.
 *
 * WHY THESE THREE LIVE TOGETHER
 *
 * Each of these existed as two or three byte-identical copies in different
 * modules — an egress counter in the agent and in the vision pass, an egress
 * formatter in the agent and in the panel, and one FNV-1a in the agent beside a
 * second in the surrogate generator. Copies are not free even at six lines: the
 * byte counters are the two halves of the number on the egress badge, and the
 * formatter is what renders it, so a fix to one and not the other makes the
 * badge disagree with the log it summarises.
 *
 * They are together rather than one file each because a module per three-line
 * helper costs more than the helper: three imports, three headers, and nothing
 * to find in any of them. Everything here is pure and DOM-free — except
 * `blobToDataUrl`, which wraps `FileReader` and is therefore never CALLED from
 * Node, though the harness still imports this module for the rest.
 */

/** UTF-8 byte length of a string (TextEncoder; falls back to the char count). */
export function estimateUtf8Bytes(value: string): number {
  try {
    return new TextEncoder().encode(value).length;
  } catch {
    // No TextEncoder in this context: length is the honest upper-ish bound and
    // is what the badge shows.
    return value.length;
  }
}

/** Human-readable byte count for the egress badge. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}

/**
 * Cheap 32-bit FNV-1a.
 *
 * Never cryptographic and never used as one: the agent's use is a "did this page
 * text change" signature, so the Tier-0 models are not re-run on a page that did
 * not move, and the surrogate generator's use is a deterministic digit
 * derivation. The seed is a parameter for the second caller; one algorithm means
 * one place for a change to land.
 */
export function fnv1a(text: string, seed = 0x811c9dc5): number {
  let h = seed;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** An axis-aligned box, in whatever pixel space the caller is measuring. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Overlap of two boxes as an area, in the units the boxes are in.
 *
 * Geometry, not policy — it says nothing about faces or about text. Both callers
 * use it the same way: as a coverage FRACTION (`overlap / area >= threshold`) to
 * decide whether one box is already accounted for by another, which is how the
 * face channels merge their boxes and how OCR triage decides a text region is
 * already redacted. Touching at an edge counts as zero, because a shared edge
 * covers nothing.
 */
export function overlapArea(a: Box, b: Box): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

/**
 * A blob as a `data:` URL.
 *
 * Two execution contexts need this (`stitch.ts` in the worker, the offscreen
 * document in its message handler) and both had their own copy, which is how the
 * two drifted into reporting a failed read differently. `FileReader.readAsDataURL`
 * is the only platform way to do it, and it is async — hence the promise.
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Blob read failed"));
    reader.readAsDataURL(blob);
  });
}
