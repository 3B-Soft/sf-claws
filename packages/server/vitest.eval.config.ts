import { defineConfig } from 'vitest/config';
// Separate from vitest.config.ts on purpose: these call a real model and cost money, so `npm test` never runs them.
export default defineConfig({ test: { include: ['eval/**/*.eval.ts'], testTimeout: 900_000, hookTimeout: 120_000, maxConcurrency: 4 } });
