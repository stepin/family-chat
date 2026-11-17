// Several families on one fcd, end to end: the owner sets up the root
// family, creates a second family on the same server from the app ("Add a
// family", I am an administrator) with the reusable server admin code, a
// relative joins the second family by its /f/<id>/ invitation, a member of
// the root family adds the second family on the same device from its link,
// labels tell same-host families apart, and AddFamily explains duplicates
// and links to families that do not exist.

import type { Page } from '@playwright/test';
import { createInvite, joinByLink, message, openChat, send, setupAdmin, toList } from './support/flows.ts';
import { Fcd } from './support/fcd.ts';
import { expect, expectAccessible, test, type User } from './support/test.ts';

const fcd = new Fcd();

test.beforeAll(async () => {
  await fcd.start('Ивановы');
});

test.afterAll(async () => {
  await fcd.dispose();
});

async function firstMessage(page: Page, text: string): Promise<void> {
  await send(page, text);
  const later = page.getByRole('button', { name: 'Позже' });
  if (await later.isVisible().catch(() => false)) await later.click();
}

async function openAddFamily(page: Page): Promise<void> {
  await toList(page);
  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: /Семьи на этом устройстве/ }).click();
  await page.getByRole('button', { name: 'Добавить семью' }).click();
  await expect(page.getByRole('heading', { name: 'Добавить семью', exact: true })).toBeVisible();
}

