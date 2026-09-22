/**
 * Post-build for the Chrome extension (runs after `vite build`, which produced the side panel):
 *  1. builds the remaining targets with the shared config factory (options page, background
 *     service worker, content script) — one self-contained file each, stable names
 *  2. copies src/manifest.json into dist/ (version from package.json) and checks references
 *     --store: strips the localhost origin dev builds use, so the Web Store upload asks only for
 *     permissions a published user can actually need
 *  3. copies the 3B logo icons (16/32/48/128) from src/icons/ — rendered by tools/render-icons.mjs
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
// The Chrome Web Store lists every optional origin on the install prompt. Plain HTTP is only for
// unpacked development builds, where the control plane may be on localhost or another LAN host.
if (store) manifest.optional_host_permissions = (manifest.optional_host_permissions ?? []).filter((o) => !o.startsWith('http://'));
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
// Committed assets, not drawn here: the icon is the 3B logo, and a build script is the wrong place
// to keep a second, hand-coded copy of a brand mark. Re-render with tools/render-icons.mjs.
fs.mkdirSync(path.join(dist, 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const src = path.join(root, 'src/icons', `icon-${size}.png`);
  if (!fs.existsSync(src)) throw new Error(`missing icon asset: ${src} — run bun tools/render-icons.mjs`);
  fs.copyFileSync(src, path.join(dist, 'icons', `icon-${size}.png`));
}
for (const r of refs) if (!fs.existsSync(path.join(dist, r))) throw new Error(`manifest references missing file: ${r}`);

// ---------------------------------------------------------------- 4. zip
fs.mkdirSync(releaseDir, { recursive: true });
const files = walk(dist).sort();
const zipName = store ? `sf-claws-store-${manifest.version}.zip` : 'sf-claws.zip';
fs.writeFileSync(path.join(releaseDir, zipName), zip(files.map((f) => ({ name: path.relative(dist, f).split(path.sep).join('/'), data: fs.readFileSync(f) }))));
console.log(`extension: dist/ ready (${files.length} files), release/${zipName} written (v${manifest.version})`);
