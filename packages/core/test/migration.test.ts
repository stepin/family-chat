// The database schema only grows: a database written by the M1 code (schema
// version 1) or the M2/M3 code (version 2) opens with the current version,
// keeps every row and gets the new tables and indexes.

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { Dexie } from 'dexie';
import { describe, expect, it } from 'vitest';
import { CoreDb, DB_VERSION, openDb } from '../src/db/schema.ts';
import { searchMessages } from '../src/search.ts';

/** Exactly the M1 schema (commit c3c8ec4, src/db/schema.ts). */
class M1Db extends Dexie {
  constructor(name: string, factory: IDBFactory) {
    super(name, { indexedDB: factory, IDBKeyRange });
    this.version(1).stores({
      accounts: 'id, serverId',
      identities: 'userId',
      users: '[accountId+userId], accountId',
      chats: '[accountId+chatId], accountId, chatId',
      events: '[accountId+senderId+msgId], [accountId+gseq], [accountId+chatId+gseq]',
      messages: '[accountId+senderId+msgId], [accountId+chatId+gseq], accountId',
      outbox: '[accountId+msgId], accountId, [accountId+chatId], createdAt',
      counters: '[accountId+chatId]',
      seqTrack: '[accountId+chatId+senderId+devId]',
      drafts: '[accountId+chatId], accountId',
      diagnostics: '++id, time',
      settings: 'key',
      leases: 'name',
    });
  }
}

/** Exactly the M2/M3 schema (commit c12f4ba, src/db/schema.ts): version 1 plus version 2. */
class M2Db extends M1Db {
  constructor(name: string, factory: IDBFactory) {
    super(name, factory);
    this.version(2).stores({
      groups: '[accountId+chatId], accountId',
      groupStates: '[accountId+chatId+version], [accountId+chatId]',
      epochKeys: '[accountId+chatId+epoch], [accountId+chatId]',
      sealedKeys: '[accountId+n], [accountId+chatId]',
      groupPending: '[accountId+chatId], accountId',
      notices: '[accountId+gseq], [accountId+chatId]',
      pendingEvents: '[accountId+gseq], [accountId+chatId], accountId',
      blobs: '[accountId+blobId], accountId, [accountId+msgId], status',
      fileChunks: '[key+index], key',
      avatars: '[accountId+userId], accountId',
    });
  }
}

describe('schema migration', () => {
  it('opens an M1 database, keeps its rows and adds the M2 tables and fields', async () => {
    expect(DB_VERSION).toBe(3);
    const factory = new IDBFactory();
    const old = new M1Db('m1', factory);
    await old.open();
    await old.table('accounts').put({
      id: 'acc1', serverUrl: 'https://fc.test', serverId: 'sid', familyName: 'Семья', userId: 'u'.repeat(26), devId: 'd'.repeat(16),
      token: 't', admin: true, status: 'active', cursor: 42, initialSyncDone: true, retentionGap: null, retentionDays: 90,
      pushAvailable: false, vapidPublicKey: null, pushRegistered: false, createdAt: 1, lastSyncAt: 2,
    });
    await old.table('chats').put({ accountId: 'acc1', chatId: 'c'.repeat(26), kind: 'dm', peerId: 'p'.repeat(26), createdAt: 1, last: null, readGseq: 3, unread: 1 });
    await old.table('messages').put({ accountId: 'acc1', chatId: 'c'.repeat(26), senderId: 'p'.repeat(26), msgId: 'm'.repeat(26), devId: 'x', seq: 1, gseq: 5, time: 6, kind: 'msg', body: 'привет', reply: null });
    await old.table('settings').put({ key: 'push.showText', value: true });
    old.close();

    const db = await openDb(new CoreDb('m1', { indexedDB: factory, IDBKeyRange }));
    const acc = (await db.accounts.get('acc1'))!;
    expect(acc).toMatchObject({ cursor: 42, token: 't', keysCursor: 0, oldest: null, revoked: false, limits: null });
    expect((await db.messages.toArray())[0]!.body).toBe('привет');
    expect((await db.chats.toArray())[0]!.kind).toBe('dm');
    expect((await db.settings.get('push.showText'))!.value).toBe(true);
    for (const t of ['groups', 'groupStates', 'epochKeys', 'sealedKeys', 'groupPending', 'notices', 'pendingEvents', 'blobs', 'fileChunks', 'avatars']) {
      expect(await db.table(t).count()).toBe(0);
    }
    await db.notices.put({ accountId: 'acc1', gseq: 1, time: 1, chatId: 'g', notice: { type: 'member_removed', userId: 'u' } });
    expect(await db.notices.count()).toBe(1);
    db.close();
  });
});

