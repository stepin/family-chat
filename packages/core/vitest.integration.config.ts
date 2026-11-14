import { defineConfig } from 'vitest/config';

// Runs WebDavStorage against the Docker servers from tools/dav-dev
// (start them with `pnpm dav:up`).
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 30_000,
  },
});
