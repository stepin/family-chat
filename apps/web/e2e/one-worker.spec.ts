// One service worker per fcd, end to end: the root page and a family page
// at /f/<id>/ share one registration (the root's), reloading either keeps
// it, the family page opens without a network from the root's cache, and a
// push for the second family reaches the root worker and names that family.
// There is no push service in the test browser: the push is delivered to
// the worker through the DevTools protocol, as a push service would.

import type { Page } from '@playwright/test';
import { createInvite, joinByLink, send, setupAdmin, toList } from './support/flows.ts';
import { Fcd } from './support/fcd.ts';
import { expect, test, type User } from './support/test.ts';

const fcd = new Fcd();

// Notifications shown by a worker crash Chromium's headless shell: the full browser in its new headless mode.
test.use({ channel: 'chromium' });

test.beforeAll(async () => {
  await fcd.start('Ивановы');
});

test.afterAll(async () => {
  await fcd.dispose();
});

async function registrations(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    return (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope);
  });
}

/** Accounts and chats as the app stored them. */
async function stored(page: Page): Promise<{ accounts: { id: string; serverUrl: string; familyName: string }[]; chats: { accountId: string; chatId: string; kind?: string; peerId?: string }[] }> {
  return page.evaluate(async () => {
    const req = indexedDB.open('family-chat');
    const db: IDBDatabase = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const all = <T,>(store: string): Promise<T[]> =>
      new Promise((r) => {
        const q = db.transaction(store).objectStore(store).getAll();
        q.onsuccess = () => r(q.result as T[]);
      });
    const out = { accounts: await all<{ id: string; serverUrl: string; familyName: string }>('accounts'), chats: await all<{ accountId: string; chatId: string; kind?: string; peerId?: string }>('chats') };
    db.close();
    return out;
  });
}

test('one root worker for the root and /f/ pages; offline family page; push for the second family', async ({ newUser }) => {
  test.setTimeout(240_000);
  const mama: User = await newUser({ viewport: { width: 1200, height: 800 }, permissions: ['notifications'] });
  await setupAdmin(mama.page, fcd, 'Мама', 'Ивановы', 'f');

  // A second family on the same fcd, on the same device.
  await toList(mama.page);
  await mama.page.getByRole('button', { name: 'Настройки' }).click();
  await mama.page.getByRole('button', { name: /Семьи на этом устройстве/ }).click();
  await mama.page.getByRole('button', { name: 'Добавить семью' }).click();
  await mama.page.getByLabel('Я администратор: новая семья').check();
  await mama.page.getByLabel('Адрес сервера').fill(fcd.url);
  await mama.page.getByLabel('Код администратора сервера').fill(fcd.adminCode);
  await mama.page.getByLabel('Название новой семьи').fill('Петровы');
  await mama.page.getByTestId('add-family-submit').click();
  await expect(mama.page.getByText('Семья «Петровы» добавлена')).toBeVisible();
  const link = await createInvite(mama.page);
  const familyUrl = link.split('/#invite=')[0]!;
  expect(familyUrl).toMatch(/\/f\/[a-z2-7]{16}$/);
  const petya: User = await newUser({ viewport: { width: 1000, height: 760 } });
  await joinByLink(petya.page, link, 'Петя');
  await send(petya.page, 'Привет из Петровых');

  await test.step('the root page and the family page share one registration, also after reloading', async () => {
    expect(await registrations(mama.page)).toEqual([`${fcd.url}/`]);
    const fam = await mama.context.newPage();
    await fam.goto(`${familyUrl}/`);
    await expect(fam.getByTestId('status-line')).toBeVisible();
    expect(await registrations(fam)).toEqual([`${fcd.url}/`]);
    await fam.reload();
    await mama.page.reload();
    expect(await registrations(fam)).toEqual([`${fcd.url}/`]);
    expect(await registrations(mama.page)).toEqual([`${fcd.url}/`]);
    // The family page is controlled by the root worker.
    expect(await fam.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(`${fcd.url}/sw.js`);
    await fam.close();
  });

  await test.step('the family page opens without a network, from the root worker', async () => {
    const fam = await mama.context.newPage();
    await fam.goto(`${familyUrl}/`);
    await expect(fam.getByTestId('status-line')).toBeVisible();
    await mama.context.setOffline(true);
    await fam.reload();
    await expect(fam.getByTestId('status-line')).toBeVisible({ timeout: 20_000 });
    await mama.context.setOffline(false);
    await fam.close();
  });

  await test.step('a push of the second family reaches the root worker and names the family', async () => {
    const { accounts, chats } = await stored(mama.page);
    const petrovy = accounts.find((a) => a.familyName === 'Петровы')!;
    expect(petrovy.serverUrl).toBe(familyUrl);
    // The direct chat with Петя, not "Избранное" (which is also stored, and may come first).
    const chat = chats.find((c) => c.accountId === petrovy.id && c.kind === 'dm' && c.peerId)!;
    const cdp = await mama.context.newCDPSession(mama.page);
    const regs: { registrationId: string; scopeURL: string }[] = [];
    cdp.on('ServiceWorker.workerRegistrationUpdated', (e: { registrations: { registrationId: string; scopeURL: string; isDeleted: boolean }[] }) => {
      for (const r of e.registrations) if (!r.isDeleted) regs.push(r);
    });
    await cdp.send('ServiceWorker.enable');
    await expect.poll(() => regs.length).toBeGreaterThan(0);
    expect(new Set(regs.map((r) => r.scopeURL))).toEqual(new Set([`${fcd.url}/`]));
    await cdp.send('ServiceWorker.deliverPushMessage', {
      origin: fcd.url,
      registrationId: regs[0]!.registrationId,
      data: JSON.stringify({ chatId: chat.chatId, gseq: 1 }),
    });
    const shown = () =>
      mama.page.evaluate(async () =>
        (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, accountId: (n.data as { accountId?: string })?.accountId })),
      );
    await expect.poll(shown, { timeout: 10_000 }).toEqual([{ title: 'Петровы · Петя', accountId: petrovy.id }]);
  });
});
