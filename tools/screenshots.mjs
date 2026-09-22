/**
 * Screenshots of the real SF Claws UI, driven through a browser against the real server.
 *
 * Nothing is mocked at the rendering layer: the side panel and the admin console are the built
 * artefacts, talking to the control plane started by tools/demo-server.mjs over HTTP and SSE. The
 * panel runs as a plain page here (it detects the absence of `chrome` and falls back to
 * localStorage), which is the same code path the extension uses minus the tab plumbing.
 *
 *   bun tools/demo-server.mjs --port 8799 > /tmp/demo.json &
 *   bun tools/screenshots.mjs --demo /tmp/demo.json --out docs/screenshots
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const demo = JSON.parse(fs.readFileSync(arg('demo', '/tmp/demo.json'), 'utf8'));
const outDir = path.resolve(arg('out', 'docs/screenshots'));
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- static hosts
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve(root, port) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(root, rel === '/' ? '/index.html' : rel);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

const extRoot = path.resolve('packages/extension/dist');
const adminRoot = path.resolve('packages/admin-ui/dist');
for (const [name, dir] of [
  ['extension', extRoot],
  ['admin-ui', adminRoot],
])
  if (!fs.existsSync(path.join(dir, name === 'extension' ? 'sidepanel.html' : 'index.html')))
    throw new Error(`${name} is not built: run bun run --filter @sf-claws/${name} build`);
const panelServer = await serve(extRoot, 8801);
const adminServer = await serve(adminRoot, 8802);

// ---------------------------------------------------------------- browser
// The environment ships one Chromium at a fixed path; point at it rather than downloading another.
const executablePath = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const shots = [];

/** Seed the panel's storage the way the options page would, then load it. */
async function panelPage({ width = 420, height = 900 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: 'dark' });
  await page.addInitScript(
    ([url, token, user]) => {
      localStorage.setItem('sfclaws.storage.sync', JSON.stringify({ serverUrl: url, uiMode: 'visual' }));
      localStorage.setItem('sfclaws.storage.local', JSON.stringify({ token, user }));
    },
    [demo.url, demo.token, { id: 'demo', email: demo.email, displayName: 'Dana Okafor', role: 'superadmin', status: 'active' }],
  );
  return page;
}
async function adminPage(hash, { width = 1440, height = 950 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: 'dark' });
  await page.addInitScript(
    ([url, token]) => {
      localStorage.setItem('sfclaws.apiBase', url);
      localStorage.setItem('sfclaws.token', token);
    },
    [demo.url, demo.token],
  );
  await page.goto(`http://localhost:8802/#${hash}`, { waitUntil: 'networkidle' });
  return page;
}

async function shot(page, name, caption) {
  await page.waitForTimeout(900);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  shots.push({ name, caption, file });
  process.stdout.write(`  ${path.relative(process.cwd(), file)}  — ${caption}\n`);
}

const PANEL_URL = `http://localhost:8801/sidepanel.html?sfUrl=${encodeURIComponent(
  'https://northwind--uat.sandbox.my.salesforce.com/lightning/o/Contract/list',
)}`;

/** Open the panel and click through to the seeded session, the way a user would. */
async function openSession() {
  const page = await panelPage();
  await page.goto(PANEL_URL, { waitUntil: 'networkidle' });
  await page.getByText('Add a renewal date to Contract').click();
  await page.waitForTimeout(1200);
  return page;
}

// 1. The side panel mid-task, with the deploy confirmation open.
{
  const page = await openSession();
  await shot(page, '01-side-panel', 'The side panel: a staged change, validated, waiting for the user to confirm the deploy');
  await page.close();
}

// 1b-1d. The other panel tabs on the same session.
for (const [name, tab, caption] of [
  ['02-panel-changes', 'Changes', 'Every staged change as a diff, before anything reaches the org'],
  ['03-panel-explore', 'Explore', 'Browse and query the org without leaving the panel'],
]) {
  const page = await openSession();
  await page
    .getByRole('button', { name: tab, exact: true })
    .click()
    .catch(() => page.getByText(tab, { exact: true }).first().click());
  await page.waitForTimeout(600);
  // Expand the first row so the diff itself is visible, not just the file list.
  await page
    .getByText('Contract.NW_Ren', { exact: false })
    .first()
    .click()
    .catch(() => {});
  await shot(page, name, caption);
  await page.close();
}

// 2-6. The admin console.
for (const [name, hash, caption] of [
  ['04-admin-dashboard', '/', 'Admin console: what every client and every session is doing'],
  ['05-admin-sessions', '/sessions', 'Every session, with what it cost and how it ended'],
  ['06-admin-instructions', `/clients/${demo.clientId}?tab=instructions`, 'Standing instructions: a CLAUDE.md per client and per org, read on every session'],
  ['07-admin-policy', `/clients/${demo.clientId}?tab=policy`, 'Permission rules: what agents may attempt, scoped to what they may touch'],
  ['08-admin-usage', '/ai', 'Model bindings per agent role, with per-role spend'],
]) {
  const page = await adminPage(hash);
  await shot(page, name, caption);
  await page.close();
}

// 7. A session's audit trail, as a super admin sees it.
{
  const page = await adminPage(`/sessions/${demo.sessionId}`);
  await shot(page, '09-admin-session-detail', 'One session end to end: every tool call, every result, every token');
  await page.close();
}

await browser.close();
panelServer.close();
adminServer.close();

fs.writeFileSync(
  path.join(outDir, 'README.md'),
  `# Screenshots\n\nGenerated by \`tools/screenshots.mjs\` against a real server (\`tools/demo-server.mjs\`) with seeded data.\nRegenerate rather than editing: they should never drift from the UI they document.\n\n${shots
    .map((s) => `### ${s.caption}\n\n![${s.caption}](${s.name}.png)\n`)
    .join('\n')}`,
);
process.stdout.write(`\n${shots.length} screenshots in ${path.relative(process.cwd(), outDir)}\n`);
