// M3 in the core: cancel races of transfers, a full server disk (507) and a
// full device, resumed downloads, the "heard" mark of voice messages, places,
// and the chunk-per-file OPFS layout.

import { Dexie } from 'dexie';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchFn } from '../src/api/transport.ts';
import type { AccountView, CoreOptions, FamilyChatCore } from '../src/core.ts';
import { isCoreError } from '../src/errors.ts';
import { FILE_CHUNK, isQuotaError, OpfsFileStore, openOpfs } from '../src/files.ts';
import { until, type Readable } from '../src/util/readable.ts';
import { FakeOpfsDir } from './support/fake-opfs.ts';
import { FakeServer } from './support/fake-server.ts';
import { eventually, makeCore, memDb } from './support/helpers.ts';

const URL_ = 'https://fc.test';
const cores: FamilyChatCore[] = [];

afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => undefined);
});

function waitFor<T>(store: Readable<T>, predicate: (v: T) => boolean, ms = 6000): Promise<T> {
  return Promise.race([until(store, predicate), new Promise<T>((_, r) => setTimeout(() => r(new Error('timed out')), ms))]);
}

function pattern(n: number, seed = 0): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + (i >> 8) + seed) & 0xff;
  return out;
}

async function pair(server: FakeServer, optsA: Partial<CoreOptions> = {}, optsB: Partial<CoreOptions> = {}) {
  const a = makeCore(server, optsA);
  const b = makeCore(server, optsB);
  cores.push(a, b);
  await a.start();
  await b.start();
  const accA = await a.join({ serverUrl: URL_, code: { adminCode: server.adminCode }, name: 'Мама' });
  const inv = await a.admin.createInvite(accA.id);
  const accB = await b.join({ serverUrl: URL_, code: { invite: inv.code }, name: 'Папа' });
  await a.refreshMembers(accA.id);
  const chat = await a.openChat(accA.id, accB.userId);
  return { a, b, accA, accB, chat };
}

async function received(b: FamilyChatCore, accB: AccountView, chat: string, body: string) {
  const list = await waitFor(b.chat(accB.id, chat).messages, (m) => m.some((x) => x.body === body));
  return list.find((x) => x.body === body)!;
}

const PEAKS = Array.from({ length: 64 }, (_, i) => (i * 4) % 256);

