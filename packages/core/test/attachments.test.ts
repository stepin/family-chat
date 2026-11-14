// Attachments against the in-memory server: parts, resume, limits, removed
// and damaged files, cancel and retry, automatic downloads.

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { SETTING_AUTO_DOWNLOAD } from '../src/apply.ts';
import type { FetchFn } from '../src/api/transport.ts';
import type { AccountView, CoreOptions, FamilyChatCore } from '../src/core.ts';
import { isCoreError } from '../src/errors.ts';
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

function pattern(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + (i >> 8)) & 0xff;
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

async function attachmentAt(b: FamilyChatCore, accB: AccountView, chat: string, body: string) {
  const list = await waitFor(b.chat(accB.id, chat).messages, (m) => m.some((x) => x.body === body));
  return list.find((x) => x.body === body)!.attachments![0]!;
}

describe('attachments', { timeout: 40_000 }, () => {
  it('a file of two parts goes up from OPFS and comes down into IndexedDB', async () => {
    const server = new FakeServer();
    const { a, b, accA, accB, chat } = await pair(server, { opfsRoot: async () => new FakeOpfsDir() }, { fileStore: 'idb' });
    const data = pattern(4 * 1024 * 1024 + 500);
    const small = pattern(10);
    const msgId = await a.sendMessage(accA.id, chat, {
      text: 'два',
      attachments: [
        { data: new Blob([data]), name: 'a.bin', mime: 'application/octet-stream' },
        { data: new Blob([small]), name: 'b.bin', mime: 'application/octet-stream' },
      ],
    });
    const mine = await waitFor(a.chat(accA.id, chat).messages, (m) => m.some((x) => x.msgId === msgId && x.status === 'on-server'));
    expect(mine.find((x) => x.msgId === msgId)!.attachments!.map((x) => x.status)).toEqual(['ready', 'ready']);
    expect((await a.db.blobs.toArray())[0]!.storage).toBe('opfs');
    const att = await attachmentAt(b, accB, chat, 'два');
    expect(att.status).toBe('not-downloaded'); // files are downloaded on demand
    await b.downloadAttachment(accB.id, att.blobId);
    await waitFor(b.transfers, (t) => t.length === 0 && true);
    await eventually(async () => (await b.db.blobs.get([accB.id, att.blobId]))?.status === 'done');
    expect((await b.db.blobs.get([accB.id, att.blobId]))!.storage).toBe('idb');
    expect(new Uint8Array(await (await b.attachmentBlob(accB.id, att.blobId)).arrayBuffer())).toEqual(data);
    expect(new Uint8Array(await (await a.attachmentBlob(accA.id, att.blobId)).arrayBuffer())).toEqual(data);
    const second = (await waitFor(b.chat(accB.id, chat).messages, (m) => m.some((x) => x.body === 'два'))).find((x) => x.body === 'два')!.attachments![1]!;
    expect(second).toMatchObject({ name: 'b.bin', size: 10 });
  });

  it('an interrupted upload resumes after a restart with the missing parts only', async () => {
    const server = new FakeServer();
    const factory = new IDBFactory();
    let fail = true;
    const puts: string[] = [];
    const fetchA: FetchFn = async (input, init) => {
      if (init.method === 'PUT' && input.includes('/v1/blobs/')) {
        const part = input.slice(input.lastIndexOf('/') + 1);
        if (fail && part === '1') throw new TypeError('network down');
        puts.push(part);
      }
      return server.fetch(input, init);
    };
    const { a, b, accA, accB, chat } = await pair(server, { db: memDb('resume', factory), fetch: fetchA, backoff: { baseMs: 60_000, maxMs: 60_000 } });
    const data = pattern(4 * 1024 * 1024 + 7);
    const msgId = await a.sendMessage(accA.id, chat, { text: 'возобновить', attachments: [{ data: new Blob([data]), name: 'r.bin', mime: 'application/octet-stream' }] });
    const blobId = (await a.db.outbox.get([accA.id, msgId]))!.attachments![0]!.blob.id;
    await eventually(async () => (await a.db.blobs.get([accA.id, blobId]))?.error === 'network');
    const view = await waitFor(a.chat(accA.id, chat).messages, (m) => m.some((x) => x.msgId === msgId && (x.upload?.done ?? 0) > 0));
    expect(view.find((x) => x.msgId === msgId)).toMatchObject({ status: 'on-device', upload: { done: 4 * 1024 * 1024, total: data.length } });
    await a.close();
    fail = false;
    puts.length = 0;
    const a2 = makeCore(server, { db: memDb('resume', factory), fetch: fetchA });
    cores.push(a2);
    await a2.start();
    await eventually(async () => !(await a2.db.outbox.get([accA.id, msgId])), 6000);
    expect(puts).toEqual(['1']);
    const att = await attachmentAt(b, accB, chat, 'возобновить');
    await b.downloadAttachment(accB.id, att.blobId);
    await eventually(async () => (await b.db.blobs.get([accB.id, att.blobId]))?.status === 'done', 6000);
    expect(new Uint8Array(await (await b.attachmentBlob(accB.id, att.blobId)).arrayBuffer())).toEqual(data);
  });

  it('limits and descriptor rules are checked before anything is sent', async () => {
    const server = new FakeServer({ maxBlobBytes: 1000 });
    const { a, accA, chat } = await pair(server);
    const before = server.requests.length;
    await expect(a.sendMessage(accA.id, chat, { attachments: [{ data: new Blob([pattern(1001)]), name: 'x', mime: 'text/plain' }] })).rejects.toSatisfy((e) =>
      isCoreError(e, 'too-large'),
    );
    await expect(a.sendMessage(accA.id, chat, { attachments: [{ data: new Blob([pattern(10)]), name: 'a/b', mime: 'text/plain' }] })).rejects.toSatisfy((e) =>
      isCoreError(e, 'invalid-input'),
    );
    await expect(
      a.sendMessage(accA.id, chat, { attachments: [{ data: new Blob([pattern(10)]), name: 'p.jpg', mime: 'image/jpeg', kind: 'image' }] }),
    ).rejects.toSatisfy((e) => isCoreError(e, 'invalid-input')); // an image needs its size
    const eleven = Array.from({ length: 11 }, (_, i) => ({ data: new Blob([pattern(1)]), name: `f${i}`, mime: 'text/plain' }));
    await expect(a.sendMessage(accA.id, chat, { attachments: eleven })).rejects.toSatisfy((e) => isCoreError(e, 'invalid-input'));
    expect(server.requests.slice(before).filter((r) => r.includes('/v1/blobs'))).toEqual([]);
    expect(await a.db.blobs.count()).toBe(0);
    expect(await a.db.fileChunks.count()).toBe(0);
    expect(await a.db.outbox.count()).toBe(0);
  });

  it('images up to 10 MB download by themselves unless turned off; removed and damaged files', async () => {
    const server = new FakeServer();
    const { a, b, accA, accB, chat } = await pair(server);
    const img = { data: new Blob([pattern(300)]), name: 'p.png', mime: 'image/png', width: 3, height: 4, thumb: new Uint8Array([0xff, 0xd8, 0xff, 0]) };
    await a.sendMessage(accA.id, chat, { text: 'фото', attachments: [img] });
    const auto = await waitFor(b.chat(accB.id, chat).messages, (m) => m.some((x) => x.body === 'фото' && x.attachments?.[0]?.status === 'ready'));
    expect(auto.find((x) => x.body === 'фото')!.attachments![0]).toMatchObject({ kind: 'image', width: 3, height: 4, thumb: '_9j_AA', progress: 1 });

    await b.setSetting(SETTING_AUTO_DOWNLOAD, false);
    await a.sendMessage(accA.id, chat, { text: 'без авто', attachments: [img] });
    expect((await attachmentAt(b, accB, chat, 'без авто')).status).toBe('not-downloaded');

    // Removed on the server before the download.
    const m1 = await a.sendMessage(accA.id, chat, { text: 'удалён', attachments: [{ data: new Blob([pattern(50)]), name: 'g.txt', mime: 'text/plain' }] });
    await eventually(async () => !(await a.db.outbox.get([accA.id, m1])));
    const gone = await attachmentAt(b, accB, chat, 'удалён');
    server.blobs.delete(gone.blobId);
    await b.downloadAttachment(accB.id, gone.blobId);
    await eventually(async () => (await b.db.blobs.get([accB.id, gone.blobId]))?.status === 'gone');
    await expect(b.attachmentBlob(accB.id, gone.blobId)).rejects.toSatisfy((e) => isCoreError(e, 'gone'));

    // Damaged on the server: rejected by the part check.
    const m2 = await a.sendMessage(accA.id, chat, { text: 'испорчен', attachments: [{ data: new Blob([pattern(50)]), name: 'd.txt', mime: 'text/plain' }] });
    await eventually(async () => !(await a.db.outbox.get([accA.id, m2])));
    const bad = await attachmentAt(b, accB, chat, 'испорчен');
    server.blobs.get(bad.blobId)!.parts.get(0)![3]! ^= 1;
    await b.downloadAttachment(accB.id, bad.blobId);
    await eventually(async () => (await b.db.blobs.get([accB.id, bad.blobId]))?.status === 'failed');
    expect((await b.db.blobs.get([accB.id, bad.blobId]))!.error).toBe('wrong-key');
    await expect(b.attachmentBlob(accB.id, bad.blobId)).rejects.toSatisfy((e) => isCoreError(e, 'invalid-input'));
    await expect(b.downloadAttachment(accB.id, 'nope')).rejects.toSatisfy((e) => isCoreError(e, 'invalid-input'));
  });

  it('cancel and retry', async () => {
    const server = new FakeServer();
    let hold: Promise<void> | undefined = new Promise(() => undefined);
    const fetchA: FetchFn = async (input, init) => {
      if (hold && init.method === 'PUT' && input.includes('/v1/blobs/')) {
        await Promise.race([hold, new Promise((_, r) => init.signal?.addEventListener('abort', () => r(new DOMException('aborted', 'AbortError'))))]);
      }
      return server.fetch(input, init);
    };
    const { a, b, accA, accB, chat } = await pair(server, { fetch: fetchA });
    const msgId = await a.sendMessage(accA.id, chat, { text: 'отмена', attachments: [{ data: new Blob([pattern(100)]), name: 'c.txt', mime: 'text/plain' }] });
    await waitFor(a.transfers, (t) => t.some((x) => x.status === 'uploading'));
    await a.cancel(accA.id, msgId);
    expect(await a.db.outbox.count()).toBe(0);
    expect((await a.db.blobs.toArray())[0]!.status).toBe('cancelled');
    expect(await a.db.fileChunks.count()).toBe(0);
    hold = undefined;

    // A permanent failure marks the message failed; retry starts the upload again.
    server.failNext('PUT /v1/blobs/', { status: 403, body: { error: 'not_owner', message: 'x' } });
    const m2 = await a.sendMessage(accA.id, chat, { text: 'повтор', attachments: [{ data: new Blob([pattern(100)]), name: 'r.txt', mime: 'text/plain' }] });
    await waitFor(a.chat(accA.id, chat).messages, (m) => m.some((x) => x.msgId === m2 && x.status === 'failed'));
    await a.retry(accA.id, m2);
    await waitFor(a.chat(accA.id, chat).messages, (m) => m.some((x) => x.msgId === m2 && x.status === 'on-server'));

    // Cancelling a download returns it to "not downloaded".
    const att = await attachmentAt(b, accB, chat, 'повтор');
    await b.downloadAttachment(accB.id, att.blobId);
    await b.cancelTransfer(accB.id, att.blobId);
    const row = (await b.db.blobs.get([accB.id, att.blobId]))!;
    expect(['none', 'done']).toContain(row.status);
  });
});
