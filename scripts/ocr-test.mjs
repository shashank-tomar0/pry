/**
 * OCR verification test (runs in Node directly, not esbuild-bundled).
 *
 * Renders real text images with jimp, OCRs them with the same tesseract.js
 * stack the extension ships (local eng data, no CDN), and asserts:
 *   1. A rendered 16-digit card number IS recovered by OCR, and
 *   2. A black-box-redacted card line is NOT recovered (redaction holds at
 *      the text level, which is what the offscreen pipeline verifies);
 *   3. PII rendered into an image comes back as WORDS WITH BOXES, which is what
 *      frame-text triage needs to redact pixels the DOM never had.
 */
import { createWorker } from "tesseract.js";
import Jimp from "jimp";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const langPath = resolve(__dirname, "../node_modules/@tesseract.js-data/eng/4.0.0_best_int");

const CARD = "4111 1111 1111 1111";

let passed = 0;
function ok(name, cond, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  passed++;
  console.log(`  ✓ ${name}`);
}

import { build } from "esbuild";
const frameTextModule = await build({
  entryPoints: [resolve(__dirname, "../src/shared/frame-text.ts")],
  bundle: true, platform: "node", format: "esm", write: false,
});
const { tileLooksReadable } = await import(
  `data:text/javascript;base64,${Buffer.from(frameTextModule.outputFiles[0].text).toString("base64")}`
);

// The actual pre-OCR gate must admit binary text, not just antialiased text.
const binary = new Jimp(780, 200, 0xffffffff);
const binaryFont = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
binary.print(binaryFont, 16, 24, "Contact ada@example.com");
for (let p = 0; p < binary.bitmap.data.length; p += 4) {
  const value = binary.bitmap.data[p] < 128 ? 0 : 255;
  binary.bitmap.data[p] = binary.bitmap.data[p + 1] = binary.bitmap.data[p + 2] = value;
}
ok("binary black-on-white email is admitted to OCR", tileLooksReadable(binary.bitmap));
for (let p = 0; p < binary.bitmap.data.length; p += 4) {
  binary.bitmap.data[p] ^= 255;
  binary.bitmap.data[p + 1] ^= 255;
  binary.bitmap.data[p + 2] ^= 255;
}
ok("binary white-on-black email is admitted to OCR", tileLooksReadable(binary.bitmap));
for (const value of [0, 128, 255]) {
  const data = new Uint8ClampedArray(64 * 4).fill(value);
  ok(`uniform ${value} tile is skipped`, !tileLooksReadable({ data }));
}

const worker = await createWorker("eng", 1, {
  langPath,
  gzip: true,
  logger: () => undefined,
});

// 1) Original text image → OCR must recover the card digits.
{
  const font = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
  const img = new Jimp(780, 200, 0xffffffff);
  img.print(font, 16, 24, `Order confirmation\nCard: ${CARD}\nThank you`);
  const png = await img.getBufferAsync(Jimp.MIME_PNG);

  const { data } = await worker.recognize(png);
  const digits = (data.text ?? "").replace(/\D/g, "");
  ok(
    "OCR recovers the rendered card digits",
    digits.length >= 16 && digits.includes("4111") && digits.includes("1111"),
    `digits=${digits}`,
  );
}

// 2) Redacted image (black box painted over the card line) → OCR must NOT
// see a card. Painted via setPixelColor (jimp composite no-ops with raw
// colors), mirroring how the offscreen pipeline masks credential regions.
{
  const font = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
  const img = new Jimp(780, 200, 0xffffffff);
  img.print(font, 16, 24, `Card: ${CARD}`);
  for (let y = 16; y < 88; y++) {
    for (let x = 0; x < 780; x++) {
      img.setPixelColor(0xff000000, x, y);
    }
  }
  const png = await img.getBufferAsync(Jimp.MIME_PNG);

  const { data } = await worker.recognize(png);
  const digits = (data.text ?? "").replace(/\D/g, "");
  ok(
    "black-box redaction hides the card from OCR",
    !digits.includes("4111"),
    `digits=${digits}`,
  );
}

// 3) Word boxes — what frame-text triage depends on.
// PII baked into an <img>/<canvas>/video frame has no DOM to measure, so the
// redaction has to come from OCR: recognize the frame, find PII in the text,
// paint the words it covered. That only works if the engine hands back per-word
// bounding boxes AND they sit where the text actually is. Text recognized but
// unlocatable would leave the pipeline able to DETECT a leak it cannot fix.
{
  const font = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
  const img = new Jimp(780, 200, 0xffffffff);
  img.print(font, 16, 24, `Contact ada@example.com now\nCall 98765 43210 today`);
  const png = await img.getBufferAsync(Jimp.MIME_PNG);

  const { data } = await worker.recognize(png, {}, { text: true, blocks: true });

  const words = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block?.paragraphs ?? []) {
      for (const line of paragraph?.lines ?? []) {
        for (const word of line?.words ?? []) {
          if (!word?.bbox) continue;
          words.push({ text: (word.text ?? "").trim(), bbox: word.bbox });
        }
      }
    }
  }

  ok("the OCR engine returns per-word bounding boxes, not just text",
    words.length > 0 && words.every((w) => w.bbox.x1 > w.bbox.x0 && w.bbox.y1 > w.bbox.y0),
    `words=${words.length}`);

  const email = words.find((w) => w.text.includes("@"));
  ok("an email rendered into an image is read as a word with a box",
    Boolean(email), JSON.stringify(words.map((w) => w.text)));
  ok("that box sits on the drawn text line (so a painted mask lands on it)",
    Boolean(email) && email.bbox.y0 >= 0 && email.bbox.y0 < 100 && email.bbox.x0 > 0,
    JSON.stringify(email?.bbox));

  // Boxing the union of the words on that line is what the triage paints, and
  // it must then be UNREADABLE — the whole point of the feature.
  const emailLine = words.filter((w) => /\.com|@|@example/i.test(w.text));
  for (const w of emailLine) {
    for (let y = w.bbox.y0; y <= w.bbox.y1; y++) {
      for (let x = w.bbox.x0; x <= w.bbox.x1; x++) {
        img.setPixelColor(0xff000000, x, y);
      }
    }
  }
  const covered = await img.getBufferAsync(Jimp.MIME_PNG);
  const after = await worker.recognize(covered);
  ok("boxing the recognized email words hides it from a re-read",
    !(after.data.text ?? "").includes("@"),
    `text=${(after.data.text ?? "").replace(/\s+/g, " ").slice(0, 80)}`);
}

await worker.terminate();
console.log(`\n${passed} OCR assertions passed.`);