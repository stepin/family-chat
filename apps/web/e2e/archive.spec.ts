// The archive end to end: export in one browser context (a file download),
// restore the identity by the phrase in a fresh context and import the
// archive there ("добавлено N, пропущено M"); an archive of another
// identity is refused with a plain message.

import { readFileSync } from 'node:fs';
import { joinByLink, message, send, setupAdmin } from './support/flows.ts';
import { Fcd } from './support/fcd.ts';
import { expect, test } from './support/test.ts';

const fcd = new Fcd();
const wide = { viewport: { width: 1200, height: 860 } };

test.beforeAll(async () => {
  await fcd.start();
});

test.afterAll(async () => {
  await fcd.dispose();
});

test('export the archive and import it on a fresh device', async ({ newUser }) => {
  test.setTimeout(240_000);
  const mama = await newUser(wide);
  const { inviteLink, phrase } = await setupAdmin(mama.page, fcd);
  const petya = await newUser(wide);
  await joinByLink(petya.page, inviteLink, 'Петя');
  await send(petya.page, 'Сообщение Пети');
  await petya.page.getByRole('button', { name: 'Позже' }).click();
  await mama.page.locator('button.chat').filter({ hasText: 'Петя' }).click({ timeout: 30_000 });
  await expect(message(mama.page, 'Сообщение Пети')).toBeVisible();
  await send(mama.page, 'Ответ мамы');
  await expect(message(mama.page, 'Ответ мамы')).toHaveAttribute('data-status', 'on-server', { timeout: 30_000 });

  let archivePath = '';
  await test.step('export with progress, then save the file', async () => {
    await mama.page.getByRole('button', { name: 'Настройки' }).click();
    await mama.page.getByRole('button', { name: 'Хранилище и архив' }).click();
    await expect(mama.page.getByTestId('last-export')).toHaveText('Архив ещё не сохранялся.');
    await mama.page.getByRole('button', { name: 'Создать архив' }).click();
    await expect(mama.page.getByTestId('export-ready')).toBeVisible({ timeout: 60_000 });
    const download = mama.page.waitForEvent('download');
    await mama.page.getByRole('button', { name: 'Сохранить файл' }).click();
    const d = await download;
    // With one family the file name does not carry the family's name.
    expect(d.suggestedFilename()).toMatch(/^family-chat-\d{4}-\d{2}-\d{2}\.fcarchive$/);
    archivePath = await d.path();
    expect(readFileSync(archivePath).length).toBeGreaterThan(100);
    await expect(mama.page.getByTestId('last-export')).toContainText('Последний архив:');
  });

  await test.step('an archive of another identity is refused', async () => {
    await petya.page.getByRole('button', { name: 'Настройки' }).click();
    await petya.page.getByRole('button', { name: 'Хранилище и архив' }).click();
    await petya.page.getByTestId('archive-input').setInputFiles(archivePath);
    await expect(petya.page.getByTestId('import-error')).toHaveText(
      'Архив от другой идентичности. Его можно открыть только на устройстве того, кто его создал.',
      { timeout: 30_000 },
    );
  });

  await test.step('a fresh device restores by the phrase and imports the archive', async () => {
    const fresh = await newUser(wide);
    await fresh.page.goto(`${fcd.url}/`);
    await fresh.page.getByRole('button', { name: 'Восстановить по фразе' }).click();
    await fresh.page.getByRole('button', { name: 'Дальше' }).click();
    await fresh.page.getByLabel('24 слова').fill(phrase);
    await fresh.page.getByRole('button', { name: 'Восстановить' }).click();
    await fresh.page.getByRole('button', { name: 'К чатам' }).click();
    await fresh.page.getByRole('button', { name: 'Настройки' }).click();
    await fresh.page.getByRole('button', { name: 'Хранилище и архив' }).click();
    await fresh.page.getByTestId('archive-input').setInputFiles(archivePath);
    await expect(fresh.page.getByTestId('import-result')).toHaveText(/^Добавлено \d+ \S+, пропущено \d+ уже известных\.$/, { timeout: 60_000 });
    await fresh.page.getByRole('button', { name: 'Назад' }).click();
    await fresh.page.getByRole('button', { name: 'Назад' }).click();
    await fresh.page.locator('button.chat').filter({ hasText: 'Петя' }).click({ timeout: 30_000 });
    await expect(message(fresh.page, 'Сообщение Пети')).toBeVisible();
    await expect(message(fresh.page, 'Ответ мамы')).toHaveClass(/out/);
  });
});
