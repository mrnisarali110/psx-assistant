/**
 * Draw the app icons (teal tile, rising line) as PNGs with no image libraries.
 * Run once: npm run icons  -> public/icons/*.png and public/favicon.svg
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const BG = [15, 118, 110]; // teal-700
const FG = [255, 255, 255];
const LINE: [number, number][] = [[0.22, 0.66], [0.4, 0.48], [0.54, 0.58], [0.76, 0.34]];

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function encodePng(w: number, h: number, rgba: Uint8Array) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function segDist(px: number, py: number, [ax, ay]: number[], [bx, by]: number[]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** `inset` shrinks the artwork (maskable icons keep content in the middle 80%). `full` = no rounded corners. */
function draw(size: number, { inset = 0, full = false, mono = false } = {}) {
  const px = new Uint8Array(size * size * 4);
  const radius = full ? 0 : size * 0.22;
  const scale = 1 - inset * 2;
  const thick = size * 0.075 * scale;
  const pts = LINE.map(([x, y]) => [size * (inset + x * scale), size * (inset + y * scale)]);
  const end = pts[pts.length - 1];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      // rounded-rect coverage (signed distance, 1px anti-alias)
      const qx = Math.max(Math.abs(cx - size / 2) - (size / 2 - radius), 0);
      const qy = Math.max(Math.abs(cy - size / 2) - (size / 2 - radius), 0);
      const tile = full ? 1 : Math.max(0, Math.min(1, radius - Math.hypot(qx, qy) + 0.5));
      let d = Infinity;
      for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, segDist(cx, cy, pts[i], pts[i + 1]));
      const line = Math.max(Math.max(0, Math.min(1, thick / 2 - d + 0.5)), Math.max(0, Math.min(1, thick * 0.95 - Math.hypot(cx - end[0], cy - end[1]) + 0.5)));
      const o = (y * size + x) * 4;
      if (mono) { // notification badge: white glyph on transparent
        px.set([255, 255, 255, Math.round(line * 255)], o);
        continue;
      }
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(BG[c] * (1 - line) + FG[c] * line);
      px[o + 3] = Math.round(tile * 255);
    }
  }
  return encodePng(size, size, px);
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', draw(192));
writeFileSync('public/icons/icon-512.png', draw(512));
writeFileSync('public/icons/maskable-512.png', draw(512, { inset: 0.12, full: true }));
writeFileSync('public/icons/apple-touch-icon.png', draw(180, { full: true })); // iOS rounds corners itself
writeFileSync('public/icons/badge-72.png', draw(72, { mono: true }));
writeFileSync('public/favicon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="rgb(${BG.join(',')})"/><polyline points="${LINE.map(([x, y]) => `${x * 64},${y * 64}`).join(' ')}" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${LINE[3][0] * 64}" cy="${LINE[3][1] * 64}" r="4.6" fill="#fff"/></svg>`);
console.log('icons written to public/icons');
