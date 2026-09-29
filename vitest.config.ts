import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Test workspace packages against their sources, so no build is needed first.
    alias: {
      '@hashspan/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@hashspan/viem': new URL('./packages/viem/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      reporter: ['text-summary'],
      // Just below the current numbers, so coverage cannot drop unnoticed.
      thresholds: { lines: 98, statements: 97, branches: 92, functions: 94 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'examples/*/test/**/*.test.ts'],
          exclude: ['packages/*/test/**/*.int.test.ts', 'examples/*/test/**/*.int.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.int.test.ts', 'examples/*/test/**/*.int.test.ts'],
          testTimeout: 30_000,
          // Starting Anvil in beforeAll can take longer than the default 10 s while the whole suite runs in parallel.
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
