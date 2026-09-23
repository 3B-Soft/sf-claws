import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lwcVite } from '../../tools/vite-lwc-plugin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const certs = { key: path.resolve(here, 'certs/localhost-key.pem'), cert: path.resolve(here, 'certs/localhost.pem') };
// Local HTTPS certs are gitignored; only the dev server needs them, so builds (and CI) skip them.
const https =
  fs.existsSync(certs.key) && fs.existsSync(certs.cert) ? { key: fs.readFileSync(certs.key), cert: fs.readFileSync(certs.cert), allowHTTP1: true } : undefined;

export default defineConfig({
  plugins: [tailwindcss(), lwcVite({ modulesDir: path.resolve(here, 'src/modules') })],
  resolve: { alias: { '@sf-claws/shared': path.resolve(here, '../shared/dist/index.js') } },
  server: {
    https,
    port: 5173,
    proxy: { '/api': 'http://localhost:8787', '/oauth': 'http://localhost:8787' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
