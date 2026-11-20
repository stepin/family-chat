// AI assistants (MCP connections) from the app: an administrator creates a
// helper and gives it more access, a member connects their own identity after
// the warning, and both connections really work at <family>/mcp. The family
// sees whose identity the server holds the key of.

import { joinByLink, message, openChat, setupAdmin } from './support/flows.ts';
import { Fcd } from './support/fcd.ts';
import { expect, expectAccessible, test } from './support/test.ts';

const fcd = new Fcd();

test.beforeAll(async () => {
  await fcd.start();
});

test.afterAll(async () => {
  await fcd.dispose();
});

/** One tool call of MCP revision 2026-07-28, as an assistant makes it. */
async function tool(endpoint: string, token: string, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
      },
    }),
  });
  expect(res.status).toBe(200);
  const j = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { ...(JSON.parse(j.result.content[0]!.text) as Record<string, unknown>), isError: j.result.isError === true };
}

test('an administrator creates a helper, a member connects their own identity', async ({ newUser }) => {
  test.setTimeout(180_000);
  const admin = await newUser({ viewport: { width: 1200, height: 900 } });
  const { inviteLink } = await setupAdmin(admin.page, fcd, 'Мама', 'Ивановы', 'f');
  const member = await newUser({ viewport: { width: 1200, height: 900 } });
  await joinByLink(member.page, inviteLink, 'Бабушка', 'f');

  let helper = { endpoint: '', token: '', userId: '' };
  await test.step('the administrator creates a helper and sees its token once', async () => {
    const page = admin.page;
    await page.getByRole('button', { name: 'Настройки' }).click();
    await page.getByTestId('open-assistants').click();
    await expect(page.getByRole('heading', { name: 'ИИ-помощники' })).toBeVisible();
    await expect(page.getByTestId('assistants-none')).toBeVisible();
    await expectAccessible(page, 'AI assistants (empty)');

    await page.getByLabel('Имя помощника').fill('Секретарь');
    await page.getByTestId('create-helper').click();
    await expect(page.getByRole('heading', { name: 'Подключение «Секретарь» готово' })).toBeFocused();
    helper.endpoint = await page.getByTestId('assistant-endpoint').inputValue();
    helper.token = await page.getByTestId('assistant-token-value').inputValue();
    expect(helper.endpoint).toBe(`${fcd.url}/mcp`);
    expect(helper.token).toMatch(/^fcm_[A-Za-z0-9_-]{43}$/);
    await expect(page.getByTestId('assistant-command')).toHaveValue(
      `claude mcp add --transport http family-chat ${helper.endpoint} --header "Authorization: Bearer ${helper.token}"`,
    );
    await expectAccessible(page, 'AI assistants (token shown, light)');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page, 'AI assistants (token shown, dark)');
    await page.emulateMedia({ colorScheme: 'light' });

    // The connection works: the helper is a member of the family with the name given.
    const who = await tool(helper.endpoint, helper.token, 'whoami');
    expect([who['name'], who['levels']]).toEqual(['Секретарь', ['read', 'write']]);
    helper.userId = who['userId'] as string;

    // Hidden on request, and gone for good: nothing of it stays in the page or the browser.
    await page.getByRole('button', { name: 'Токен сохранён, скрыть' }).click();
    await expect(page.getByTestId('assistant-token')).toHaveCount(0);
    expect(await page.content()).not.toContain(helper.token);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain('fcm_');
  });

  await test.step('access levels are switched in the app and take effect at once', async () => {
    const page = admin.page;
    const card = page.getByTestId('assistant').filter({ hasText: 'Секретарь' });
    await expect(card.locator('[data-level="read"]')).toBeChecked();
    await expect(card.locator('[data-level="files"]')).not.toBeChecked();
    expect((await tool(helper.endpoint, helper.token, 'file_upload_start'))['error']).toBe('level_off');
    // Each change is one request; the test waits for the server's answer, not for the tick in the box.
    const saved = () => page.waitForResponse((r) => r.url().includes('/v1/mcp/') && r.request().method() === 'PUT' && r.ok());
    await Promise.all([saved(), card.getByRole('checkbox', { name: /Файлы/ }).check()]);
    await expect(page.getByRole('status').filter({ hasText: 'Сохранено' })).toBeVisible();
    expect((await tool(helper.endpoint, helper.token, 'file_upload_start'))['isError']).toBe(false);
    await Promise.all([saved(), card.getByRole('checkbox', { name: /Запись/ }).uncheck()]);
    await expect(card.locator('[data-level="write"]')).not.toBeChecked();
    expect((await tool(helper.endpoint, helper.token, 'message_send', { chat: helper.userId, text: 'x' }))['error']).toBe('level_off');
    await Promise.all([saved(), card.getByRole('checkbox', { name: /Запись/ }).check()]);
    await expect(card.locator('[data-level="write"]')).toBeChecked();
  });

  let mine = { endpoint: '', token: '' };
  await test.step('a member connects their own identity, after the warning', async () => {
    const page = member.page;
    await page.getByRole('button', { name: 'Настройки' }).click();
    await page.getByTestId('open-assistants').click();
    // Not an administrator: no helpers to see or create.
    await expect(page.getByTestId('assistants-none')).toBeVisible();
    await expect(page.getByText('Помощников со своей личностью создаёт администратор семьи.')).toBeVisible();
    await expect(page.getByTestId('create-helper')).toHaveCount(0);

    await page.getByLabel('Название подключения').fill('Claude у бабушки');
    await page.getByTestId('connect-me').click();
    const dialog = page.getByRole('dialog', { name: 'Передать ключ серверу?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/то же самое, что 24 слова/)).toBeVisible();
    await expectAccessible(page, 'connect my identity (warning)');
    // Nothing happens until the person says they understand.
    await expect(page.getByTestId('connect-me-confirm')).toBeDisabled();
    await page.getByTestId('connect-me-understood').check();
    await page.getByTestId('connect-me-confirm').click();
    await expect(page.getByRole('heading', { name: 'Подключение «Claude у бабушки» готово' })).toBeVisible();
    mine.endpoint = await page.getByTestId('assistant-endpoint').inputValue();
    mine.token = await page.getByTestId('assistant-token-value').inputValue();
    await expect(page.getByTestId('assistant').filter({ hasText: 'Claude у бабушки' })).toContainText('Моя личность');

    // It acts as the member: the administrator's app shows a message from her.
    const who = await tool(mine.endpoint, mine.token, 'whoami');
    expect(who['name']).toBe('Бабушка');
    const members = (await tool(mine.endpoint, mine.token, 'members_list'))['members'] as { userId: string; name: string }[];
    const mama = members.find((m) => m.name === 'Мама')!;
    const sent = await tool(mine.endpoint, mine.token, 'message_send', { chat: mama.userId, text: 'Пишет помощник бабушки' });
    expect(sent['isError']).toBe(false);
  });

  await test.step('the family sees it: the message, and whose key the server holds', async () => {
    const page = admin.page;
    await openChat(page, 'Бабушка');
    await expect(message(page, 'Пишет помощник бабушки')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Профиль контакта' }).click();
    await expect(page.getByTestId('assistant-note')).toContainText('Подключила к своей личности ИИ-помощника', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Назад' }).click();

    // The administrator sees the member's connection, but only the member manages it.
    await page.getByRole('button', { name: 'Настройки' }).click();
    await page.getByTestId('open-assistants').click();
    const card = page.getByTestId('assistant').filter({ hasText: 'Claude у бабушки' });
    await expect(card).toContainText('Личность участника: Бабушка');
    await expect(card.locator('[data-level="read"]')).toBeDisabled();
    await expect(card).toContainText('Этим подключением управляет его владелец.');
  });

  await test.step('a new token replaces the old one; deleting removes the helper', async () => {
    const page = admin.page;
    const card = page.getByTestId('assistant').filter({ hasText: 'Секретарь' });
    await card.getByRole('button', { name: 'Новый токен' }).click();
    await expect(page.getByTestId('assistant-token')).toBeVisible();
    const fresh = await page.getByTestId('assistant-token-value').inputValue();
    expect(fresh).not.toBe(helper.token);
    const old = await fetch(helper.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${helper.token}` }, body: '{}' });
    expect(old.status).toBe(401);
    expect((await tool(helper.endpoint, fresh, 'whoami'))['name']).toBe('Секретарь');

    await card.getByTestId('assistant-remove').click();
    const dialog = page.getByRole('dialog', { name: 'Удалить подключение «Секретарь»?' });
    await expect(dialog).toContainText('будет исключён из семьи');
    await page.getByTestId('assistant-remove-confirm').click();
    await expect(page.getByRole('status').filter({ hasText: 'Подключение удалено' })).toBeVisible();
    await expect(page.getByTestId('assistant').filter({ hasText: 'Секретарь' })).toHaveCount(0);
    const gone = await fetch(helper.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${fresh}` }, body: '{}' });
    expect(gone.status).toBe(401);
  });
});