describe('M3 core', { timeout: 40_000 }, () => {
  it('a cancel at any moment never lets the cancelled file reach the server (and does not block later uploads)', async () => {
    // Regression: cancel() could land after the transfer pass had listed the
    // row but before it marked it active. The pass then overwrote
    // "cancelled" with "active" and uploaded the file anyway, or hung on a
    // request nobody would abort any more, blocking every later upload.
    const server = new FakeServer();
    // Messages stay in the outbox until the cancels are done (sending fails as offline).
    let holdPosts = true;
    const fetchA: FetchFn = async (input, init) => {
      if (holdPosts && init.method === 'POST' && input.includes('/events')) throw new TypeError('offline');
      return server.fetch(input, init);
    };
    const { a, accA, chat } = await pair(server, { fetch: fetchA });
    const cancelled: string[] = [];
    for (let i = 0; i < 12; i++) {
      const msgId = await a.sendMessage(accA.id, chat, { text: `c${i}`, attachments: [{ data: new Blob([pattern(100, i)]), name: `c${i}.txt`, mime: 'text/plain' }] });
      const blobId = (await a.db.outbox.get([accA.id, msgId]))!.attachments![0]!.blob.id;
      // Vary the moment of the cancel across the pass.
      for (let k = 0; k < i % 4; k++) await new Promise((r) => setTimeout(r, 0));
      await a.cancel(accA.id, msgId);
      cancelled.push(blobId);
    }
    holdPosts = false;
    // A later message still goes through.
    const last = await a.sendMessage(accA.id, chat, { text: 'после', attachments: [{ data: new Blob([pattern(10)]), name: 'ok.txt', mime: 'text/plain' }] });
    await waitFor(a.chat(accA.id, chat).messages, (m) => m.some((x) => x.msgId === last && x.status === 'on-server'));
    for (const id of cancelled) {
      expect((await a.db.blobs.get([accA.id, id]))!.status).toBe('cancelled');
      // Uploaded before the cancel arrived, it is removed again.
      expect(server.blobs.has(id)).toBe(false);
    }
    expect(await a.db.outbox.count()).toBe(0);
  });

  it('a cancel written by another tab between the pass listing a row and starting it is respected', async () => {
    // Deterministic form of the race above: the pass lists the row as queued;
    // before it starts the upload, another context writes "cancelled". The old
    // code then wrote "active" over it and uploaded the cancelled file.
    const server = new FakeServer();
    let holdPosts = true;
    const fetchA: FetchFn = async (input, init) => {
      if (holdPosts && init.method === 'POST' && input.includes('/events')) throw new TypeError('offline');
      return server.fetch(input, init);
    };
    const { a, accA, chat } = await pair(server, { fetch: fetchA });
    await a.stop();
    const msgId = await a.sendMessage(accA.id, chat, { text: 'чужая вкладка', attachments: [{ data: new Blob([pattern(64)]), name: 't.txt', mime: 'text/plain' }] });
    const blobId = (await a.db.outbox.get([accA.id, msgId]))!.attachments![0]!.blob.id;
    // Read 1: the restart's resume step; read 2: the pass listing the queue.
    let reads = 0;
    let armed = true;
    a.db.blobs.hook('reading', (row) => {
      if (armed && row.blobId === blobId && row.status === 'queued' && ++reads === 2) {
        armed = false;
        // Another context's write, started during the pass's read (outside its transaction):
        // it commits before the pass writes anything.
        void Dexie.ignoreTransaction(() => a.db.blobs.update([accA.id, blobId], { status: 'cancelled' }));
      }
      return row;
    });
    await a.start();
    await eventually(() => !armed);
    holdPosts = false;
    const last = await a.sendMessage(accA.id, chat, { text: 'следующее', attachments: [{ data: new Blob([pattern(8)]), name: 'n.txt', mime: 'text/plain' }] });
    await waitFor(a.chat(accA.id, chat).messages, (m) => m.some((x) => x.msgId === last && x.status === 'on-server'));
    expect((await a.db.blobs.get([accA.id, blobId]))!.status).toBe('cancelled');
    expect(server.blobs.has(blobId)).toBe(false);
    expect(server.requests.some((r) => r.startsWith(`PUT /v1/blobs/${blobId}/`))).toBe(false);
  });

  it('a full server disk (507) keeps the message with its text and sends it when space is back', async () => {
    const server = new FakeServer();
    const { a, b, accA, accB, chat } = await pair(server, { backoff: { baseMs: 50, maxMs: 100 } });
    server.failNext('PUT /v1/blobs/', { status: 507, body: { error: 'storage_full', message: 'x' } }, 3);
    const msgId = await a.sendMessage(accA.id, chat, { text: 'место кончилось', attachments: [{ data: new Blob([pattern(500)]), name: 'f.bin', mime: 'application/octet-stream' }] });
    const waiting = await waitFor(a.chat(accA.id, chat).messages, (m) => m.some((x) => x.msgId === msgId && x.error === 'storage_full'));
    expect(waiting.find((x) => x.msgId === msgId)).toMatchObject({ status: 'on-device', body: 'место кончилось' });
    await waitFor(a.chat(accA.id, chat).messages, (m) => m.some((x) => x.msgId === msgId && x.status === 'on-server'), 10_000);
    expect((await received(b, accB, chat, 'место кончилось')).attachments![0]!.name).toBe('f.bin');

    // The event itself refused with 507: the same, without losing the text.
    server.failNext('POST /v1/chats/', { status: 507, body: { error: 'storage_full', message: 'x' } }, 2);
    const m2 = await a.sendMessage(accA.id, chat, { text: 'и событие' });
    await waitFor(a.chat(accA.id, chat).messages, (m) => m.some((x) => x.msgId === m2 && x.error === 'storage_full' && x.status === 'on-device'));
    await waitFor(a.chat(accA.id, chat).messages, (m) => m.some((x) => x.msgId === m2 && x.status === 'on-server'), 10_000);
  });

  it('a full device: the copy is refused before anything is stored or sent; a download fails with no-space', async () => {
    const server = new FakeServer();
    const opfsA = new FakeOpfsDir();
    const opfsB = new FakeOpfsDir();
    const { a, b, accA, accB, chat } = await pair(server, { opfsRoot: async () => opfsA }, { opfsRoot: async () => opfsB });
    opfsA.quota.left = FILE_CHUNK + 10; // the probe and one chunk fit, the second does not
    const before = server.requests.length;
    await expect(
      a.sendMessage(accA.id, chat, { text: 'большой', attachments: [{ data: new Blob([pattern(FILE_CHUNK + 100)]), name: 'big.bin', mime: 'application/octet-stream' }] }),
    ).rejects.toSatisfy((e) => isCoreError(e, 'no-space'));
    expect(await a.db.outbox.count()).toBe(0);
    expect(await a.db.blobs.count()).toBe(0);
    expect(opfsA.dirs.get('family-chat-files')!.bytes()).toBe(0); // the partial copy was removed
    expect(server.requests.slice(before).filter((r) => r.includes('/v1/blobs'))).toEqual([]);

    opfsA.quota.left = Infinity;
    await a.sendMessage(accA.id, chat, { text: 'скачать', attachments: [{ data: new Blob([pattern(300)]), name: 's.bin', mime: 'application/octet-stream' }] });
    const att = (await received(b, accB, chat, 'скачать')).attachments![0]!;
    opfsB.quota.left = 10;
    await b.downloadAttachment(accB.id, att.blobId);
    await eventually(async () => (await b.db.blobs.get([accB.id, att.blobId]))?.status === 'failed');
    expect((await b.db.blobs.get([accB.id, att.blobId]))!.error).toBe('no-space');
    // After freeing space, retry works.
    opfsB.quota.left = Infinity;
    await b.downloadAttachment(accB.id, att.blobId);
    await eventually(async () => (await b.db.blobs.get([accB.id, att.blobId]))?.status === 'done');
    expect(new Uint8Array(await (await b.attachmentBlob(accB.id, att.blobId)).arrayBuffer())).toEqual(pattern(300));
  });

  it('an interrupted download resumes after a restart from the first missing part', async () => {
    const server = new FakeServer();
    const factory = new IDBFactory();
    let fail = true;
    const gets: string[] = [];
    const fetchB: FetchFn = async (input, init) => {
      if (init.method === 'GET' && /\/v1\/blobs\/[a-z2-7]+\/\d+$/.test(input)) {
        const part = input.slice(input.lastIndexOf('/') + 1);
        if (fail && part === '1') throw new TypeError('network down');
        gets.push(part);
      }
      return server.fetch(input, init);
    };
    const opfsB = new FakeOpfsDir();
    const optsB = { db: memDb('resume-down', factory), fetch: fetchB, opfsRoot: async () => opfsB, backoff: { baseMs: 60_000, maxMs: 60_000 } };
    const { a, b, accA, accB, chat } = await pair(server, {}, optsB);
    const data = pattern(2 * FILE_CHUNK + 33);
    await a.sendMessage(accA.id, chat, { text: 'длинный', attachments: [{ data: new Blob([data]), name: 'l.bin', mime: 'application/octet-stream' }] });
    const att = (await received(b, accB, chat, 'длинный')).attachments![0]!;
    await b.downloadAttachment(accB.id, att.blobId);
    await eventually(async () => (await b.db.blobs.get([accB.id, att.blobId]))?.error === 'network');
    expect((await b.db.blobs.get([accB.id, att.blobId]))!).toMatchObject({ partsDone: 1, bytesDone: FILE_CHUNK, status: 'queued' });
    await b.close();
    fail = false;
    gets.length = 0;
    const b2 = makeCore(server, { ...optsB, backoff: undefined });
    cores.push(b2);
    await b2.start();
    await eventually(async () => (await b2.db.blobs.get([accB.id, att.blobId]))?.status === 'done', 6000);
    expect(gets).toEqual(['1', '2']);
    expect(new Uint8Array(await (await b2.attachmentBlob(accB.id, att.blobId)).arrayBuffer())).toEqual(data);
  });

  it('voice: duration and 64 peaks travel, the "heard" mark is local; a place without text', async () => {
    const server = new FakeServer();
    const { a, b, accA, accB, chat } = await pair(server);
    await a.sendMessage(accA.id, chat, {
      text: 'голос',
      attachments: [{ data: new Blob([pattern(2000)]), name: 'voice.m4a', mime: 'audio/mp4', durationMs: 4200, peaks: PEAKS }],
    });
    const mine = await waitFor(a.chat(accA.id, chat).messages, (m) => m.some((x) => x.body === 'голос' && x.status === 'on-server'));
    expect(mine.find((x) => x.body === 'голос')!.attachments![0]).toMatchObject({ kind: 'voice', heard: true });
    const got = await waitFor(b.chat(accB.id, chat).messages, (m) => m.some((x) => x.body === 'голос' && x.attachments?.[0]?.status === 'ready'));
    const voice = got.find((x) => x.body === 'голос')!.attachments![0]!;
    expect(voice).toMatchObject({ kind: 'voice', durationMs: 4200, peaks: PEAKS, heard: false, mime: 'audio/mp4' });
    await b.markHeard(accB.id, voice.blobId);
    await waitFor(b.chat(accB.id, chat).messages, (m) => m.some((x) => x.attachments?.[0]?.blobId === voice.blobId && x.attachments[0].heard));
    expect((await waitFor(b.chatList, (l) => l.some((c) => c.chatId === chat && c.lastMessage?.media === 'voice'))).length).toBeGreaterThan(0);

    // Voice needs its peaks.
    await expect(
      a.sendMessage(accA.id, chat, { attachments: [{ data: new Blob([pattern(10)]), name: 'v.webm', mime: 'audio/webm', kind: 'voice', durationMs: 1000, peaks: [1, 2] }] }),
    ).rejects.toSatisfy((e) => isCoreError(e, 'invalid-input'));

    const place = { lat: 55.7558, lon: 37.6173, accuracy: 25 };
    const id = await a.sendMessage(accA.id, chat, { location: place });
    const list = await waitFor(b.chat(accB.id, chat).messages, (m) => m.some((x) => x.msgId === id));
    expect(list.find((x) => x.msgId === id)).toMatchObject({ body: '', location: place });
    const summary = await waitFor(b.chatList, (l) => l.some((c) => c.chatId === chat && c.lastMessage?.media === 'location'));
    expect(summary.find((c) => c.chatId === chat)!.lastMessage!.body).toBe('');
    await expect(a.sendMessage(accA.id, chat, { location: { lat: 91, lon: 0, accuracy: 1 } })).rejects.toThrow();
  });

  it('OPFS keeps one file per chunk; files of the M2 layout are still read and removed', async () => {
    const root = new FakeOpfsDir();
    const dir = (await openOpfs(async () => root))!;
    const s = new OpfsFileStore(dir);
    await s.write('acc/new', 0, pattern(FILE_CHUNK));
    await s.write('acc/new', 1, pattern(5, 7));
    const top = root.dirs.get('family-chat-files')!;
    const parts = top.dirs.get('acc_new.parts')!;
    expect([...parts.files.keys()]).toEqual(['0', '1']);
    // Writing chunk 1 did not rewrite chunk 0.
    const first = parts.files.get('0')!;
    expect(first.writes).toBe(1);
    expect(await s.read('acc/new', 1, 5)).toEqual(pattern(5, 7));
    expect(new Uint8Array(await (await s.blob('acc/new', FILE_CHUNK + 5, 'x')).arrayBuffer())).toEqual(new Uint8Array([...pattern(FILE_CHUNK), ...pattern(5, 7)]));
    await expect(s.blob('acc/new', 2 * FILE_CHUNK + 1, 'x')).rejects.toThrow();
    await s.delete('acc/new');
    expect(top.dirs.has('acc_new.parts')).toBe(false);

    // M2: one file with the chunks at their offsets.
    const legacy = await dir.getFileHandle('acc_old', { create: true });
    const w = await legacy.createWritable({ keepExistingData: false });
    await w.write({ type: 'write', position: 0, data: pattern(FILE_CHUNK + 3) });
    await w.close();
    expect(await s.read('acc/old', 1, 3)).toEqual(pattern(FILE_CHUNK + 3).subarray(FILE_CHUNK));
    expect((await s.blob('acc/old', FILE_CHUNK + 3, 'x')).size).toBe(FILE_CHUNK + 3);
    await s.delete('acc/old');
    expect(top.files.has('acc_old')).toBe(false);

    expect(isQuotaError(new DOMException('q', 'QuotaExceededError'))).toBe(true);
    expect(isQuotaError({ name: 'AbortError', inner: { name: 'QuotaExceededError' } })).toBe(true);
    expect(isQuotaError(new Error('x'))).toBe(false);
  });
});
