// Generates the placeholder app icons in public/ (run once: node scripts/make-icons.mjs).
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const BG = [0x2f, 0x5d, 0x50];
const FG = [0xf6, 0xf3, 0xee];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const rows = [];
  const r = size * 0.3;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      // Speech bubble: a circle plus a small tail at the bottom left.
      const dx = x - size / 2;
      const dy = y - size * 0.46;
      const inCircle = dx * dx + dy * dy < r * r;
      const inTail = y > size * 0.6 && y < size * 0.78 && x > size * 0.3 && x < size * 0.3 + (size * 0.78 - y) * 0.9;
      const c = inCircle || inTail ? FG : BG;
      row.set(c, 1 + x * 3);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = new URL('../public/', import.meta.url);
writeFileSync(new URL('icon-192.png', dir), png(192));
writeFileSync(new URL('icon-512.png', dir), png(512));
writeFileSync(new URL('apple-touch-icon.png', dir), png(180));
writeFileSync(
  new URL('icon.svg', dir),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#2f5d50"/><circle cx="50" cy="46" r="30" fill="#f6f3ee"/><path d="M30 60 L30 78 L48 66 Z" fill="#f6f3ee"/></svg>\n`,
);
