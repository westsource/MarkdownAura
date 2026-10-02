/* Generates the placeholder app icons into src-tauri/icons/.
 *
 * These are placeholders drawn to match SPEC §8 (flat, no gradient, no shadow): the accent
 * purple rounded square with the "text lines, short title first" motif the preview view
 * icon already uses. Replace them with a real mark when there is one — but keep the sizes,
 * because src-tauri/tauri.conf.json and the Windows resource both depend on them.
 *
 *     node tools/make-icons.mjs
 *
 * Writes PNGs (32 / 128 / 256 / 512) and an uncompressed-BMP .ico. BMP entries rather than
 * PNG-in-ICO on purpose: PNG-compressed ICO entries are Vista+ only and the Windows resource
 * embedder is happier with the plain form.
 */
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

const ACCENT = [0x53, 0x4a, 0xb7]; // tokens.css --ac, light theme
const BAR = [0xff, 0xff, 0xff];

/* All geometry in 0..1 so one description renders correctly at every size. */
const PLATE = { x0: 0.046875, y0: 0.046875, x1: 0.953125, y1: 0.953125, r: 0.203125 };
const BARS = [
  { x0: 0.203125, y0: 0.359375, x1: 0.515625, y1: 0.421875 },
  { x0: 0.203125, y0: 0.46875, x1: 0.796875, y1: 0.53125 },
  { x0: 0.203125, y0: 0.578125, x1: 0.796875, y1: 0.640625 },
];

function inRoundRect(px, py, s) {
  const { x0, y0, x1, y1, r } = s;
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  if (py >= y0 + r && py <= y1 - r) return true;
  if (px >= x0 + r && px <= x1 - r) return true;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Straight-alpha RGBA buffer, top-down. 4x4 supersampled so small sizes stay clean. */
function render(size) {
  const SS = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let plateHit = 0;
      let barHit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size;
          const py = (y + (sy + 0.5) / SS) / size;
          if (!inRoundRect(px, py, PLATE)) continue;
          plateHit++;
          if (BARS.some((b) => inRoundRect(px, py, { ...b, r: (b.y1 - b.y0) / 2 }))) barHit++;
        }
      }
      const total = SS * SS;
      if (!plateHit) continue;
      const barFrac = barHit / total;
      const plateFrac = plateHit / total;
      const mix = (a, b) => Math.round(a * (1 - barFrac) + b * barFrac);
      const i = (y * size + x) * 4;
      out[i] = mix(ACCENT[0], BAR[0]);
      out[i + 1] = mix(ACCENT[1], BAR[1]);
      out[i + 2] = mix(ACCENT[2], BAR[2]);
      out[i + 3] = Math.round(plateFrac * 255);
    }
  }
  return out;
}

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** One ICO directory entry: 32bpp BGRA, bottom-up, plus a zeroed 1bpp AND mask. */
function icoEntry(size) {
  const rgba = render(size);
  const maskRow = Math.ceil(size / 32) * 4;
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(size, 4);
  info.writeInt32LE(size * 2, 8); // XOR + AND
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(32, 14);

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const i = src + x * 4;
      const o = (y * size + x) * 4;
      xor[o] = rgba[i + 2];
      xor[o + 1] = rgba[i + 1];
      xor[o + 2] = rgba[i];
      xor[o + 3] = rgba[i + 3];
    }
  }
  return { size, data: Buffer.concat([info, xor, Buffer.alloc(maskRow * size)]) };
}

function encodeIco(sizes) {
  const entries = sizes.map(icoEntry);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dir = [];
  for (const e of entries) {
    const b = Buffer.alloc(16);
    b[0] = e.size >= 256 ? 0 : e.size;
    b[1] = e.size >= 256 ? 0 : e.size;
    b.writeUInt16LE(1, 4);
    b.writeUInt16LE(32, 6);
    b.writeUInt32LE(e.data.length, 8);
    b.writeUInt32LE(offset, 12);
    dir.push(b);
    offset += e.data.length;
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.data)]);
}

fs.mkdirSync(OUT, { recursive: true });

for (const size of [32, 128, 256, 512]) {
  fs.writeFileSync(path.join(OUT, `icon-${size}.png`), encodePng(size, render(size)));
}
fs.copyFileSync(path.join(OUT, "icon-128.png"), path.join(OUT, "128x128.png"));
fs.copyFileSync(path.join(OUT, "icon-256.png"), path.join(OUT, "128x128@2x.png"));
fs.copyFileSync(path.join(OUT, "icon-32.png"), path.join(OUT, "32x32.png"));
fs.writeFileSync(path.join(OUT, "icon.png"), encodePng(512, render(512)));
fs.writeFileSync(path.join(OUT, "icon.ico"), encodeIco([16, 32, 48, 64, 128, 256]));

for (const f of fs.readdirSync(OUT).sort()) {
  console.log(`  ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(1).padStart(8)} KB  ${f}`);
}
