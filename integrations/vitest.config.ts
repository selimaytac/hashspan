import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // hashspan from its sources, as in the repository's own tests, so no build is needed first.
    alias: {
      '@hashspan/core': new URL('../packages/core/src/index.ts', import.meta.url).pathname,
      '@hashspan/viem': new URL('../packages/viem/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/offline.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
