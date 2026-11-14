import { defineConfig } from 'vitest/config';

// Runs the core against a real `fcd` process (server/) on temporary data
// folders. `pnpm test:integration` builds the binary first (scripts/build-fcd.mjs);
// set FCD_BIN to use a ready one.
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    setupFiles: ['test/support/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
