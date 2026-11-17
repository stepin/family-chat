// End to end against real fcd servers: the setup button on the first
// screen always (it needs the server admin code), the server
// check in Family and server for administrators only, Diagnostics links, and
// a single emoji shown twice as large. Each scenario runs on its own fcd
// (fresh folder, --port 0), so the admin code of one never affects another.

import type { Page } from '@playwright/test';
import { joinByLink, message, send, setupAdmin } from './support/flows.ts';
import { Fcd } from './support/fcd.ts';
import { expect, test, type User } from './support/test.ts';

const servers: Fcd[] = [];

async function server(family = 'Ивановы', args: readonly string[] = []): Promise<Fcd> {
  const fcd = new Fcd();
  servers.push(fcd);
  await fcd.start(family, args);
  return fcd;
}

test.afterAll(async () => {
  await Promise.all(servers.map((s) => s.dispose()));
});

const setupButton = (page: Page) => page.getByRole('button', { name: 'Настроить для своей семьи' });

async function openFamilyAndServer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: /Семья и сервер/ }).click();
}

async function back(page: Page, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) await page.getByRole('button', { name: 'Назад' }).click();
}

test('the setup button is always offered, with who has the code; the server check is for administrators', async ({ newUser }) => {
  test.setTimeout(240_000);
  const fcd = await server();

  await test.step('the first screen: the invitation first, setup second with its hint', async () => {
    const visitor = await newUser();
    await visitor.page.goto(`${fcd.url}/`);
    const invite = visitor.page.getByRole('button', { name: 'У меня есть приглашение' });
    await expect(invite).toBeVisible();
    await expect(setupButton(visitor.page)).toBeVisible();
    await expect(setupButton(visitor.page)).toHaveAccessibleDescription('Нужен код от владельца сервера.');
    expect((await invite.boundingBox())!.y).toBeLessThan((await setupButton(visitor.page).boundingBox())!.y);
    await visitor.context.close();
  });

  const mama: User = await newUser({ viewport: { width: 1200, height: 800 } });
  const { inviteLink } = await setupAdmin(mama.page, fcd);

  await test.step('after the administrator joined, setup is still offered (a new family on this server)', async () => {
    const visitor = await newUser();
    await visitor.page.goto(`${fcd.url}/`);
    await expect(setupButton(visitor.page)).toBeVisible();
    await expect(visitor.page.getByTestId('server-taken')).toHaveCount(0);
    // A wrong server code is named as such.
    await setupButton(visitor.page).click();
    await expect(visitor.page.getByLabel('Адрес сервера')).toHaveValue(fcd.url);
    await visitor.page.getByLabel('Код администратора сервера').fill('0000-0000-0000-0000');
    await visitor.page.getByRole('button', { name: 'Дальше' }).click();
    await expect(visitor.page.getByText('Сервер отвечает. На нём будет новая семья со своим адресом.')).toBeVisible();
    await visitor.page.getByLabel('Название семьи').fill('Чужие');
    await visitor.page.getByLabel('Как вас зовут').fill('Чужой');
    await visitor.page.getByRole('button', { name: 'Создать семью' }).click();
    await expect(visitor.page.getByRole('alert')).toHaveText('Код не подошёл. Нужен код администратора сервера, его даёт владелец сервера.');
    await expect(visitor.page.getByLabel('Код администратора сервера')).toHaveAttribute('aria-invalid', 'true');
    await visitor.context.close();
  });

  await test.step('the administrator sees the server check last; a long request gets through', async () => {
    await openFamilyAndServer(mama.page);
    // Last in the administrator's part, after the disk.
    const headings = mama.page.getByRole('heading', { level: 2 });
    await expect(headings.last()).toHaveText('Проверка сервера');
    await expect(headings.nth(-2)).toHaveText('Место на сервере');
    await mama.page.getByTestId('check-wait').click();
    await expect(mama.page.getByTestId('check-wait-running')).toContainText('Ждём ответ…');
    await expect(mama.page.getByTestId('check-wait')).toBeDisabled();
    await expect(mama.page.getByTestId('check-wait-ok')).toContainText('долгие запросы проходят', { timeout: 45_000 });
    // The test servers run with --push false: the shared table words it.
    await expect(mama.page.getByTestId('server-check')).toContainText('Уведомления на сервере выключены.');
    await back(mama.page, 2);
  });

  await test.step('Diagnostics: the administrator goes to the in-app check', async () => {
    await mama.page.getByRole('button', { name: 'Настройки' }).click();
    await mama.page.getByRole('button', { name: /Диагностика/ }).click();
    await mama.page.getByRole('button', { name: 'Проверить сервер' }).click();
    await expect(mama.page.getByRole('heading', { name: 'Проверка сервера' })).toBeVisible();
    // The server is set up: the /server/ page is not offered.
    await back(mama.page);
    await expect(mama.page.getByRole('link', { name: /страница \/server\// })).toHaveCount(0);
  });

  await test.step('a member sees no server check, and Diagnostics says who checks', async () => {
    const papa: User = await newUser({ viewport: { width: 1200, height: 800 } });
    await joinByLink(papa.page, inviteLink, 'Папа');
    await openFamilyAndServer(papa.page);
    await expect(papa.page.getByRole('heading', { name: 'Участники' })).toBeVisible();
    await expect(papa.page.getByRole('heading', { name: 'Проверка сервера' })).toHaveCount(0);
    await back(papa.page);
    await papa.page.getByRole('button', { name: /Диагностика/ }).click();
    await expect(papa.page.getByTestId('server-check-admin-only')).toHaveText('Проверку сервера делает администратор семьи.');
    await expect(papa.page.getByRole('button', { name: 'Проверить сервер' })).toHaveCount(0);
  });
});

test('a single emoji is twice as large; edited to text it is normal; with a quote it keeps the bubble', async ({ newUser }) => {
  test.setTimeout(180_000);
  const fcd = await server();
  const mama: User = await newUser({ viewport: { width: 1200, height: 800 } });
  const petya: User = await newUser({ viewport: { width: 1200, height: 800 } });
  const { inviteLink } = await setupAdmin(mama.page, fcd);
  await joinByLink(petya.page, inviteLink, 'Петя');
  const page = petya.page;
  await send(page, 'обычный');
  await page.getByRole('button', { name: 'Позже' }).click().catch(() => undefined);
  await send(page, '😀');

  const size = (text: string) =>
    message(page, text)
      .last()
      .locator('p.text')
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const normal = await size('обычный');
  const emoji = message(page, '😀').last();
  await expect(emoji.locator('.bubble')).toHaveClass(/emoji-only/);
  await expect(emoji.locator('.bubble')).toHaveClass(/sticker-bubble/);
  expect(await size('😀')).toBeCloseTo(normal * 2, 0);
  const box = (await emoji.locator('.bubble').boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);

  // A reply with one emoji: the normal bubble, the emoji still large.
  await message(page, 'обычный').last().hover();
  await message(page, 'обычный').last().getByTestId('message-more').click();
  await page.getByTestId('message-menu').getByRole('menuitem', { name: 'Ответить' }).click();
  await send(page, '👍');
  const reply = message(page, '👍').last();
  await expect(reply.getByTestId('message-quote')).toBeVisible();
  await expect(reply.locator('.bubble')).toHaveClass(/emoji-only/);
  await expect(reply.locator('.bubble')).not.toHaveClass(/sticker-bubble/);

  // Edited to "😀 ok": the class goes at once.
  await emoji.hover();
  await emoji.getByTestId('message-more').click();
  await page.getByTestId('message-menu').getByRole('menuitem', { name: 'Изменить' }).click();
  const box2 = page.getByLabel('Сообщение');
  await box2.fill('😀 ok');
  await box2.press('Enter');
  const edited = message(page, '😀 ok').last();
  await expect(edited).toContainText('изменено');
  await expect(edited.locator('.bubble')).not.toHaveClass(/emoji-only/);
});
