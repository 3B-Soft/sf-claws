import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lwcVite } from '../../tools/vite-lwc-plugin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [tailwindcss(), lwcVite({ modulesDir: path.resolve(here, 'src/modules') })],
  resolve: { alias: { '@sf-claws/shared': path.resolve(here, '../shared/dist/index.js') } },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787', '/oauth': 'http://localhost:8787' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
