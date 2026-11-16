import { defineConfig, devices } from '@playwright/test';
import { MEDIA_ARGS } from './playwright.config.ts';

// The slow end-to-end tests (`pnpm test:e2e:big`): a 200 MB file sent and
// received byte for byte, with the browser's memory measured on the way.
// Kept out of the default run (playwright.config.ts ignores *.big.spec.ts).
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.big.spec.ts',
  timeout: 30 * 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  reporter: 'list',
  globalSetup: './e2e/support/global-setup.ts',
  // Russian interface (the tests use Russian names).
  use: { trace: 'off', locale: 'ru-RU' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: MEDIA_ARGS } } }],
});