describe('schema migration to version 3 (M4)', () => {
  it('opens an M2/M3 database, keeps its rows, adds the M4 tables and indexes the old messages for search', async () => {
    const factory = new IDBFactory();
    const old = new M2Db('m2', factory);
    await old.open();
    await old.table('accounts').put({
      id: 'acc1', serverUrl: 'https://fc.test', serverId: 'sid', familyName: 'Семья', userId: 'u'.repeat(26), devId: 'd'.repeat(16),
      token: 't', admin: true, status: 'active', cursor: 42, initialSyncDone: true, retentionGap: null, retentionDays: 90,
      pushAvailable: false, vapidPublicKey: null, pushRegistered: false, createdAt: 1, lastSyncAt: 2, keysCursor: 3, oldest: null, revoked: false, limits: null,
    });
    const base = { accountId: 'acc1', chatId: 'c'.repeat(26), senderId: 'p'.repeat(26), devId: 'x', reply: null };
    await old.table('messages').bulkPut([
      { ...base, msgId: 'a'.repeat(26), seq: 1, gseq: 5, time: 6, kind: 'msg', body: 'Ёлка во дворе' },
      { ...base, msgId: 'b'.repeat(26), seq: 2, gseq: 7, time: 8, kind: 'msg', body: '', attachments: [{ blob: { id: 'z'.repeat(26), key: 'k', parts: 1, partSize: 4194304, size: 3 }, name: 'Отчёт.pdf', mime: 'application/pdf', kind: 'file' }] },
      { ...base, senderId: '', msgId: 's'.repeat(26), seq: null, gseq: 9, time: 9, kind: 'service', body: '', service: { type: 'left', userId: 'q' } },
    ]);
    await old.table('blobs').put({ accountId: 'acc1', blobId: 'z'.repeat(26), direction: 'down', chatId: base.chatId, senderId: base.senderId, msgId: 'b'.repeat(26), ref: {}, name: 'Отчёт.pdf', mime: 'application/pdf', kind: 'file', size: 3, status: 'none', bytesDone: 0, partsDone: 0, attempts: 0, nextAttemptAt: 0, error: null, storage: null, createdAt: 1 });
    old.close();

    const db = await openDb(new CoreDb('m2', { indexedDB: factory, IDBKeyRange }));
    expect(db.verno).toBe(3);
    expect((await db.accounts.get('acc1'))!).toMatchObject({ cursor: 42, keysCursor: 3, token: 't' });
    const rows = await db.messages.toArray();
    expect(rows).toHaveLength(3);
    expect(rows.find((m) => m.msgId === 'a'.repeat(26))!.words).toEqual(['елка', 'во', 'дворе']);
    expect(rows.find((m) => m.kind === 'service')!.words).toEqual([]);
    expect(await db.blobs.count()).toBe(1);
    expect(await db.controls.count()).toBe(0);
    expect(await db.tombstones.count()).toBe(0);
    expect((await searchMessages(db, { text: 'ёлк' })).hits.map((h) => h.msgId)).toEqual(['a'.repeat(26)]);
    expect((await searchMessages(db, { text: 'отчет' })).hits.map((h) => h.msgId)).toEqual(['b'.repeat(26)]);
    db.close();
  });
});
