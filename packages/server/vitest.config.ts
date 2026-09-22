import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
    // Keep Bun built-ins native and avoid Zod's CJS named-export interop path.
    server: { deps: { external: [/^bun:/], inline: ['zod'] } },
  },
});
