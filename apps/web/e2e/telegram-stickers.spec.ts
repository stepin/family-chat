// Telegram sticker sets by link end to end: a real fcd with a bot token talks
// to a fake Bot API (--telegram-api-url) served here. Covers the states of
// the import (opening, progress, failed files and retry, cancel, video only,
// errors), publishing the set and sending a sticker from it, and the source
// shown but turned off on a server without a token.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { joinByLink, openChat, send, setupAdmin } from './support/flows.ts';
import { Fcd } from './support/fcd.ts';
import { tgs, webp } from './support/stickers.ts';
import { expect, expectAccessible, test, type User } from './support/test.ts';

const TOKEN = '424242:AAe2eFakeTokenForTheFakeBotApi_xyz';

interface FakeFile {
  data: Buffer;
  /** Answer 502 this many times first. */
  failures?: number;
  delayMs?: number;
}

/** A fake Bot API: sets by name, files by file_id. */
class FakeTelegram {
  sets = new Map<string, unknown>();
  files = new Map<string, FakeFile>();
  setDelayMs = 0;
  #server: Server | undefined;
  port = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => void this.#answer(req.url ?? '', res));
    await new Promise<void>((r) => this.#server!.listen(0, '127.0.0.1', r));
    this.port = (this.#server!.address() as AddressInfo).port;
  }

  async #answer(url: string, res: import('node:http').ServerResponse): Promise<void> {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const u = new URL(url, 'http://x');
    const method = u.pathname.split('/').pop();
    if (u.pathname.startsWith(`/file/bot${TOKEN}/`)) {
      const id = u.pathname.split('/').pop()!.replace(/\.bin$/, '');
      const f = this.files.get(id);
      if (!f) return json(404, { ok: false, error_code: 404, description: 'Not Found' });
      if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
      if (f.failures && f.failures > 0) {
        f.failures--;
        res.writeHead(502);
        return void res.end();
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return void res.end(f.data);
    }
    if (!u.pathname.startsWith(`/bot${TOKEN}/`)) return json(404, { ok: false, error_code: 404, description: 'Not Found' });
    if (method === 'getMe') return json(200, { ok: true, result: { username: 'family_e2e_bot' } });
    if (method === 'getStickerSet') {
      if (this.setDelayMs) await new Promise((r) => setTimeout(r, this.setDelayMs));
      const set = this.sets.get((u.searchParams.get('name') ?? '').toLowerCase());
      return set ? json(200, { ok: true, result: set }) : json(400, { ok: false, error_code: 400, description: 'Bad Request: STICKERSET_INVALID' });
    }
    if (method === 'getFile') {
      const id = u.searchParams.get('file_id') ?? '';
      return json(200, { ok: true, result: { file_id: id, file_path: `stickers/${id}.bin` } });
    }
    return json(404, { ok: false, error_code: 404, description: 'Not Found' });
  }

  async stop(): Promise<void> {
    await new Promise((r) => this.#server?.close(r));
  }
}

const telegram = new FakeTelegram();
const fcd = new Fcd();
const plain = new Fcd();

test.beforeAll(async () => {
  await telegram.start();
  await fcd.start('Ивановы', ['--telegram-bot-token', TOKEN, '--telegram-api-url', telegram.url]);
  await plain.start('Петровы');
});

test.afterAll(async () => {
  await fcd.dispose();
  await plain.dispose();
  await telegram.stop();
});

const sticker = (id: string, emoji: string, kind: 'webp' | 'tgs' | 'video') => ({
  file_id: `F${id}`,
  file_unique_id: `U${id}`,
  emoji,
  is_animated: kind === 'tgs',
  is_video: kind === 'video',
});

test('Telegram set by link: progress, retry, publish, send; cancel; errors; off without a token', async ({ newUser }) => {
  test.setTimeout(240_000);
  const mama: User = await newUser({ viewport: { width: 1200, height: 800 } });
  const page = mama.page;
  const { inviteLink } = await setupAdmin(page, fcd, 'Мама', 'Ивановы', 'f');
  const papa: User = await newUser({ viewport: { width: 1200, height: 800 } });
  await joinByLink(papa.page, inviteLink, 'Папа');
  await send(papa.page, 'Жду стикеры');

  telegram.sets.set('cats_by_family_e2e_bot', {
    name: 'Cats_by_family_e2e_bot',
    title: 'Коты из Telegram',
    sticker_type: 'regular',
    stickers: [sticker('1', '😺', 'webp'), sticker('2', '🎉', 'tgs'), sticker('3', '🙀', 'video')],
  });
  telegram.files.set('F1', { data: await webp(page) });
  // The animated one fails on the first attempt: "не загрузились 1", then the retry loads it.
  telegram.files.set('F2', { data: tgs(), failures: 1 });
  telegram.sets.set('video_only', {
    name: 'Video_only',
    title: 'Видео',
    sticker_type: 'regular',
    stickers: [sticker('9', '🎬', 'video')],
  });
  telegram.sets.set('slow', { name: 'Slow', title: 'Медленный', sticker_type: 'regular', stickers: [sticker('5', '🐢', 'webp')] });
  telegram.files.set('F5', { data: await webp(page, '#3d405b'), delayMs: 20_000 });

  await page.getByRole('button', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: /Стикеры/ }).click();
  const field = page.getByTestId('telegram-link');
  const load = page.getByTestId('telegram-load');

  await test.step('the button waits for a link it understands', async () => {
    await expect(page.getByRole('heading', { name: 'Ссылка из Telegram' })).toBeVisible();
    await expect(field).toBeEnabled();
    await expect(load).toBeDisabled();
    await field.fill('просто текст');
    await expect(load).toBeDisabled();
    await field.fill('https://t.me/addstickers/Cats_by_family_e2e_bot');
    await expect(load).toBeEnabled();
    await expectAccessible(page, 'telegram source');
  });

  await test.step('load: counts of ready, video and failed; retry only the failed one', async () => {
    await field.press('Enter');
    const summary = page.getByTestId('telegram-summary');
    await expect(summary).toHaveText('Готово 1 · видео не поддерживаются 1 · не загрузились 1', { timeout: 30_000 });
    await expect(page.getByTestId('local-sticker')).toHaveCount(1);
    await expect(page.getByLabel('Название набора')).toHaveValue('Коты из Telegram');
    await expect(page.getByTestId('sticker-skipped')).toHaveCount(0);
    await page.getByTestId('telegram-retry').click();
    await expect(summary).toHaveText('Готово 2 · видео не поддерживаются 1', { timeout: 30_000 });
    await expect(page.getByTestId('telegram-retry')).toHaveCount(0);
    await expect(page.getByTestId('local-sticker')).toHaveCount(2);
    await expectAccessible(page, 'telegram preview');
    await expect(page.getByTestId('sticker-publish')).toHaveText('Опубликовать 2 стикера');
    await page.getByTestId('sticker-publish').click();
    await expect(page.getByText('Набор опубликован')).toBeVisible();
    await expect(page.getByTestId('sticker-pack')).toContainText('Коты из Telegram');
  });

  await test.step('cancel keeps the link and says so', async () => {
    await field.fill('t.me/addstickers/Slow');
    await load.click();
    await expect(page.getByTestId('telegram-status')).toHaveText(/Загружено 0 из 1|Открываем набор…/);
    await expect(page.getByRole('progressbar')).toBeVisible();
    await page.getByTestId('telegram-cancel').click();
    await expect(page.getByTestId('telegram-status')).toHaveText('Загрузка отменена');
    await expect(field).toHaveValue('t.me/addstickers/Slow');
    await expect(page.getByTestId('telegram-error')).toHaveCount(0);
  });

  await test.step('errors: video only, unknown set, emoji link', async () => {
    await field.fill('tg://addstickers?set=Video_only');
    await load.click();
    await expect(page.getByTestId('telegram-error')).toHaveText('В этом наборе только видеостикеры, их приложение пока не показывает.');
    await field.fill('https://t.me/addstickers/Nope_none');
    await load.click();
    await expect(page.getByTestId('telegram-error')).toHaveText('Набор не найден. Проверьте ссылку.');
    await expect(field).toHaveValue('https://t.me/addstickers/Nope_none');
    await field.fill('https://t.me/addemoji/Hearts');
    await load.click();
    await expect(page.getByTestId('telegram-error')).toHaveText('Это набор эмодзи, а не стикеров.');
  });

  await test.step('send a sticker of the imported set', async () => {
    await page.getByRole('button', { name: 'Назад' }).click();
    await page.getByRole('button', { name: 'Назад' }).click();
    await openChat(page, 'Папа');
    await page.getByTestId('emoji-button').click();
    await page.getByTestId('picker-mode-stickers').click();
    await expect(page.getByTestId('sticker-cell')).toHaveCount(2);
    await page.getByRole('button', { name: 'Отправить стикер 🎉' }).click();
    await expect(page.getByTestId('message').locator('[data-testid="sticker"][data-type="tgs"]')).toBeVisible();
    await expect(papa.page.getByTestId('message').locator('[data-testid="sticker"][data-type="tgs"]')).toBeVisible({ timeout: 30_000 });
  });

  await test.step('the administrator sees the bot; the public check page only on or off', async () => {
    await page.getByRole('button', { name: 'Настройки' }).click();
    await page.getByRole('button', { name: /Семья и сервер/ }).click();
    await expect(page.getByTestId('server-telegram')).toHaveText('Стикеры Telegram по ссылке: включено (бот @family_e2e_bot)');
    const check = await papa.context.newPage();
    await check.goto(`${fcd.url}/server/`);
    await expect(check.locator('#hello')).toContainText('стикеры по ссылке: включено');
    await expect(check.locator('#hello')).not.toContainText('family_e2e_bot');
    await check.close();
  });

  await test.step('a server without a token: the source is shown but off, with the reason', async () => {
    const other: User = await newUser({ viewport: { width: 360, height: 800 } });
    await setupAdmin(other.page, plain, 'Петя', 'Петровы');
    await other.page.getByRole('button', { name: 'Настройки' }).click();
    await other.page.getByRole('button', { name: /Стикеры/ }).click();
    await expect(other.page.getByTestId('telegram-off')).toContainText('Загрузка по ссылке выключена на сервере');
    await expect(other.page.getByRole('link', { name: /Как включить/ })).toBeVisible();
    await expect(other.page.getByTestId('telegram-link')).toBeDisabled();
    await expect(other.page.getByTestId('sticker-import')).toBeEnabled();
    await expectAccessible(other.page, 'telegram off, narrow');
  });
});
