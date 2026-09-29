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
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: ['packages/*/test/**/*.int.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.int.test.ts', 'examples/*/test/**/*.int.test.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
