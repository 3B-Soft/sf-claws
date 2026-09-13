/**
 * Contrast audit. A theme flip breaks text in ways a screenshot review misses — a label that went
 * from #94a3b8 on #0f172a to #94a3b8 on #ffffff is still there, just unreadable. This walks every
 * rendered text node, resolves the first opaque ancestor background, and reports anything under
 * the WCAG AA threshold for its size.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const demo = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--demo') + 1] || '/tmp/demo.json', 'utf8'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
function serve(root, port) {
  const s = http.createServer((req, res) => {
    const rel = new URL(req.url, 'http://x').pathname;
    let f = path.join(root, rel === '/' ? '/index.html' : rel);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
    if (!fs.existsSync(f)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => s.listen(port, () => r(s)));
}
const panelServer = await serve(path.resolve('packages/extension/dist'), 8811);
const adminServer = await serve(path.resolve('packages/admin-ui/dist'), 8812);

const AUDIT = () => {
  const lum = ([r, g, b]) => {
    const f = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = (s) => (s.match(/[\d.]+/g) || []).map(Number);
  const over = (fg, bg) => fg.slice(0, 3).map((c, i) => c * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  /** The first ancestor that actually paints, composited down to an opaque colour. */
  const bgOf = (el) => {
    const stack = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c.length && (c[3] ?? 1) > 0) {
        stack.push(c);
        if ((c[3] ?? 1) === 1) break;
      }
    }
    stack.push([255, 255, 255, 1]);
    return stack.reverse().reduce((acc, c) => over(c, acc));
  };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const text = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ')
      .trim();
    if (!text) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.3) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    const c = ratio(over(parse(cs.color), bgOf(el)), bgOf(el));
    if (c < need)
      out.push({ text: text.slice(0, 60), color: cs.color, size, need, ratio: Math.round(c * 100) / 100, cls: (el.className || '').toString().slice(0, 90) });
  }
  return out;
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const seen = new Map();
async function audit(label, url, seed) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(seed[0], seed[1]);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  if (label === 'panel') {
    await page
      .getByText('Add a renewal date to Contract')
      .click()
      .catch(() => {});
    await page.waitForTimeout(1200);
  }
  for (const f of await page.evaluate(AUDIT)) {
    const key = `${f.cls}|${f.color}`;
    if (!seen.has(key)) seen.set(key, { ...f, where: label, count: 0 });
    seen.get(key).count++;
  }
  await page.close();
}
const adminSeed = [
  ([u, t]) => {
    localStorage.setItem('sfclaws.apiBase', u);
    localStorage.setItem('sfclaws.token', t);
  },
  [demo.url, demo.token],
];
const panelSeed = [
  ([u, t, usr]) => {
    localStorage.setItem('sfclaws.storage.sync', JSON.stringify({ serverUrl: u, uiMode: 'visual' }));
    localStorage.setItem('sfclaws.storage.local', JSON.stringify({ token: t, user: usr }));
  },
  [demo.url, demo.token, { id: 'demo', email: demo.email, displayName: 'Dana Okafor', role: 'superadmin', status: 'active' }],
];

await audit(
  'panel',
  `http://localhost:8811/sidepanel.html?sfUrl=${encodeURIComponent('https://northwind--uat.sandbox.my.salesforce.com/lightning/o/Contract/list')}`,
  panelSeed,
);
for (const [name, hash] of [
  ['dashboard', '/'],
  ['sessions', '/sessions'],
  ['clients', '/clients'],
  ['instructions', `/clients/${demo.clientId}?tab=instructions`],
  ['policy', `/clients/${demo.clientId}?tab=policy`],
  ['orgs', `/clients/${demo.clientId}?tab=orgs`],
  ['ai', '/ai'],
  ['usage', '/usage'],
  ['users', '/users'],
  ['skills', '/skills'],
  ['knowledge', '/knowledge'],
  ['audit', '/audit'],
  ['settings', '/settings'],
  ['session', `/sessions/${demo.sessionId}`],
])
  await audit(name, `http://localhost:8812/#${hash}`, adminSeed);

await browser.close();
panelServer.close();
adminServer.close();
const rows = [...seen.values()].sort((a, b) => a.ratio - b.ratio);
if (!rows.length) process.stdout.write('No contrast failures.\n');
for (const r of rows)
  process.stdout.write(`${String(r.ratio).padStart(5)} (need ${r.need})  ${r.where.padEnd(12)} ${r.color.padEnd(22)} "${r.text}"\n    ${r.cls}\n`);
process.stdout.write(`\n${rows.length} distinct failing styles\n`);
