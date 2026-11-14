// The built site in a real browser.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { PAGES } from '../build.mjs';

const VIEWPORTS = [
  { name: 'phone', width: 360, height: 740 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

/** Fails the test on page errors, CSP violations and requests to other origins. */
function guard(page: Page, origin: string): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.protocol !== 'data:' && url.protocol !== 'blob:' && url.origin !== origin) problems.push(`request to ${r.url()}`);
  });
  return problems;
}

for (const p of PAGES) {
  test(`${p.lang} ${p.path || '/'}: accessible in both themes, fits 360 px, nothing from other sites`, async ({ page, baseURL }) => {
    const problems = guard(page, new URL(baseURL!).origin);
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        const res = await page.goto(`/${p.path}`);
        expect(res?.status()).toBe(200);
        await expect(page.locator('h1').first()).toBeVisible();
        // Every image loaded (screenshots, the icon).
        const broken = await page.evaluate(() =>
          [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.currentSrc || i.src),
        );
        // Lazy images below the fold may not have loaded yet; force them.
        if (broken.length > 0) {
          await page.evaluate(() => document.querySelectorAll('img').forEach((i) => (i.loading = 'eager')));
          await page.waitForLoadState('networkidle');
        }
        const stillBroken = await page.evaluate(() =>
          [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.currentSrc || i.src),
        );
        expect(stillBroken, 'images').toEqual([]);
        // No sideways scrolling of the page (wide tables and code scroll inside their own box).
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `horizontal overflow at ${vp.width}px`).toBeLessThanOrEqual(0);
        const axe = await new AxeBuilder({ page }).analyze();
        const bad = axe.violations
          .filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
        expect(bad, `axe ${vp.name} ${scheme}`).toEqual([]);
      }
    }
    expect(problems).toEqual([]);
  });
}

test('keyboard: the skip link comes first and moves focus to the content', async ({ page }) => {
  await page.goto('/install/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Перейти к содержанию' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  // The next Tab lands inside the content, not back in the header.
  await page.keyboard.press('Tab');
  const inMain = await page.evaluate(() => document.querySelector('main')!.contains(document.activeElement));
  expect(inMain).toBe(true);
});

test('keyboard: wide tables and code blocks can be scrolled and are focusable', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/install/');
  const region = page.locator('.table-wrap').first();
  await region.focus();
  await expect(region).toBeFocused();
  await expect(page.locator('pre').first()).toHaveAttribute('tabindex', '0');
});

test('language switch and navigation point to the matching page', async ({ page }) => {
  await page.goto('/family/');
  await expect(page.getByRole('link', { name: 'Для семьи' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('link', { name: 'English' }).click();
  await expect(page).toHaveURL(/\/en\/family\/$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('link', { name: 'Русский' }).click();
  await expect(page).toHaveURL(/\/family\/$/);
});

test('a missing page answers 404 with the site layout', async ({ page }) => {
  const res = await page.goto('/no-such-page/');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
  const base = (process.env['SITE_BASE_PATH'] ?? '/').replace(/\/*$/, '/');
  await expect(page.locator('link[rel="stylesheet"]')).toHaveAttribute('href', `${base}site.css`);
});

test('the web client works from the app/ subpath: assets, manifest and service worker stay inside it', async ({ page, baseURL }) => {
  const problems = guard(page, new URL(baseURL!).origin);
  const violations: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`[csp] ${e.violatedDirective} ${e.blockedURI}`));
  });
  page.on('console', (m) => {
    if (m.text().startsWith('[csp]')) violations.push(m.text());
  });
  await page.goto('/app/');
  await expect(page.getByRole('heading', { name: 'Семейный чат' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Настроить для своей семьи' })).toBeVisible();

  // Every file the client loaded came from /app/.
  const loaded = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname));
  for (const path of loaded) expect(path.startsWith('/app/'), path).toBe(true);

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifestUrl = new URL(manifestHref!, page.url());
  expect(manifestUrl.pathname).toBe('/app/manifest.webmanifest');
  const manifest = (await (await page.request.get(manifestUrl.href)).json()) as { start_url: string; scope: string };
  expect(new URL(manifest.start_url, manifestUrl).pathname).toBe('/app/');
  expect(new URL(manifest.scope, manifestUrl).pathname).toBe('/app/');

  // The service worker registers on load with the app's own scope.
  const scope = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return new URL(reg.scope).pathname;
  });
  expect(scope).toBe('/app/');

  // The site pages stay outside the worker's reach.
  await page.goto('/');
  const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
  expect(controlled).toBe(false);
  expect(violations).toEqual([]);
  expect(problems.filter((p) => !p.startsWith('console: [csp]'))).toEqual([]);
});
