import { defineConfig, devices } from '@playwright/test';

// The probe is served from http://localhost:4173 (vite preview); the WebDAV
// servers from tools/dav-dev listen on http://127.0.0.1:1808x, i.e. on a
// different origin, as in deployment mode A.
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'pnpm run build && pnpm run preview',
    url: 'http://localhost:4173/probe/',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
