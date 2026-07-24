'use strict';
/*
 * One-time generator for the menu-bar/tray icons (electron/assets/
 * trayTemplate.png and @2x — inside electron/ so they ship in the asar).
 * Hand-encodes the PNG with zlib so the repo needs no image tooling.
 *
 * The glyph is the MacCleaner mark distilled for the menu bar: a treemap
 * mosaic (one dominant tile + a split column — the app's signature disk map),
 * drawn in pure black + alpha. macOS treats a pure-black+alpha PNG as a "template" image
 * and recolors it to match the menu bar (light/dark), so no brand color is
 * baked in here. Curves are rasterized procedurally (no image tooling) with
 * 4x supersampling for smooth edges at 16 px. Run: node scripts/gen-tray-icon.js
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePng(size, pixels /* Uint8Array RGBA */) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // raw scanlines: filter byte 0 + row data
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0;
    pixels.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/*
 * Coverage of one point (in a 16-unit design space) by the glyph, returned
 * as 0..1. The glyph = the MacCleaner mark distilled for the menu bar: a
 * treemap mosaic (one dominant tile + a split column) drawn in pure black +
 * alpha. Antialiasing is handled by the caller via supersampling, so this
 * returns a hard 0/1 mask.
 */
function inGlyph(x, y) {
  // Treemap mosaic tiles in the 16-unit space: big volume tile on the left,
  // two stacked tiles on the right, with ~1.3-unit gutters.
  const inRect = (x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  return (
    inRect(2.0, 2.0, 8.7, 14.0) || // dominant tile
    inRect(10.0, 2.0, 14.0, 7.6) || // top right
    inRect(10.0, 8.9, 14.0, 14.0) // bottom right
  );
}

/** Draw the MacCleaner tray glyph at scale (1 -> 16px, 2 -> 32px). */
function drawGlyph(scale) {
  const size = 16 * scale;
  const px = Buffer.alloc(size * size * 4);
  const SS = 4; // supersample factor per axis for antialiasing
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Map pixel-subsample -> 16-unit design space.
          const dx = ((pxi + (sx + 0.5) / SS) / size) * 16;
          const dy = ((py + (sy + 0.5) / SS) / size) * 16;
          if (inGlyph(dx, dy)) hits++;
        }
      }
      const alpha = Math.round((hits / (SS * SS)) * 255);
      const i = (py * size + pxi) * 4;
      px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = alpha; // black + alpha
    }
  }
  return encodePng(size, px);
}

const outDir = path.join(__dirname, '..', 'electron', 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'trayTemplate.png'), drawGlyph(1));
fs.writeFileSync(path.join(outDir, 'trayTemplate@2x.png'), drawGlyph(2));
console.log('Wrote electron/assets/trayTemplate.png and trayTemplate@2x.png');
