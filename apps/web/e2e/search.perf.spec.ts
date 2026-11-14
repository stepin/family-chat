// The local search on 50 000 messages in Chromium (docs/PLAN.md 7.2): how
// long the index takes to build (fresh sync and the upgrade of an old
// database), how long queries take, whether the page keeps drawing frames
// meanwhile, and how much storage the index costs. Not in the default run:
// `pnpm test:e2e:perf`. Prints one JSON line with the numbers.

import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

test('search on 50 000 messages', async ({ page }) => {
  const entry = fileURLToPath(new URL('./perf/search-entry.ts', import.meta.url));
  const out = await build({
    configFile: false,
    logLevel: 'warn',
    build: { write: false, minify: true, lib: { entry, formats: ['iife'], name: 'perf', fileName: () => 'perf.js' } },
  });
  const chunk = (Array.isArray(out) ? out[0]! : out) as { output: { type: string; code?: string }[] };
  const code = chunk.output.find((o) => o.type === 'chunk')!.code!;
  await page.route('http://localhost:59321/**', (route) =>
    route.fulfill(
      route.request().url().endsWith('/perf.js')
        ? { contentType: 'text/javascript', body: code }
        : { contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><script src="/perf.js"></script>' },
    ),
  );
  // localhost is a secure context (navigator.storage); nothing listens there, the route answers.
  await page.goto('http://localhost:59321/');
  const result = await page.evaluate(() => (globalThis as unknown as { perfRun: (n: number) => Promise<unknown> }).perfRun(50_000));
  console.log(JSON.stringify(result));
  expect((result as { upgradedHits: number }).upgradedHits).toBe(1);
});
