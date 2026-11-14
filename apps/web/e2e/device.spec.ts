import { expect, test } from '@playwright/test';

test('device check page runs every check and builds a report', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/device/');
  await page.getByRole('button', { name: 'Проверить устройство' }).click();
  await expect(page.locator('#copy')).toBeVisible({ timeout: 60_000 });
  expect(await page.locator('#list li').count()).toBeGreaterThanOrEqual(15);
  // Checks every desktop engine supports must really pass, not just run.
  for (const id of ['secure', 'idb', 'jpeg']) {
    await expect(page.locator(`#list li[data-check="${id}"]`), id).toHaveClass('ok');
  }
  await expect(page.locator('#report')).toHaveValue(/Family Chat: проверка устройства/);
  expect(errors).toEqual([]);
});

test('home page links to the probe and the device check and has a manifest', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Проверить сервер WebDAV' })).toHaveAttribute('href', './probe/');
  const manifest = await page.locator('link[rel="manifest"]').getAttribute('href');
  const res = await page.request.get(new URL(manifest!, page.url()).href);
  expect(res.ok()).toBe(true);
  expect((await res.json()).start_url).toBe('./');
});
