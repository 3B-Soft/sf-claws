/**
 * Chrome Web Store collateral: the five listing screenshots (1280x800), the small promo tile
 * (440x280) and the marquee tile (1400x560).
 *
 * The product shots are the real ones from tools/screenshots.mjs — this only frames them and adds
 * the captions the store listing needs. Nothing here draws a UI that does not exist: if a panel
 * screenshot is missing the run fails rather than inventing a picture of the product.
 *
 *   bun tools/demo-server.mjs --port 8799 > /tmp/demo.json &
 *   bun tools/screenshots.mjs --demo /tmp/demo.json --out docs/screenshots
 *   bun tools/store-assets.mjs --shots docs/screenshots --out docs/store
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const shotsDir = path.resolve(arg('shots', 'docs/screenshots'));
const outDir = path.resolve(arg('out', 'docs/store'));
const iconPath = path.resolve('packages/extension/src/icons/icon-128.png');
fs.mkdirSync(outDir, { recursive: true });

const asUrl = (p) => {
  if (!fs.existsSync(p)) throw new Error(`missing source image: ${p} (run tools/screenshots.mjs first)`);
  return `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
};

const BRAND = '#00ca72'; // 3B green: the accent, never behind white text
const BRAND_DEEP = '#007c44'; // green that is dark enough to read as text on a light ground
const BRAND_DARKEST = '#002d18';
const INK = '#0B1B2B';
const MUTED = '#4A5D70';

const base = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Liberation Sans','DejaVu Sans',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  .frame{position:relative;overflow:hidden;background:#F1F9F5}
  .frame::after{content:'';position:absolute;inset:0;background:
    radial-gradient(1100px 520px at 88% -12%, rgba(0,202,114,.20), transparent 60%),
    radial-gradient(760px 420px at -8% 108%, rgba(0,124,68,.13), transparent 62%)}
  .inner{position:relative;z-index:1;height:100%;display:flex;align-items:center;gap:56px;padding:0 64px}
  .copy{flex:1;max-width:560px}
  .eyebrow{display:inline-flex;align-items:center;gap:9px;font-size:15px;font-weight:700;
    letter-spacing:.10em;text-transform:uppercase;color:${BRAND_DEEP};margin-bottom:20px}
  .eyebrow img{width:26px;height:26px}
  h1{font-size:46px;line-height:1.1;color:${INK};letter-spacing:-.022em;font-weight:700}
  p.sub{margin-top:20px;font-size:21px;line-height:1.48;color:${MUTED}}
  ul{margin-top:26px;list-style:none;display:flex;flex-direction:column;gap:13px}
  li{font-size:17px;color:${INK};display:flex;gap:11px;align-items:flex-start;line-height:1.4}
  li::before{content:'';flex:none;width:8px;height:8px;border-radius:50%;background:${BRAND};margin-top:8px}
  .shot{flex:none;border-radius:16px;overflow:hidden;background:#fff;
    box-shadow:0 26px 60px rgba(3,28,54,.22),0 0 0 1px rgba(3,28,54,.09)}
  .shot img{display:block}
  .wide .inner{flex-direction:column;align-items:stretch;justify-content:center;gap:26px;padding:52px 64px}
  .wide .copy{max-width:none}
  .wide h1{font-size:38px}
  .wide .shot{align-self:center}
`;

/** A listing screenshot with the panel upright beside the copy. */
function portraitSlide({ icon, title, sub, bullets, shot, shotH }) {
  return `<style>${base}</style>
  <div class="frame" style="width:1280px;height:800px">
    <div class="inner">
      <div class="copy">
        <div class="eyebrow"><img src="${icon}" alt=""/>SF Claws</div>
        <h1>${title}</h1>
        <p class="sub">${sub}</p>
        <ul>${bullets.map((b) => `<li>${b}</li>`).join('')}</ul>
      </div>
      <div class="shot"><img src="${shot}" style="height:${shotH}px;width:auto"/></div>
    </div>
  </div>`;
}

/** A listing screenshot for the landscape admin console shots. */
function wideSlide({ icon, title, sub, shot, shotH }) {
  return `<style>${base}</style>
  <div class="frame wide" style="width:1280px;height:800px">
    <div class="inner">
      <div class="copy">
        <div class="eyebrow"><img src="${icon}" alt=""/>SF Claws</div>
        <h1>${title}</h1>
        <p class="sub">${sub}</p>
      </div>
      <div class="shot"><img src="${shot}" style="height:${shotH}px;width:auto"/></div>
    </div>
  </div>`;
}

