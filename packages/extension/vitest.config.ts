import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    // Bun's CJS interop does not expose Zod's named exports through Vitest's loader.
    server: { deps: { inline: ['zod'] } },
  },
});
