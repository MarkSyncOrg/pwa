// Generates PWA icons with no external dependencies: a raw PNG encoder draws a
// white bookmark glyph on an indigo background. Solid, recognizable, and enough
// for installability + Lighthouse. Run via `pnpm gen:icons`.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons');

const BG = [0x4f, 0x46, 0xe5]; // indigo
const FG = [0xff, 0xff, 0xff]; // white

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// True where the bookmark glyph (rounded ribbon with a bottom V-notch) is drawn.
function isGlyph(px, py, size, padScale) {
  const x = px / size;
  const y = py / size;
  const left = 0.34 * padScale + (1 - padScale) * 0.5;
  const right = 1 - left;
  const top = 0.22 * padScale + (1 - padScale) * 0.5;
  const bottom = 1 - (0.18 * padScale + (1 - padScale) * 0.5);
  if (x < left || x > right || y < top || y > bottom) return false;
  // Bottom V-notch in the lower third.
  const notchStart = top + (bottom - top) * 0.62;
  if (y > notchStart) {
    const cx = 0.5;
    const depth = (y - notchStart) / (bottom - notchStart);
    if (Math.abs(x - cx) < depth * (right - left) * 0.5) return false;
  }
  return true;
}

function makePng(size, { maskable } = {}) {
  // maskable icons need a safe zone: shrink the glyph so it survives circular masks.
  const padScale = maskable ? 0.78 : 1;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const c = isGlyph(x, y, size, padScale) ? FG : BG;
      raw[o++] = c[0];
      raw[o++] = c[1];
      raw[o++] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
const targets = [
  ['icon-192.png', makePng(192)],
  ['icon-512.png', makePng(512)],
  ['icon-maskable-512.png', makePng(512, { maskable: true })],
  ['apple-touch-icon.png', makePng(180)],
];
for (const [name, buf] of targets) {
  writeFileSync(resolve(OUT_DIR, name), buf);
  console.log(`wrote public/icons/${name} (${buf.length} bytes)`);
}
