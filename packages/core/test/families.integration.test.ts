// Several families and stickers against real fcd processes: one device in two families (two
// servers on different ports) with the same identity, syncing both at once
// and removing one; a sticker pack imported, published, sent and received,
// a tampered file refused, and the pack deleted by its uploader.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore, type AccountView, type CoreOptions, type FamilyChatCore } from '../src/core.ts';
import { isCoreError } from '../src/errors.ts';
import { until, type Readable } from '../src/util/readable.ts';
import { Fcd } from './integration/fcd.ts';
import { FAST, memDb } from './support/helpers.ts';
import { fakeWebp, lottie, makeZip, tgsOf } from './support/zip.ts';

function waitFor<T>(store: Readable<T>, predicate: (v: T) => boolean, ms = 15_000): Promise<T> {
  return Promise.race([until(store, predicate), new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);
}

const one = new Fcd();
const two = new Fcd();
const cores: FamilyChatCore[] = [];

function core(options: Partial<CoreOptions> = {}): FamilyChatCore {
  const c = createCore({ db: memDb(), ...FAST, ...options });
  cores.push(c);
  return c;
}

beforeAll(async () => {
  await one.start();
  await two.start();
});

afterAll(async () => {
  for (const x of cores.splice(0)) await x.close().catch(() => undefined);
  await one.dispose();
  await two.dispose();
});

let mama: FamilyChatCore;
let papa: FamilyChatCore;
let m1: AccountView;
let m2: AccountView;
let p1: AccountView;

describe('families and stickers against fcd', () => {
  it('one device, two family servers, the same identity', async () => {
    mama = core();
    papa = core();
    const babushka = core();
    for (const c of [mama, papa, babushka]) await c.start();
    m1 = await mama.join({ serverUrl: one.url, code: { adminCode: one.adminCode }, name: 'Мама' });
    m2 = await mama.join({ serverUrl: two.url, code: { adminCode: two.adminCode }, name: 'Мама', userId: m1.userId });
    expect(m2.userId).toBe(m1.userId);
    expect(m2.serverId).not.toBe(m1.serverId);
    p1 = await papa.join({ serverUrl: one.url, code: { invite: (await mama.admin.createInvite(m1.id)).code }, name: 'Папа' });
    const b2 = await babushka.join({ serverUrl: two.url, code: { invite: (await mama.admin.createInvite(m2.id)).code }, name: 'Бабушка' });

    const c1 = await papa.openChat(p1.id, m1.userId);
    const c2 = await babushka.openChat(b2.id, m2.userId);
    await papa.send(p1.id, c1, 'из первой семьи');
    await babushka.send(b2.id, c2, 'из второй семьи');
    const list = await waitFor(mama.chatList, (l) => l.filter((c) => c.unread > 0).length === 2);
    expect(list.filter((c) => c.unread > 0).map((c) => c.familyName).sort()).toEqual(['Тест', 'Тест']);
    expect(new Set(list.filter((c) => c.unread > 0).map((c) => c.accountId))).toEqual(new Set([m1.id, m2.id]));
    expect(await waitFor(mama.unreadTotal, (n) => n === 2)).toBe(2);

    // Replies go to the right server.
    await mama.send(m2.id, c2, 'ответ во вторую');
    await waitFor(babushka.chat(b2.id, c2).messages, (l) => l.some((m) => m.body === 'ответ во вторую'));

    // Removing the second family leaves the first one working.
    await mama.removeAccount(m2.id);
    expect((await mama.accountList()).map((a) => a.id)).toEqual([m1.id]);
    expect(await mama.identities()).toEqual([m1.userId]);
    await papa.send(p1.id, c1, 'ещё одно');
    await waitFor(mama.chat(m1.id, c1).messages, (l) => l.some((m) => m.body === 'ещё одно'));
  });

  it('a sticker pack: import, publish, send, receive, delete', async () => {
    const webp = fakeWebp(512, 512);
    const anim = tgsOf(lottie());
    const zip = makeZip([
      { name: 'stickers/😺.webp', data: webp },
      { name: 'stickers/🎉.tgs', data: anim },
      { name: 'stickers/readme.txt', data: new TextEncoder().encode('hello') },
    ]);
    const imported = await mama.importStickers([{ name: 'cats.zip', data: zip }]);
    expect(imported.stickers.map((s) => [s.type, s.emoji])).toEqual([
      ['webp', '😺'],
      ['tgs', '🎉'],
    ]);
    const packId = await mama.publishStickerPack(m1.id, 'Котики', imported);

    await papa.refreshStickers(p1.id);
    const packs = await waitFor(papa.stickerPacks(p1.id), (l) => l.length === 1);
    expect(packs[0]).toMatchObject({ packId, name: 'Котики', author: m1.userId, mine: false });
    const mine = await waitFor(mama.stickerPacks(m1.id), (l) => l.length === 1);
    expect(mine[0]!.mine).toBe(true);

    const chat = await mama.openChat(m1.id, p1.userId);
    const id = await mama.sendSticker(m1.id, chat, packId, imported.stickers[1]!.file);
    const got = await waitFor(papa.chat(p1.id, chat).messages, (l) => l.some((m) => m.msgId === id));
    const msg = got.find((m) => m.msgId === id)!;
    expect(msg.body).toBe('🎉');
    expect(msg.sticker).toEqual({ pack: packId, file: imported.stickers[1]!.file, type: 'tgs', w: 512, h: 512 });
    const list = await waitFor(papa.chatList, (l) => l.some((c) => c.chatId === chat && c.lastMessage?.media === 'sticker'));
    expect(list.find((c) => c.chatId === chat)!.lastMessage!.body).toBe('🎉');

    // Papa fetches the files: checked against their hash and the manifest.
    const blob = await papa.stickerFile(p1.id, packId, imported.stickers[0]!.file);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(webp);
    const a = await papa.stickerAnimation(p1.id, packId, imported.stickers[1]!.file);
    expect(a.info).toMatchObject({ width: 512, height: 512 });
    // A sticker cannot be edited.
    await expect(mama.editMessage(m1.id, chat, id, 'текст')).rejects.toMatchObject({ code: 'not-allowed' });

    // Only the uploader can delete; then it is gone for everyone.
    await expect(papa.deleteStickerPack(p1.id, packId)).rejects.toMatchObject({ code: 'not-allowed' });
    await mama.deleteStickerPack(m1.id, packId);
    await papa.refreshStickers(p1.id);
    await waitFor(papa.stickerPacks(p1.id), (l) => l.length === 0);
    const gone = await papa.stickerFile(p1.id, packId, imported.stickers[0]!.file).catch((e: unknown) => e);
    expect(isCoreError(gone, 'gone')).toBe(true);
    // The message stays, with its emoji.
    const after = await waitFor(papa.chat(p1.id, chat).messages, (l) => l.some((m) => m.msgId === id));
    expect(after.find((m) => m.msgId === id)!.body).toBe('🎉');
  });

  it('a file tampered with on the server is refused', async () => {
    const imported = await mama.importStickers([{ name: 'a.webp', data: fakeWebp(300, 300) }]);
    const packId = await mama.publishStickerPack(m1.id, 'Один', imported);
    await papa.refreshStickers(p1.id);
    await waitFor(papa.stickerPacks(p1.id), (l) => l.some((p) => p.packId === packId));
    // Replace the bytes on disk (an attacker with access to the data folder).
    const { readdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(one.data, 'packs', packId);
    const name = readdirSync(dir).find((f) => f.endsWith('.webp'))!;
    const forged = fakeWebp(300, 300, false, 70);
    writeFileSync(join(dir, name), forged.subarray(0, imported.stickers[0]!.size));
    const err = await papa.stickerFile(p1.id, packId, imported.stickers[0]!.file).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('hash-mismatch');
  });
});
