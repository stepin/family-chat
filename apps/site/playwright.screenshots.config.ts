import { defineConfig, devices } from '@playwright/test';

// Screenshots of the app for the site (e2e-shots/). Uses the end-to-end
// helpers of apps/web: global setup builds the client and fcd unless FCD_BIN
// points to a ready binary.
export default defineConfig({
  testDir: './e2e-shots',
  timeout: 300_000,
  workers: 1,
  reporter: 'list',
  globalSetup: '../web/e2e/support/global-setup.ts',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
