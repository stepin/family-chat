// The database schema only grows: a database written by the M1 code (schema
// version 1) opens with version 2, keeps every row and gets the new tables.

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { Dexie } from 'dexie';
import { describe, expect, it } from 'vitest';
import { CoreDb, DB_VERSION, openDb } from '../src/db/schema.ts';

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

describe('schema migration', () => {
  it('opens an M1 database, keeps its rows and adds the M2 tables and fields', async () => {
    expect(DB_VERSION).toBe(2);
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
