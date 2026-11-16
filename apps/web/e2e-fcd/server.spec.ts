import { expect, test } from '@playwright/test';

test('server check page is served by fcd, shows hello and passes a long request', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const code = process.env['FCD_ADMIN_CODE'];
  expect(code, 'admin code from global setup').toBeTruthy();

  await page.goto('/server/?wait=2');
  await expect(page.locator('#server')).toHaveValue(new URL(page.url()).origin);
  await expect(page.locator('#hello-status')).toContainText('Сервер отвечает');
  await expect(page.locator('#hello')).toContainText('E2E');
  // The checks are always on; before setup the admin code is active.
  await expect(page.locator('#hello')).toContainText('действует');

  await page.locator('#code').fill(code!);
  const button = page.getByRole('button', { name: 'Проверить длинный запрос (2 с)' });
  const started = Date.now();
  await button.click();
  await expect(page.locator('#check-status')).toContainText('Длинный запрос прошёл', { timeout: 20_000 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
  await expect(page.locator('#log li.ok').first()).toContainText('длинный запрос 2 с');

  const report = await page.locator('#report').inputValue();
  expect(report).toContain('Family Chat: проверка сервера');
  expect(report).toContain('семья «E2E»');
  expect(report).toContain('[OK] длинный запрос 2 с');
  expect(report).not.toContain(code!);
  expect(report.toUpperCase()).not.toContain(code!.replace(/-/g, ''));

  // The manifest the page links to is the one iOS needs for Web Push.
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = await (await page.request.get(new URL(href!, page.url()).href)).json();
  expect(manifest.display).toBe('standalone');
  expect(errors).toEqual([]);
});

test('a wrong admin code is reported, not crashed on', async ({ page }) => {
  await page.goto('/server/?wait=1');
  await page.locator('#code').fill('0000-0000-0000-0000');
  await page.getByRole('button', { name: 'Проверить длинный запрос (1 с)' }).click();
  // The shared table words it and points to the in-app check.
  await expect(page.locator('#check-status')).toContainText('Код не подходит');
  await expect(page.locator('#check-status')).toContainText('Настройки → Семья и сервер → Проверка сервера');
});
