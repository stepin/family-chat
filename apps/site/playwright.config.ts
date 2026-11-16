import { defineConfig, devices } from '@playwright/test';

// Browser checks of the built site (e2e/): accessibility in both themes, the
// keyboard, 360 px, no requests to other sites, and the web client under
// app/. Global setup builds the site (with the client) into dist/.
export const SITE_PORT = Number(process.env['SITE_E2E_PORT'] ?? 4181);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-site' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  webServer: {
    command: `node serve.mjs dist ${SITE_PORT}`,
    url: `http://127.0.0.1:${SITE_PORT}/`,
    reuseExistingServer: false,
  },
  use: {
    // The app picks its language from the browser; the tests find controls by their Russian names.
    // English is covered by e2e/english.spec.ts, which asks for en-US itself.
    locale: 'ru-RU',
    baseURL: `http://127.0.0.1:${SITE_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
