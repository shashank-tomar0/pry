// Package dist/ contents into a Chrome Web Store upload zip.
// Deterministic: fixed DOS timestamps, forward-slash paths, deflate compression.
import { deflateRawSync, crc32 } from "node:zlib";
import { readFile, readdir, writeFile, rename, mkdir, copyFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "dist");
const OUT = join(ROOT, "publish", "pry-agent-1.0.0.zip");

// Fixed DOS timestamp: 2026-09-08 12:00:00
const DOS_TIME = (12 << 11) | (0 << 5) | 0;
const DOS_DATE = ((2026 - 1980) << 9) | (9 << 4) | 8;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const files = (await walk(SRC)).sort();
const entries = [];
let offset = 0;
let central = Buffer.alloc(0);

for (const file of files) {
  const name = relative(SRC, file).split("\\").join("/");
  const data = await readFile(file);
  const compressed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(Buffer.byteLength(name), 26);
  local.writeUInt16LE(0, 28);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt16LE(DOS_TIME, 12);
  cd.writeUInt16LE(DOS_DATE, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(compressed.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(Buffer.byteLength(name), 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt32LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(offset, 42);

  entries.push({ name, crc, compressed, size: data.length });
  central = Buffer.concat([central, cd, Buffer.from(name)]);
  offset += 30 + Buffer.byteLength(name) + compressed.length;
}

const locals = [];
for (const e of entries) {
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(e.crc, 14);
  local.writeUInt32LE(e.compressed.length, 18);
  local.writeUInt32LE(e.size, 22);
  local.writeUInt16LE(Buffer.byteLength(e.name), 26);
  local.writeUInt16LE(0, 28);
  locals.push(Buffer.concat([local, Buffer.from(e.name), e.compressed]));
}
const localData = Buffer.concat(locals);
const cdStart = localData.length;

const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(central.length, 12);
eocd.writeUInt32LE(cdStart, 16);
eocd.writeUInt16LE(0, 20);

const archive = Buffer.concat([localData, central, eocd]);
await mkdir(join(ROOT, "publish"), { recursive: true });
const tmp = OUT + ".tmp";
await writeFile(tmp, archive);
await rename(tmp, OUT);
await copyFile(OUT, join(ROOT, "landing", "pry-agent-1.0.0-chrome.zip"));

console.log(
  `packaged ${entries.length} files -> ${OUT} (${(archive.length / 1024 / 1024).toFixed(2)} MB)`,
);