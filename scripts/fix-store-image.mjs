/**
 * Convert any image into a Chrome Web Store compliant asset.
 *
 * The store rejects images that are not EXACTLY the required size, or that
 * carry an alpha channel (32-bit RGBA PNG). Its error message ("The image
 * size is incorrect") is shown for both cases, which makes it confusing.
 * This script fixes both: it center-crops (or pads) to the exact target
 * dimensions and flattens transparency away, writing a 24-bit PNG.
 *
 * Usage:
 *   node scripts/fix-store-image.mjs <input> <output> <width> <height> [--bg "#c8102e"] [--contain]
 *
 *   --bg       background color used to flatten transparency (default white)
 *   --contain  pad to fit instead of cropping (default crops to fill)
 *
 * Store specs:
 *   screenshots   1280x800   (JPEG or 24-bit PNG)
 *   small tile     440x280   (JPEG or 24-bit PNG)
 *   marquee       1400x560   (JPEG or 24-bit PNG)
 */

import sharp from "sharp";

const args = process.argv.slice(2);
const positional = [];
let bg = "#ffffff";
let contain = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--bg") bg = args[++i] ?? bg;
  else if (args[i] === "--contain") contain = true;
  else positional.push(args[i]);
}

const [input, output, w, h] = positional;
if (!input || !output || !w || !h) {
  console.error(
    "Usage: node scripts/fix-store-image.mjs <input> <output> <width> <height> [--bg \"#c8102e\"] [--contain]",
  );
  process.exit(1);
}

const width = Number(w);
const height = Number(h);
if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
  console.error(`Invalid dimensions: ${w}x${h}`);
  process.exit(1);
}

const meta = await sharp(input).metadata();
console.log(
  `Input: ${input} ${meta.width}x${meta.height} ` +
    `${meta.hasAlpha ? "(has alpha -> will be flattened)" : "(no alpha)"}`,
);

await sharp(input)
  .rotate() // respect EXIF orientation from phone screenshots
  .resize(width, height, {
    fit: contain ? "contain" : "cover",
    position: "centre",
    background: bg,
  })
  // flatten composites any transparency onto `bg`, removing the alpha channel
  .flatten({ background: bg })
  .toColourspace("srgb") // guarantee 24-bit RGB output
  .png({ compressionLevel: 9 })
  .toFile(output);

const out = await sharp(output).metadata();
console.log(
  `Output: ${output} ${out.width}x${out.height} ` +
    `${out.hasAlpha ? "STILL HAS ALPHA (bug!)" : "24-bit RGB, no alpha"} — store ready`,
);
