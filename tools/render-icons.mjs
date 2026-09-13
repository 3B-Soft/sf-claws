/**
 * Rasterise the 3B logo into the extension's icon set.
 *
 * The build must not depend on a browser, so the PNGs are committed next to the SVG and
 * scripts/postbuild.mjs only copies them. Run this when the logo changes, and commit the result:
 *
 *   node tools/render-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const iconDir = path.resolve('packages/extension/src/icons');
const svg = fs.readFileSync(path.join(iconDir, 'logo.svg'), 'utf8');
const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const executablePath = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;width:${size}px;height:${size}px}
     img{display:block;width:${size}px;height:${size}px}</style><img src="${dataUrl}"/>`,
    { waitUntil: 'load' },
  );
  await page.waitForTimeout(150);
  // Transparent: the toolbar and the store both composite the icon on their own background.
  await page.screenshot({ path: path.join(iconDir, `icon-${size}.png`), omitBackground: true });
  await page.close();
  console.log(`  packages/extension/src/icons/icon-${size}.png  ${size}x${size}`);
}
await browser.close();
