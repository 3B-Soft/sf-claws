import lwcRollup from '@lwc/rollup-plugin';
import fs from 'node:fs';

const TPL = '?lwc-tpl';
const STYLE = '\0lwcstyle:';
const encStyle = (id) => STYLE + id.replace(/\.css(\?|$)/, '.lwcstyle$1');
const decStyle = (vid) => vid.slice(STYLE.length).replace(/\.lwcstyle(\?|$)/, '.css$1');

/**
 * Vite plugin wrapping @lwc/rollup-plugin so it only handles LWC modules under `modulesDir`,
 * the `lwc` runtime and component-scoped stylesheets. Component templates get a `?lwc-tpl`
 * suffix and component css a virtual id so Vite's own HTML/CSS pipelines ignore them.
 * Global Tailwind css is imported from the app entry (outside modulesDir) and handled by Vite.
 *
 * All components must use light DOM (`static renderMode = 'light'` + `<template lwc:render-mode="light">`)
 * so Tailwind utility classes apply.
 */
export function lwcVite({ modulesDir, externalPrefixes = ['@sf-claws/'] }) {
  const inner = lwcRollup({ rootDir: modulesDir, modules: [{ dir: modulesDir }] });
  const isLwcId = (id) => !!id && (id.startsWith(modulesDir) || id === 'lwc' || id.startsWith('@lwc/') || /^[a-z][a-zA-Z0-9]*\/[a-zA-Z0-9]+$/.test(id));
  const isExternal = (s) => externalPrefixes.some((p) => s.startsWith(p));
  const cleanImporter = (imp) => {
    if (!imp) return imp;
    if (imp.endsWith(TPL)) return imp.slice(0, -TPL.length);
    if (imp.startsWith(STYLE)) return decStyle(imp);
    return imp;
  };
  return {
    name: 'scoped-lwc',
    enforce: 'pre',
    buildStart(opts) {
      return inner.buildStart?.call(this, opts);
    },
    async resolveId(source, importer, opts) {
      const imp = cleanImporter(importer);
      const fromLwc = imp && (imp.startsWith(modulesDir) || imp.startsWith('@lwc/'));
      if (!(isLwcId(source) || (fromLwc && !isExternal(source) && !source.startsWith('/') && !source.startsWith('.')))) {
        // relative imports inside a component folder (e.g. './utils.js') should still be handled by inner
        if (!(fromLwc && (source.startsWith('.') || source.endsWith('.css')))) return null;
      }
      const r = await inner.resolveId.call(this, source, imp, opts);
      const id = typeof r === 'string' ? r : r?.id;
      if (!id) return r;
      if (id.startsWith(modulesDir) && id.endsWith('.html')) return id + TPL;
      if (/\.css(\?|$)/.test(id) && (id.startsWith(modulesDir) || id.includes('@lwc/resources'))) return encStyle(id);
      return r;
    },
    load(id) {
      if (id.endsWith(TPL)) return fs.readFileSync(id.slice(0, -TPL.length), 'utf8');
      if (id.startsWith(STYLE)) return inner.load.call(this, decStyle(id));
      return isLwcId(id) ? inner.load.call(this, id) : null;
    },
    transform(code, id) {
      let clean = id;
      if (id.endsWith(TPL)) clean = id.slice(0, -TPL.length);
      else if (id.startsWith(STYLE)) clean = decStyle(id);
      else if (!id.startsWith(modulesDir)) return null;
      return inner.transform.call(this, code, clean);
    },
  };
}
