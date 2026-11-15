import { defineConfig, devices } from '@playwright/test';

// End-to-end test against a real `fcd` (server/) on a temporary data folder.
// The client is the copy embedded into the binary, opened from the server's
// own address. See e2e-fcd/global-setup.ts.
export const FCD_PORT = Number(process.env['FCD_E2E_PORT'] ?? 18788);

export default defineConfig({
  testDir: './e2e-fcd',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-fcd' }]] : 'list',
  globalSetup: './e2e-fcd/global-setup.ts',
  use: {
    // M7: the app picks its language from the browser; the tests find controls by their Russian names.
    // English is covered by e2e/english.spec.ts, which asks for en-US itself.
    locale: 'ru-RU',
    baseURL: `http://127.0.0.1:${FCD_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
