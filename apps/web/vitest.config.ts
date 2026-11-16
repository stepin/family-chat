import { defineConfig } from 'vitest/config';

// Node 25+ turns on Web Storage by default: without --localstorage-file,
// touching `localStorage` prints an ExperimentalWarning in every worker and
// yields undefined. Switching it off gives the same undefined, quietly (the app
// code already treats a missing localStorage as "no storage"). Older Node
// versions do not know the flag.
const noWebStorage = process.allowedNodeEnvironmentFlags.has('--no-experimental-webstorage')
  ? ['--no-experimental-webstorage']
  : [];

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    execArgv: noWebStorage,
  },
});
