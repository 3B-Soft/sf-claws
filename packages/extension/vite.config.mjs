import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lwcVite } from '../../tools/vite-lwc-plugin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, 'dist');

/**
 * Chrome extension build. Every entry is bundled on its own so each output is ONE
 * self-contained file with a stable name (no shared chunks):
 *
 *   sidepanel  -> dist/sidepanel.html + dist/assets/sidepanel.js|css   (IIFE, classic script)
 *   options    -> dist/options.html   + dist/assets/options.js|css     (IIFE, classic script)
 *   background -> dist/background.js                                   (ES module service worker)
 *   content    -> dist/content.js                                      (IIFE; content scripts can't be modules)
 *
 * Classic scripts (not `type="module"`, no `crossorigin`) let the built pages also run from
 * file:// for dev/testing, and keep the manifest CSP (`script-src 'self'`) happy — no inline JS.
 *
 * `vite build` builds the side panel (the default target); scripts/postbuild.mjs runs the other
 * targets through the same factory, then copies the manifest, draws the icons and zips a release.
 */
export const TARGETS = {
  sidepanel: {
    input: path.resolve(here, 'sidepanel.html'),
    format: 'iife',
    entryFileNames: 'assets/sidepanel.js',
    assetFileNames: 'assets/sidepanel[extname]',
    html: true,
  },
  options: {
    input: path.resolve(here, 'options.html'),
    format: 'iife',
    entryFileNames: 'assets/options.js',
    assetFileNames: 'assets/options[extname]',
    html: true,
  },
  background: { input: path.resolve(here, 'src/background.js'), format: 'es', entryFileNames: 'background.js', assetFileNames: 'assets/[name][extname]' },
  content: {
    input: path.resolve(here, 'src/content.js'),
    format: 'iife',
    entryFileNames: 'content.js',
    assetFileNames: 'assets/[name][extname]',
    name: 'sfClawsContent',
  },
};

/** Vite emits `<script type="module" crossorigin>`; rewrite to a classic deferred script (IIFE bundle). */
function classicHtml() {
  return {
    name: 'sf-claws-classic-html',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => html.replace(/<script type="module" crossorigin src=/g, '<script defer src=').replace(/ crossorigin(?=[ >])/g, ''),
    },
  };
}

export function makeConfig(target = 'sidepanel', { emptyOutDir = target === 'sidepanel' } = {}) {
  const t = TARGETS[target];
  if (!t) throw new Error(`unknown build target: ${target}`);
  return defineConfig({
    root: here,
    base: './',
    plugins: t.html ? [tailwindcss(), lwcVite({ modulesDir: path.resolve(here, 'src/modules') }), classicHtml()] : [],
    resolve: { alias: { '@sf-claws/shared': path.resolve(here, '../shared/dist/index.js') } },
    build: {
      outDir: dist,
      emptyOutDir,
      target: 'chrome120',
      modulePreload: { polyfill: false },
      cssCodeSplit: false,
      minify: true,
      sourcemap: false,
      rollupOptions: {
        input: t.input,
        output: {
          format: t.format,
          name: t.name,
          entryFileNames: t.entryFileNames,
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: t.assetFileNames,
          inlineDynamicImports: true,
        },
      },
    },
  });
}

export default makeConfig(process.env.SF_CLAWS_TARGET || 'sidepanel');