test('two families on one fcd: create with the server code, join by /f/ link, labels, duplicates', async ({ newUser }) => {
  test.setTimeout(300_000);
  const mama: User = await newUser({ viewport: { width: 1200, height: 800 } });
  const { inviteLink } = await setupAdmin(mama.page, fcd, 'Мама', 'Ивановы', 'f');
  const papa: User = await newUser({ viewport: { width: 1000, height: 760 } });
  await joinByLink(papa.page, inviteLink, 'Папа');
  await firstMessage(papa.page, 'Привет из корня');

  let familyUrl = '';
  await test.step('the owner creates a second family on the same server from the app', async () => {
    await openAddFamily(mama.page);
    await mama.page.getByLabel('Я администратор: новая семья').check();
    await mama.page.getByLabel('Адрес сервера').fill(fcd.url);
    await mama.page.getByLabel('Код администратора сервера').fill(fcd.adminCode);
    // The name is unique on the server, whatever the case.
    await mama.page.getByLabel('Название новой семьи').fill('ИВАНОВЫ');
    await expect(mama.page.getByLabel(/Та же личность, что в семье «Ивановы»/)).toBeChecked();
    await mama.page.getByTestId('add-family-submit').click();
    await expect(mama.page.getByTestId('add-family-error')).toHaveText('Семья с таким названием на этом сервере уже есть. Выберите другое.');
    await mama.page.getByLabel('Название новой семьи').fill('Петровы');
    await mama.page.getByTestId('add-family-submit').click();
    await expect(mama.page.getByText('Семья «Петровы» добавлена')).toBeVisible();
    // Same-host families have different labels.
    await mama.page.getByTestId('family-switcher').click();
    const items = mama.page.getByTestId('family-menu').getByTestId('family-item');
    await expect(items).toHaveCount(2);
    const host = new URL(fcd.url).host;
    await expect(items.filter({ hasText: 'Ивановы' })).toContainText(host);
    await mama.page.keyboard.press('Escape');
    await mama.page.getByRole('button', { name: 'Настройки' }).click();
    await mama.page.getByRole('button', { name: /Семьи на этом устройстве/ }).click();
    const rows = mama.page.getByTestId('family-row');
    await expect(rows.filter({ hasText: 'Петровы' })).toContainText(new RegExp(`${host.replace(/[.]/g, '\\.')} · /f/[a-z2-7]{4}…`));
    await expect(rows.filter({ hasText: 'Ивановы' })).toContainText(`Адрес семьи: ${host}`);
    await expectAccessible(mama.page, 'families of one server');
    familyUrl = (await mama.page.evaluate(async () => {
      const req = indexedDB.open('family-chat');
      const db: IDBDatabase = await new Promise((r) => (req.onsuccess = () => r(req.result)));
      const all: { serverUrl: string; familyName: string }[] = await new Promise((r) => {
        const q = db.transaction('accounts').objectStore('accounts').getAll();
        q.onsuccess = () => r(q.result);
      });
      return all.find((a) => a.familyName === 'Петровы')!.serverUrl;
    }))!;
    expect(familyUrl).toMatch(new RegExp(`^${fcd.url.replace(/[.]/g, '\\.')}/f/[a-z2-7]{16}$`));
  });

  let linkB = '';
  await test.step('a relative joins the second family by its own link', async () => {
    linkB = await createInvite(mama.page);
    expect(linkB.startsWith(`${familyUrl}/#invite=`)).toBe(true);
    const petya: User = await newUser({ viewport: { width: 1000, height: 760 } });
    await joinByLink(petya.page, linkB, 'Петя');
    await expect(petya.page.getByRole('heading', { name: 'Мама' })).toBeVisible();
    await firstMessage(petya.page, 'Привет из Петровых');
    await mama.page.getByTestId('family-switcher').click();
    await mama.page.getByTestId('family-item').filter({ hasText: 'Петровы' }).click();
    await openChat(mama.page, 'Петя');
    await expect(message(mama.page, 'Привет из Петровых')).toBeVisible({ timeout: 30_000 });
    // The family's own page and its server check answer under /f/<id>/.
    const check = await petya.context.newPage();
    await check.goto(`${familyUrl}/server/`);
    await expect(check.locator('#server')).toHaveValue(familyUrl);
    await expect(check.locator('#hello')).toContainText('Петровы');
    await expect(check.locator('h1')).toContainText('Петровы');
    await check.close();
  });

  await test.step('a member of the root family adds the second one on the same device from its link', async () => {
    const link = await createInvite(mama.page);
    await papa.page.goto(link);
    await expect(papa.page.getByTestId('add-invited')).toContainText('«Петровы»');
    await papa.page.getByTestId('add-family-submit').click();
    await expect(papa.page.getByText('Семья «Петровы» добавлена')).toBeVisible();
    await papa.page.getByTestId('family-switcher').click();
    await expect(papa.page.getByTestId('family-menu').getByTestId('family-item')).toHaveCount(2);
    await papa.page.getByTestId('family-item').filter({ hasText: 'Ивановы' }).click();
    // The root family still works.
    await openChat(mama.page, 'Петя');
    await mama.page.getByTestId('family-switcher').click();
    await mama.page.getByTestId('family-item').filter({ hasText: 'Ивановы' }).click();
    await openChat(mama.page, 'Папа');
    await send(mama.page, 'Корень на месте');
    await openChat(papa.page, 'Мама');
    await expect(message(papa.page, 'Корень на месте')).toBeVisible({ timeout: 30_000 });
  });

  await test.step('AddFamily: a family already here, and a /f/ link that leads nowhere', async () => {
    await openAddFamily(mama.page);
    await mama.page.getByLabel('Ссылка-приглашение').fill(`${fcd.url}/#invite=abcdefghijklmnopqrstuvwxyz`);
    await mama.page.getByRole('button', { name: 'Проверить' }).click();
    await expect(mama.page.getByTestId('add-family-error')).toHaveText(
      'Эта семья уже есть на этом устройстве. Другая семья на том же сервере открывается по своей ссылке вида …/f/…, её присылает владелец сервера.',
    );
    await mama.page.getByLabel('Ссылка-приглашение').fill(`${fcd.url}/f/aaaaaaaaaaaaaaaa/#invite=abcdefghijklmnopqrstuvwxyz`);
    await mama.page.getByRole('button', { name: 'Проверить' }).click();
    await expect(mama.page.getByTestId('add-family-error')).toHaveText('Семья по этой ссылке не найдена. Проверьте ссылку у владельца сервера.');
  });

  await test.step('a stranger sets up a third family from the first screen with the server code', async () => {
    const owner: User = await newUser({ viewport: { width: 360, height: 760 } });
    await owner.page.goto(`${fcd.url}/`);
    await owner.page.getByRole('button', { name: 'Настроить для своей семьи' }).click();
    await owner.page.getByLabel('Код администратора сервера').fill(fcd.adminCode);
    await owner.page.getByRole('button', { name: 'Дальше' }).click();
    await owner.page.getByLabel('Название семьи').fill('Сидоровы');
    await owner.page.getByLabel('Как вас зовут').fill('Сидор');
    await owner.page.getByRole('button', { name: 'Создать семью' }).click();
    await expect(owner.page.locator('ol.words .w')).toHaveCount(24, { timeout: 20_000 });
    const words = await owner.page.locator('ol.words .w').allTextContents();
    await owner.page.getByRole('button', { name: 'Я записал' }).click();
    for (const label of await owner.page.getByText(/^Слово № \d+$/).allTextContents()) {
      const n = Number(/\d+/.exec(label)![0]);
      await owner.page.getByLabel(label, { exact: true }).fill(words[n - 1]!);
    }
    await owner.page.getByRole('button', { name: 'Проверить' }).click();
    await owner.page.getByRole('button', { name: 'Дальше' }).click();
    const address = owner.page.getByTestId('family-address');
    await expect(address).toHaveText(new RegExp(`^${fcd.url.replace(/[.]/g, '\\.')}/f/[a-z2-7]{16}$`));
    await expect(owner.page.getByText('Код администратора сервера можно использовать снова: храните его как пароль.')).toBeVisible();
    await expectAccessible(owner.page, 'new family ready, narrow');
  });
});
