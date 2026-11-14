import { defineConfig, devices } from '@playwright/test';

// End-to-end tests of the chat client against a real `fcd` (server/). Every
// spec file starts its own fcd on a temporary data folder (e2e/support/fcd.ts);
// the client is the copy fcd serves from apps/web/dist. Global setup builds
// both unless FCD_BIN points to a ready binary.
/**
 * Voice messages: Chromium's fake microphone, permission prompts answered
 * "allow". On macOS the fake audio device hangs audio capture and stalls
 * every AudioContext in this Chromium build, so it is left out there and
 * e2e/support/m3.ts (MIC_SHIM) feeds a generated tone instead.
 */
export const MEDIA_ARGS =
  process.platform === 'darwin'
    ? ['--use-fake-ui-for-media-stream']
    : ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

export default defineConfig({
  testDir: './e2e',
  // The 200 MB round trip is slow: it runs with `pnpm test:e2e:big` (playwright.big.config.ts).
  // The search measurement on 50 000 messages runs with `pnpm test:e2e:perf` (playwright.perf.config.ts).
  testIgnore: ['**/*.big.spec.ts', '**/*.perf.spec.ts'],
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
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: MEDIA_ARGS },
      },
    },
  ],
});