function promoTile({ icon, w, h, title, sub, shot }) {
  const big = w > 600;
  return `<style>${base}</style>
  <div style="width:${w}px;height:${h}px;position:relative;overflow:hidden;
       background:linear-gradient(118deg,${BRAND_DARKEST} 0%,#00542f 54%,${BRAND_DEEP} 84%,${BRAND} 100%)">
    <div style="position:absolute;inset:0;background:radial-gradient(520px 240px at 94% 126%,rgba(0,202,114,.30),transparent 62%)"></div>
    <div style="position:relative;z-index:1;height:100%;display:flex;align-items:center;
         gap:${big ? 52 : 22}px;padding:0 ${big ? 62 : 30}px">
      <div style="flex:1">
        <div style="display:flex;align-items:center;gap:${big ? 16 : 11}px;margin-bottom:${big ? 20 : 12}px">
          <img src="${icon}" style="width:${big ? 62 : 42}px;height:${big ? 62 : 42}px"/>
          <div style="font-size:${big ? 46 : 31}px;font-weight:700;color:#fff;letter-spacing:-.02em">SF Claws</div>
        </div>
        <div style="font-size:${big ? 27 : 16}px;line-height:1.34;color:#fff;font-weight:600">${title}</div>
        <div style="font-size:${big ? 19 : 13}px;line-height:1.45;color:rgba(255,255,255,.93);margin-top:${big ? 14 : 8}px">${sub}</div>
      </div>
      ${
        shot
          ? `<div style="flex:none;border-radius:14px;overflow:hidden;box-shadow:0 20px 44px rgba(0,0,0,.34)">
               <img src="${shot}" style="height:${h - 70}px;width:auto;display:block"/></div>`
          : ''
      }
    </div>
  </div>`;
}

const icon = asUrl(iconPath);
const panel = asUrl(path.join(shotsDir, '01-side-panel.png'));
const changes = asUrl(path.join(shotsDir, '02-panel-changes.png'));
const explore = asUrl(path.join(shotsDir, '03-panel-explore.png'));
const policy = asUrl(path.join(shotsDir, '07-admin-policy.png'));
const detail = asUrl(path.join(shotsDir, '09-admin-session-detail.png'));

const ASSETS = [
  {
    name: 'screenshot-1-panel',
    w: 1280,
    h: 800,
    html: portraitSlide({
      icon,
      shot: panel,
      shotH: 690,
      title: 'Salesforce admin work, in the side panel',
      sub: 'Describe a change in plain language. The agent investigates your org, plans the work and shows you every step.',
      bullets: [
        'Follows the tab you are on, so it already knows the object and record',
        'Plans before it builds, and the plan is yours to approve',
        'Nothing reaches the org until you confirm it',
      ],
    }),
  },
  {
    name: 'screenshot-2-changes',
    w: 1280,
    h: 800,
    html: portraitSlide({
      icon,
      shot: changes,
      shotH: 690,
      title: 'Every change as a diff, before it is deployed',
      sub: 'Staged metadata is validated against the org with a check-only deploy. You read the diff, then decide.',
      bullets: [
        'Validate, deploy and commit are three separate, explicit steps',
        'Deploys need a clean validation first',
        'Commit the same change set to your GitHub repository',
      ],
    }),
  },
  {
    name: 'screenshot-3-explore',
    w: 1280,
    h: 800,
    html: portraitSlide({
      icon,
      shot: explore,
      shotH: 690,
      title: 'Query and browse the org without leaving the tab',
      sub: 'A visual SOQL builder and a metadata browser that renders flows, objects and layouts as something readable.',
      bullets: ['Build a query by picking fields and filters', 'Raw SOQL and XML are one toggle away', 'Copy results straight out as CSV'],
    }),
  },
  {
    name: 'screenshot-4-audit',
    w: 1280,
    h: 800,
    html: wideSlide({
      icon,
      shot: detail,
      shotH: 500,
      title: 'Every tool call, every result, every token',
      sub: 'Each session is recorded end to end on your own server, so an admin can see exactly what an agent did and what it cost.',
    }),
  },
  {
    name: 'screenshot-5-policy',
    w: 1280,
    h: 800,
    html: wideSlide({
      icon,
      shot: policy,
      shotH: 500,
      title: 'You decide what agents are allowed to touch',
      sub: 'Permission rules, spend ceilings and approval gates are set per client and per org, and they cannot be widened from a chat.',
    }),
  },
  {
    name: 'promo-small-440x280',
    w: 440,
    h: 280,
    html: promoTile({ icon, w: 440, h: 280, title: 'Agentic Salesforce admin assistant', sub: 'Plan, build, validate and deploy from a side panel.' }),
  },
  {
    name: 'promo-marquee-1400x560',
    w: 1400,
    h: 560,
    html: promoTile({
      icon,
      w: 1400,
      h: 560,
      shot: panel,
      title: 'Salesforce admin work, in the side panel',
      sub: 'Describe the change. Review the plan and the diff. Nothing reaches your org until you approve it.',
    }),
  },
];

const executablePath = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
for (const a of ASSETS) {
  const page = await browser.newPage({ viewport: { width: a.w, height: a.h }, deviceScaleFactor: 1 });
  await page.setContent(a.html, { waitUntil: 'load' });
  await page.waitForTimeout(350);
  const file = path.join(outDir, `${a.name}.png`);
  await page.screenshot({ path: file });
  await page.close();
  console.log(`  ${path.relative(process.cwd(), file)}  ${a.w}x${a.h}`);
}
// The store icon is the one the extension ships, copied so the listing assets sit in one folder.
fs.copyFileSync(iconPath, path.join(outDir, 'store-icon-128.png'));
console.log(`  ${path.relative(process.cwd(), path.join(outDir, 'store-icon-128.png'))}  128x128`);
await browser.close();
