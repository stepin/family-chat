import { defineConfig, devices } from '@playwright/test';

// The search measurement (`pnpm test:e2e:perf`): 50 000 messages in Chromium's
// IndexedDB, index build time, query times, storage size. It needs no server
// and is kept out of the default run (playwright.config.ts ignores *.perf.spec.ts).
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.perf.spec.ts',
  timeout: 10 * 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
