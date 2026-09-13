/**
 * Post-build for the Chrome extension (runs after `vite build`, which produced the side panel):
 *  1. builds the remaining targets with the shared config factory (options page, background
 *     service worker, content script) — one self-contained file each, stable names
 *  2. copies src/manifest.json into dist/ (version from package.json) and checks references
 *     --store: strips the localhost origin dev builds use, so the Web Store upload asks only for
 *     permissions a published user can actually need
 *  3. generates deterministic PNG icons (16/32/48/128) with a tiny hand-written encoder
 *  4. zips dist/ into release/sf-claws.zip (deflate, fixed timestamps => reproducible)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { makeConfig } from '../vite.config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const releaseDir = path.join(root, 'release');

// ================================================================ helpers
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Draw a brand-blue rounded square with a white "x3" glyph (rectangles only). Returns RGBA buffer. */
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size;
  const radius = Math.round(s * 0.22);
  const bg = [1, 118, 211]; // brand-500, the Salesforce blue the UI uses
  const bgDark = [1, 68, 134]; // brand-700 for the subtle bottom shade
  const set = (x, y, c, a = 255) => {
    if (x < 0 || y < 0 || x >= s || y >= s) return;
    const i = (y * s + x) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = a;
  };
  const inRounded = (x, y) => {
    const cx = x < radius ? radius : x >= s - radius ? s - radius - 1 : x;
    const cy = y < radius ? radius : y >= s - radius ? s - radius - 1 : y;
    const dx = x - cx,
      dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) if (inRounded(x, y)) set(x, y, y > s * 0.78 ? bgDark : bg);
  const white = [255, 255, 255];
  const rect = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (inRounded(x, y)) set(x, y, white);
  };
  const t = Math.max(1, Math.round(s * 0.085)); // stroke
  const m = Math.round(s * 0.2); // margin
  const gh = s - 2 * m; // glyph height
  const gw = Math.round(gh * 0.42); // glyph width for each char
  const gap = Math.max(1, Math.round(s * 0.06));
  const xLeft = Math.round(s / 2 - gw - gap / 2);
  // "x": two diagonals approximated by stacked small rectangles
  const steps = gh;
  for (let i = 0; i < steps; i++) {
    const y = m + i;
    const xa = xLeft + Math.round((i / (steps - 1)) * (gw - t));
    const xb = xLeft + (gw - t) - Math.round((i / (steps - 1)) * (gw - t));
    rect(xa, y, t, 1);
    rect(xb, y, t, 1);
  }
  // "3": right column + three horizontal bars
  const x3 = Math.round(s / 2 + gap / 2);
  rect(x3, m, gw, t);
  rect(x3 + Math.round(gw * 0.15), m + Math.round(gh / 2 - t / 2), gw - Math.round(gw * 0.15), t);
  rect(x3, m + gh - t, gw, t);
  rect(x3 + gw - t, m, t, gh);
  return px;
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal deterministic ZIP writer (deflate, fixed timestamp). */
function zip(entries) {
  const locals = [],
    centrals = [];
  let offset = 0;
  const dosTime = 0x0000,
    dosDate = ((2025 - 1980) << 9) | (1 << 5) | 1; // 2025-01-01 00:00
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

// ================================================================ main
// ---------------------------------------------------------------- 1. remaining targets
if (!fs.existsSync(path.join(dist, 'sidepanel.html'))) throw new Error('dist/sidepanel.html missing: run `vite build` first');
for (const target of ['options', 'background', 'content']) {
  await build({ ...makeConfig(target, { emptyOutDir: false }), configFile: false, logLevel: 'warn' });
}

// ---------------------------------------------------------------- 2. manifest
const store = process.argv.includes('--store');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// package.json is the single source of the version. A copy in src/manifest.json would be
// overwritten here and silently drift, so the one that matters is the one nobody edits by hand.
if (manifest.version) throw new Error('src/manifest.json must not declare "version": bump it in package.json instead');
manifest.version = pkg.version;
// The Chrome Web Store lists every optional origin on the install prompt. localhost is only ever
// useful to someone running the control plane on their own machine from an unpacked build.
if (store) manifest.optional_host_permissions = (manifest.optional_host_permissions ?? []).filter((o) => !o.includes('localhost'));
fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// sanity: every referenced file must exist
const refs = [
  manifest.side_panel.default_path,
  manifest.options_page,
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((c) => c.js),
  ...Object.values(manifest.icons),
];

// ---------------------------------------------------------------- 3. icons
fs.mkdirSync(path.join(dist, 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) fs.writeFileSync(path.join(dist, 'icons', `icon-${size}.png`), encodePng(size, size, drawIcon(size)));
for (const r of refs) if (!fs.existsSync(path.join(dist, r))) throw new Error(`manifest references missing file: ${r}`);

// ---------------------------------------------------------------- 4. zip
fs.mkdirSync(releaseDir, { recursive: true });
const files = walk(dist).sort();
const zipName = store ? `sf-claws-store-${manifest.version}.zip` : 'sf-claws.zip';
fs.writeFileSync(path.join(releaseDir, zipName), zip(files.map((f) => ({ name: path.relative(dist, f).split(path.sep).join('/'), data: fs.readFileSync(f) }))));
console.log(`extension: dist/ ready (${files.length} files), release/${zipName} written (v${manifest.version})`);
