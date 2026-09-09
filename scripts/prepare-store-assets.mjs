/**
 * Prepare Chrome Web Store images from the user's annotated captures.
 *
 *  - shot 1 (YouTube task run)  -> 1280x800 screenshot, editor overlay cropped
 *  - shot 2 (Gmail + side panel)-> 1280x800 screenshot, personal inbox rows
 *                                 blurred BEFORE anything else (a privacy
 *                                 tool must not publish a real inbox)
 *  - marquee                    -> 1400x560 banner composed from scratch
 *                                 (the raw capture is 4:3; cropping it to a
 *                                 2.5:1 banner would destroy it), headline
 *                             typo fixed ("BROSWER" -> "BROWSER")
 *
 * All outputs: exact dimensions, 24-bit RGB, no alpha.
 *
 *   node scripts/prepare-store-assets.mjs
 */

import sharp from "sharp";
import { copyFile, mkdir } from "node:fs/promises";

const OUT = "assets/store";

// Source captures (annotated, from the design tool).
const SHOT1 = "C:/Users/dell/Downloads/Screenshot 2026-09-09 091054.jpg";
const SHOT2 =
  "C:/Users/dell/.zcode/cli/image-cache/sess_6c197e73-af1c-4ac6-bec9-bc50adc5d104/image-926ec9be02ddb60544efd3f561bb0a19.png";
const SHOT3 =
  "C:/Users/dell/.zcode/cli/image-cache/sess_6c197e73-af1c-4ac6-bec9-bc50adc5d104/image-e2bb572a72afa121cd377a55f31482cd.png";

/** Sample the top-left pixel so padding bars blend with the artwork. */
async function cornerColor(file) {
  const { data } = await sharp(file)
    .extract({ left: 0, top: 5, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const [r, g, b] = [data[0], data[1], data[2]];
  return { r, g, b, css: `rgb(${r},${g},${b})`, hex: `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}` };
}

/** Exact-size, alpha-free store PNG with blended padding bars. */
async function toStorePng(input, output, width, height, bg, preTransform = (s) => s) {
  await preTransform(sharp(input))
    .resize(width, height, { fit: "contain", background: bg })
    .flatten({ background: bg })
    .toColourspace("srgb")
    .png({ compressionLevel: 9 })
    .toFile(output);
  const m = await sharp(output).metadata();
  console.log(`${output}: ${m.width}x${m.height} alpha=${m.hasAlpha}`);
}

// ── Shot 1: YouTube run. Crop the design-tool hint bar off the top first,
// then pad to 1280x800 on the artwork's own background colour. ──
const bg1 = await cornerColor(SHOT1);
await toStorePng(
  SHOT1,
  `${OUT}/shot-1-youtube-cws.png`,
  1280, 800, bg1.css,
  (s) => s.extract({ left: 0, top: 42, width: 1124, height: 803 }),
);

// ── Shot 2: Gmail. Blur the inbox sender/subject rows FIRST — real names,
// financial subjects and job-search mails must never reach a public listing. ──
const blur = { left: 262, top: 218, width: 380, height: 465 };
const base = sharp(SHOT2);
const m2 = await base.metadata();
const region = await sharp(SHOT2)
  .extract(blur)
  .blur(14)
  .toBuffer();
const bg2 = await cornerColor(SHOT2);
await toStorePng(
  await sharp(SHOT2).composite([{ input: region, left: blur.left, top: blur.top }]).toBuffer(),
  `${OUT}/shot-2-gmail-cws.png`,
  1280, 800, bg2.css,
);

// ── Shot 3: original-vs-redacted live proof. Same contain-pad treatment. ──
const bg3 = await cornerColor(SHOT3);
await toStorePng(
  SHOT3,
  `${OUT}/shot-3-redaction-proof-cws.png`,
  1280, 800, bg3.css,
);

// ── Marquee: composed at 1400x560 (2.5:1). Headline typo fixed; the actual
// YouTube run screenshot embedded on the right. NOTE: sharp runs composite
// AFTER flatten in its fixed pipeline order, so the embedded image must be
// flattened BEFORE compositing or the alpha channel survives to the PNG. ──
const RED = "#d0202e";
const shotForMarquee = await sharp(`${OUT}/shot-1-youtube-cws.png`)
  .resize(660, 460, { fit: "contain", background: "#0d0a16" })
  .flatten({ background: "#0d0a16" })
  .toColourspace("srgb")
  .png()
  .toBuffer();

const svg = Buffer.from(`
<svg width="1400" height="560" xmlns="http://www.w3.org/2000/svg">
  <rect width="1400" height="560" fill="#0d0a16"/>
  <rect x="0" y="0" width="1400" height="6" fill="${RED}"/>
  <rect x="70" y="132" width="46" height="8" fill="${RED}"/>
  <text x="70" y="204" font-family="Consolas, 'Courier New', monospace" font-weight="700"
        font-size="58" fill="${RED}" letter-spacing="2">AUTOMATE ANY TASK</text>
  <text x="70" y="278" font-family="Consolas, 'Courier New', monospace" font-weight="700"
        font-size="58" fill="#ffffff" letter-spacing="2">IN YOUR BROWSER<tspan fill="${RED}">_</tspan></text>
  <text x="70" y="346" font-family="Ink Free, 'Segoe Print', cursive"
        font-size="38" fill="${RED}">PRY Agent</text>
  <text x="70" y="408" font-family="Consolas, 'Courier New', monospace"
        font-size="21" fill="#9aa0b0">&gt; PII detection, tokenization and redaction.</text>
  <text x="70" y="438" font-family="Consolas, 'Courier New', monospace"
        font-size="21" fill="#9aa0b0">&gt; All on your device. Verified with OCR.</text>
  <rect x="738" y="47" width="664" height="468" fill="none" stroke="${RED}" stroke-width="3"/>
</svg>`);

const composed = await sharp(Buffer.from(svg))
  .composite([{ input: shotForMarquee, left: 740, top: 51 }])
  .png()
  .toBuffer();

// Final pass guarantees 24-bit RGB, no alpha, whatever the composite did.
await sharp(composed)
  .flatten({ background: "#0d0a16" })
  .toColourspace("srgb")
  .png({ compressionLevel: 9 })
  .toFile(`${OUT}/marquee-final.png`);
console.log(`${OUT}/marquee-final.png: composed 1400x560`);

// ── Version the store-ready tile from Downloads into the repo. ──
await copyFile(
  "C:/Users/dell/Downloads/tile-440x280-CWS.png",
  `${OUT}/tile-440x280-cws.png`,
);
console.log(`${OUT}/tile-440x280-cws.png: copied from Downloads`);
