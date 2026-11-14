import { defineConfig, devices } from '@playwright/test';

// End-to-end tests of the chat client against a real `fcd` (server/). Every
// spec file starts its own fcd on a temporary data folder (e2e/support/fcd.ts);
// the client is the copy fcd serves from apps/web/dist. Global setup builds
// both unless FCD_BIN points to a ready binary.
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/support/global-setup.ts',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
