// The database schema only grows: a database written by the M1 code (schema
// version 1), the M2/M3 code (version 2) or the M4 code (version 3) opens with
// the current version, keeps every row and gets the new tables and indexes.

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

/** Exactly the M4 schema (commit de3ce51, src/db/schema.ts): versions 1 to 3. */
class M4Db extends M2Db {
  constructor(name: string, factory: IDBFactory) {
    super(name, factory);
    this.version(3).stores({
      messages: '[accountId+senderId+msgId], [accountId+chatId+gseq], accountId, *words',
      controls: '[accountId+senderId+msgId], [accountId+target], [accountId+chatId]',
      tombstones: '[accountId+senderId+msgId], [accountId+chatId]',
    });
  }
}

/** Exactly the M5/M6 schema (commit b7075d2, src/db/schema.ts): versions 1 to 4. */
class M5Db extends M4Db {
  constructor(name: string, factory: IDBFactory) {
    super(name, factory);
    this.version(4).stores({
      stickerPacks: '[accountId+packId], accountId',
      stickerFiles: '[accountId+file], [accountId+packId]',
      links: '[accountId+userId], accountId, [accountId+to]',
    });
  }
}

/** A stored profile envelope with this payload (the upgrade reads the payload only; it was verified when stored). */
function storedProfile(payload: object): { payload: string; sig: string } {
  return { payload: Buffer.from(JSON.stringify(payload)).toString('base64url'), sig: 'A'.repeat(86) };
}

describe('schema migration', () => {
  it('opens an M1 database, keeps its rows and adds the M2 tables and fields', async () => {
    expect(DB_VERSION).toBe(5);
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
    expect(db.verno).toBe(DB_VERSION);
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

describe('schema migration to version 4 (M5)', () => {
  it('opens an M4 database, keeps its rows and adds the sticker and link tables', async () => {
    const factory = new IDBFactory();
    const old = new M4Db('m4', factory);
    await old.open();
    await old.table('accounts').put({
      id: 'acc1', serverUrl: 'https://fc.test', serverId: 'sid', familyName: 'Семья', userId: 'u'.repeat(26), devId: 'd'.repeat(16),
      token: 't', admin: true, status: 'active', cursor: 42, initialSyncDone: true, retentionGap: null, retentionDays: 90,
      pushAvailable: false, vapidPublicKey: null, pushRegistered: false, createdAt: 1, lastSyncAt: 2, keysCursor: 3, oldest: null, revoked: false, limits: null,
    });
    const base = { accountId: 'acc1', chatId: 'c'.repeat(26), senderId: 'p'.repeat(26), devId: 'x', reply: null };
    await old.table('messages').put({ ...base, msgId: 'a'.repeat(26), seq: 1, gseq: 5, time: 6, kind: 'msg', body: 'Ёлка во дворе', words: ['елка', 'во', 'дворе'], reactions: [{ emoji: '👍', users: ['q'] }] });
    await old.table('controls').put({ accountId: 'acc1', senderId: 'q', msgId: 'r'.repeat(26), chatId: base.chatId, gseq: 6, time: 7, epoch: 0, kind: 'react', target: `${base.senderId}/${'a'.repeat(26)}`, emoji: '👍', on: true });
    await old.table('settings').put({ key: 'emoji.recent', value: ['👍'] });
    old.close();

    const db = await openDb(new CoreDb('m4', { indexedDB: factory, IDBKeyRange }));
    expect(db.verno).toBe(DB_VERSION);
    expect((await db.accounts.get('acc1'))!).toMatchObject({ cursor: 42, token: 't' });
    const m = (await db.messages.toArray())[0]!;
    expect(m).toMatchObject({ body: 'Ёлка во дворе', reactions: [{ emoji: '👍', users: ['q'] }] });
    expect(m.sticker).toBeUndefined();
    expect(await db.controls.count()).toBe(1);
    expect((await db.settings.get('emoji.recent'))!.value).toEqual(['👍']);
    expect((await searchMessages(db, { text: 'ёлк' })).hits).toHaveLength(1);
    for (const t of ['stickerPacks', 'stickerFiles', 'links']) expect(await db.table(t).count()).toBe(0);
    await db.links.put({ accountId: 'acc1', userId: 'o'.repeat(26), to: 'n'.repeat(26), fromFingerprint: 'f', toFingerprint: 'g', createdAt: 1 });
    expect(await db.links.where('[accountId+to]').equals(['acc1', 'n'.repeat(26)]).count()).toBe(1);
    db.close();
  });
});

describe('schema migration to version 5 (M7)', () => {
  it('opens an M5 database, keeps its rows and reads the gender from the stored profiles', async () => {
    const factory = new IDBFactory();
    const old = new M5Db('m5', factory);
    await old.open();
    const user = (userId: string, profile: object | null) => ({
      accountId: 'acc1', userId, identity: { payload: 'i', sig: 's' }, signPub: new Uint8Array(32), boxPub: new Uint8Array(32), created: 1,
      profile: profile ? storedProfile(profile) : null, name: profile ? 'Имя' : null, rev: profile ? 2 : -1, admin: false, removed: false, keyChange: null,
    });
    // A profile written by an M7 client and taken in by this device before it was updated.
    await old.table('users').put(user('f'.repeat(26), { v: 1, userId: 'f'.repeat(26), name: 'Мама', avatar: null, gender: 'f', rev: 2, updated: 3 }));
    await old.table('users').put(user('m'.repeat(26), { v: 1, userId: 'm'.repeat(26), name: 'Папа', avatar: null, rev: 2, updated: 3 }));
    await old.table('users').put(user('n'.repeat(26), null));
    await old.table('stickerPacks').put({ accountId: 'acc1', packId: 'p'.repeat(26), name: 'Котики' });
    await old.table('settings').put({ key: 'emoji.recent', value: ['👍'] });
    old.close();

    const db = await openDb(new CoreDb('m5', { indexedDB: factory, IDBKeyRange }));
    expect(db.verno).toBe(5);
    expect((await db.users.get(['acc1', 'f'.repeat(26)]))!).toMatchObject({ name: 'Имя', gender: 'f', rev: 2 });
    expect((await db.users.get(['acc1', 'm'.repeat(26)]))!.gender).toBe('m');
    expect((await db.users.get(['acc1', 'n'.repeat(26)]))!.gender).toBe('m');
    expect(await db.stickerPacks.count()).toBe(1);
    expect((await db.settings.get('emoji.recent'))!.value).toEqual(['👍']);
    db.close();
  });
});
