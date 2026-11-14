import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'secret';

async function runProbe(page: Page, url: string, password = PASSWORD): Promise<void> {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await page.goto('/probe/');
  await page.getByTestId('probe-url').fill(url);
  await page.getByTestId('probe-user').fill('fc');
  await page.getByTestId('probe-password').fill(password);
  await page.getByTestId('probe-run').click();
  await expect(page.getByTestId('probe-verdict')).toBeVisible({ timeout: 90_000 });
  expect(violations).toEqual([]);
}

async function checkStatus(page: Page, id: string): Promise<string | null> {
  return page.locator(`[data-testid="probe-check"][data-check="${id}"]`).first().getAttribute('data-status');
}

async function reportText(page: Page): Promise<string> {
  return page.getByTestId('probe-report').inputValue();
}

const suitable = [
  { name: 'dufs with --enable-cors', url: 'http://127.0.0.1:18081/family-chat/', recipe: false },
  { name: 'nginx recipe in front of WebDAV without CORS', url: 'http://127.0.0.1:18082/family-chat/', recipe: true },
  { name: 'Caddy recipe in front of WebDAV without CORS', url: 'http://127.0.0.1:18083/family-chat/', recipe: true },
];

for (const s of suitable) {
  test(`probe passes against ${s.name}`, async ({ page }) => {
    await runProbe(page, s.url);
    await expect(page.getByTestId('probe-verdict')).toHaveText('Сервер подходит');
    await page.getByTestId('probe-checks-summary').click();
    for (const id of ['https', 'reachable', 'cors', 'auth', 'webdav', 'date', 'mkcol', 'errors-cors', 'put', 'list', 'put-large', 'delete', 'delete-recursive']) {
      expect(await checkStatus(page, id), id).toBe('ok');
    }
    if (s.recipe) {
      // Recipes meet every requirement of section 6.12 that the browser can see.
      expect(await checkStatus(page, 'preflight-cache')).toBe('ok');
      expect(await checkStatus(page, 'html')).toBe('ok');
      // The router-like server behind the proxy shows its whole disk to the account.
      expect(await checkStatus(page, 'scope')).toBe('warn');
    } else {
      expect(await checkStatus(page, 'scope')).toBe('ok');
    }
    const text = await reportText(page);
    expect(text).toContain('Вердикт: Сервер подходит');
    expect(text).toContain('"method": "PROPFIND"');
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(Buffer.from(`fc:${PASSWORD}`).toString('base64'));
    await page.getByTestId('probe-copy').click();
    await expect(page.getByRole('status').first()).toBeVisible();
  });
}

test('probe asks for server setup against WebDAV without CORS', async ({ page }) => {
  await runProbe(page, 'http://127.0.0.1:18080/family-chat/');
  await expect(page.getByTestId('probe-verdict')).toHaveText('Нужна настройка сервера');
  await page.getByTestId('probe-checks-summary').click();
  expect(await checkStatus(page, 'reachable')).toBe('ok');
  expect(await checkStatus(page, 'cors')).toBe('fail');
  expect(await checkStatus(page, 'mkcol')).toBe('skip');
  await expect(page.getByTestId('probe-instructions')).toHaveAttribute(
    'href',
    'https://github.com/stepin/family-chat/blob/main/docs/recipes/README.md',
  );
});

test('probe reports a rejected password behind the nginx recipe', async ({ page }) => {
  await runProbe(page, 'http://127.0.0.1:18082/family-chat/', 'wrong-password');
  await expect(page.getByTestId('probe-verdict')).toHaveText('Не подходит');
  await expect(page.getByTestId('probe-summary')).toContainText('Digest');
  expect(await reportText(page)).not.toContain('wrong-password');
});
