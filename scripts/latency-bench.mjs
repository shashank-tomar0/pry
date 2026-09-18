/**
 * Latency benchmark — where a step's wall-clock actually goes.
 *
 * The post-action path runs, in sequence: fresh snapshot → NER → paint → OCR
 * triage (up to 6 tiles) → verification OCR → adversarial probes → (optional)
 * VLM call → next planner turn. The OCR half is pure local cost, it is awaited
 * before the next planner turn, and it was never measured. This times it with
 * the SAME tesseract.js stack and the SAME lang data the extension ships, on the
 * tile geometry the pipeline actually produces (device pixels, full frame
 * width, TRIAGE_TILE_HEIGHT = 900).
 *
 * Run it before and after a change to that path: `npm run bench:latency`.
 * The absolute numbers are machine-dependent; the RATIO between a 1x tile, a 2x
 * tile and a cold start is not, and that ratio is what the policy decisions
 * (tile cap, warm-up, when to capture at all) are made on.
 *
 * COMPARE LIKE WITH LIKE. The first run on a machine with a cold file cache
 * measured 2.6 s for the 1x tile and 10.5 s for the first recognition; an
 * immediate re-run of the same script measured 1.2 s and 1.0 s. The engine
 * itself is not 10x faster on the second run — the trained data was already in
 * cache. Both numbers matter: the cold one is what a user pays on their first
 * capture of a session if nothing warms the worker, the warm one is the steady
 * state that every later capture pays.
 */
import { createWorker } from "tesseract.js";
import Jimp from "jimp";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const langPath = resolve(__dirname, "../node_modules/@tesseract.js-data/eng/4.0.0_best_int");

const font = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
const small = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);

/** A realistic slice of an app page: labels, rows, values, prose. */
function renderTile(width, height) {
  const img = new Jimp(width, height, 0xffffffff);
  const lines = [
    "Billed to:  Priya Sharma",
    "Email:      priya.sharma@example.in",
    "Phone:      +91 98765 43210",
    "Aadhaar:    2345 6789 0124",
    "PAN:        AAACR5055K",
    "Card:       4111 1111 1111 1111",
    "Amount:     Rs 12,499 (order ref 773409112233)",
    "Status:     Pending review by the accounts team",
    "The quick brown fox jumps over the lazy dog near the riverbank.",
    "Search results 1-10 of about 4,320,000 for devops channels",
  ];
  let y = 40;
  let i = 0;
  while (y < height - 40) {
    img.print(i % 3 === 2 ? small : font, 32, y, lines[i % lines.length]);
    y += 60;
    i++;
  }
  return img;
}

const worker = await createWorker("eng", 1, { langPath, gzip: true });
console.log("worker ready (warm)\n");

const scan = async (img, label) => {
  const e0 = performance.now();
  const buf = await img.getBufferAsync(Jimp.MIME_PNG);
  const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  const encodeMs = performance.now() - e0;
  const t0 = performance.now();
  const res = await worker.recognize(dataUrl, {}, { text: true, blocks: true });
  const ms = performance.now() - t0;
  const words = (res.data.blocks ?? []).flatMap((b) => (b.paragraphs ?? []).flatMap((p) => (p.lines ?? []).flatMap((l) => l.words ?? [])));
  console.log(
    `${label.padEnd(34)} encode ${encodeMs.toFixed(0).padStart(5)} ms   ` +
      `ocr ${ms.toFixed(0).padStart(5)} ms   ${String(words.length).padStart(4)} words   ${(buf.length / 1024).toFixed(0)} KB PNG`,
  );
  return ms;
};

// The code slices the canvas into device-pixel tiles of TRIAGE_TILE_HEIGHT
// (900), full frame width. These are the tiles a real frame actually produces.
console.log("── the tiles the pipeline actually OCRs ──");
const t1x = await scan(renderTile(1440, 900), "1440x900   1x viewport, 1 tile");
const t2x = await scan(renderTile(2880, 900), "2880x900   2x viewport, per tile");

console.log("\n── per capture: triage tiles + the verification re-read ──");
const vp1x = { tiles: 1, label: "1440x900 viewport @1x" };
const vp2x = { tiles: 2, label: "1440x900 viewport @2x (retina)" };
const tall2x = { tiles: 6, label: "tall stitched page @2x (6-tile cap)" };
for (const vp of [vp1x, vp2x, tall2x]) {
  const triage = vp.tiles === 1 ? t1x : t2x * vp.tiles;
  console.log(
    `${vp.label.padEnd(34)} triage ${(triage / 1000).toFixed(1)} s   ` +
      `+ verify re-read (regions strip, small)   = ${(triage / 1000).toFixed(1)} s and up, per capture`,
  );
}

console.log("\n── a blank tile is skipped before OCR (the one cheap path) ──");
await scan(new Jimp(2880, 900, 0xffffffff), "2880x900 blank (OCRed here; skipped in prod)");

console.log("\n── cold start: what the FIRST OCR of a session costs ──");
const coldStart = performance.now();
const cold = await createWorker("eng", 1, { langPath, gzip: true });
const coldMs = performance.now() - coldStart;
const coldBuf = await renderTile(1440, 900).getBufferAsync(Jimp.MIME_PNG);
const first = performance.now();
await cold.recognize(`data:image/png;base64,${coldBuf.toString("base64")}`, {}, { text: true, blocks: true });
console.log(`worker construction ${(coldMs / 1000).toFixed(1)} s + first recognition ${((performance.now() - first) / 1000).toFixed(1)} s`);
await cold.terminate();

await worker.terminate();
