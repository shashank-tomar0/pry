/**
 * OCR verification test (runs in Node directly, not esbuild-bundled).
 *
 * Renders real text images with jimp, OCRs them with the same tesseract.js
 * stack the extension ships (local eng data, no CDN), and asserts:
 *   1. A rendered 16-digit card number IS recovered by OCR, and
 *   2. A black-box-redacted card line is NOT recovered (redaction holds at
 *      the text level, which is what the offscreen pipeline verifies).
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

await worker.terminate();
console.log(`\n${passed} OCR assertions passed.`);