import {
  base64urlDecode,
  base64urlEncode,
  createIdentityEnvelope,
  createProfileEnvelope,
  deriveIdentityKeys,
  dmChatId,
  newMessageId,
  newSeed,
  verifyIdentityEnvelope,
} from '@family-chat/protocol';
import { describe, expect, it } from 'vitest';
import { AccountRuntime, joinServer } from '../src/accounts.ts';
import { handlePushPayload } from '../src/core.ts';
import { isCoreError } from '../src/errors.ts';
import { enqueueMessage } from '../src/outbox.ts';
import { FakeServer } from './support/fake-server.ts';
import { FAST, makeCtx } from './support/helpers.ts';

const URL_ = 'https://fc.test';

function flipFirstByte(b64: string): string {
  const bytes = base64urlDecode(b64);
  bytes[0]! ^= 0xff;
  return base64urlEncode(bytes);
}

async function setup(server = new FakeServer()) {
  const ctxA = makeCtx(server);
  const rowA = await joinServer(ctxA, { serverUrl: URL_, code: { adminCode: server.adminCode }, name: 'A' });
  const ctxB = makeCtx(server);
  const rowB = await joinServer(ctxB, { serverUrl: URL_, code: { invite: server.newInviteCode() }, name: 'B' });
  const a = new AccountRuntime(ctxA, rowA);
  const b = new AccountRuntime(ctxB, rowB);
  await a.directory.refresh();
  await b.directory.refresh();
  return { server, ctxA, rowA, ctxB, rowB, a, b };
}

describe('directory', () => {
  it('stores verified identities and profiles; computes chat ids and keys', async () => {
    const { server, rowA, rowB, a, b } = await setup();
    const peer = await a.directory.user(rowB.userId);
    expect(peer).toMatchObject({ name: 'B', rev: 1, admin: false, removed: false, keyChange: null });
    const chatId = a.directory.chatIdFor(rowB.userId);
    expect(chatId).toBe(dmChatId(server.serverId, rowA.userId, rowB.userId));
    expect(await a.directory.peerForChat(chatId)).toBe(rowB.userId);
    expect(await a.directory.peerForChat('nope')).toBeUndefined();
    const k1 = await a.directory.chatKeys(rowB.userId);
    const k2 = await b.directory.chatKeys(rowA.userId);
    expect(k1.encKey).toEqual(k2.encKey);
    expect(await a.directory.chatKeys(rowB.userId)).toBe(k1); // cached
    // The chat with oneself (M2).
    expect(a.directory.chatIdFor(rowA.userId)).toBe(a.directory.selfChatId());
    await expect(a.directory.chatKeys('aaaaaaaaaaaaaaaaaaaaaaaaaa')).rejects.toSatisfy((e) => isCoreError(e, 'unknown-user'));
    expect((await a.directory.myIdentity()).userId).toBe(rowA.userId);
  });

  it('rejects forged identities and old or forged profiles', async () => {
    const { server, ctxA, rowA, rowB, a } = await setup();
    const userB = server.users.get(rowB.userId)!;
    const evil = deriveIdentityKeys(newSeed());
    // Profile for B signed by someone else.
    userB.profile = createProfileEnvelope(evil, { name: 'Взлом', rev: 5 });
    await a.directory.refresh();
    expect((await a.directory.user(rowB.userId))!.name).toBe('B');
    // Identity whose signature does not verify.
    const env = createIdentityEnvelope(evil);
    server.users.set(evil.userId, { ...userB, identity: { ...verifyIdentityEnvelope(env), envelope: { payload: env.payload, sig: flipFirstByte(env.sig) } } });
    await a.directory.refresh();
    expect(await a.directory.user(evil.userId)).toBeUndefined();
    await ctxA.diag.flush();
    const diag = (await ctxA.db.diagnostics.toArray()).map((d) => d.message).join('\n');
    expect(diag).toContain(`profile of ${rowB.userId} rejected`);
    expect(diag).toContain(`identity of ${evil.userId} rejected`);
    void rowA;
  });

  it('reports a changed key and keeps the old one until accepted', async () => {
    const { server, ctxA, ctxB, rowA, rowB, a } = await setup();
    const keysB = await ctxB.keys(rowB.userId);
    const oldKeys = await a.directory.chatKeys(rowB.userId);
    // Same signing key (same userId), different box key: only the owner could sign it,
    // but a compromised device or a server replaying a stale copy could present it.
    const otherBox = deriveIdentityKeys(newSeed()).boxPub;
    const changed = createIdentityEnvelope({ ...keysB, boxPub: otherBox }, 123);
    server.users.get(rowB.userId)!.identity = verifyIdentityEnvelope(changed);
    server.users.get(rowB.userId)!.profile = createProfileEnvelope(keysB, { name: 'B2', rev: 2 });
    await a.directory.refresh();
    const row = await a.directory.user(rowB.userId);
    expect(row!.keyChange).not.toBeNull();
    expect(row!.boxPub).toEqual(keysB.boxPub);
    expect(row!.name).toBe('B2'); // the profile is signed by the same signing key
    expect(await a.directory.chatKeys(rowB.userId)).toBe(oldKeys);
    await ctxA.diag.flush();
    expect((await ctxA.db.diagnostics.toArray()).some((d) => d.message.includes(`keys of ${rowB.userId} changed`))).toBe(true);
    // Reported once, not on every refresh.
    await a.directory.refresh();
    await ctxA.diag.flush();
    expect((await ctxA.db.diagnostics.toArray()).filter((d) => d.message.includes('changed')).length).toBe(1);

    await a.directory.acceptKeyChange(rowB.userId);
    const after = await a.directory.user(rowB.userId);
    expect(after!.keyChange).toBeNull();
    expect(after!.boxPub).toEqual(otherBox);
    expect((await a.directory.chatKeys(rowB.userId)).encKey).not.toEqual(oldKeys.encKey);
    await a.directory.acceptKeyChange(rowB.userId); // nothing pending: no-op
    void rowA;
  });

  it('ignores a profile with a lower revision', async () => {
    const { server, ctxB, rowB, a } = await setup();
    const keysB = await ctxB.keys(rowB.userId);
    server.users.get(rowB.userId)!.profile = createProfileEnvelope(keysB, { name: 'B5', rev: 5 });
    await a.directory.refresh();
    server.users.get(rowB.userId)!.profile = createProfileEnvelope(keysB, { name: 'B3', rev: 3 });
    await a.directory.refresh();
    expect((await a.directory.user(rowB.userId))!).toMatchObject({ name: 'B5', rev: 5 });
  });

  it('a server returning to the known keys clears the pending change', async () => {
    const { server, ctxB, rowB, a } = await setup();
    const keysB = await ctxB.keys(rowB.userId);
    const original = server.users.get(rowB.userId)!.identity;
    server.users.get(rowB.userId)!.identity = verifyIdentityEnvelope(
      createIdentityEnvelope({ ...keysB, boxPub: deriveIdentityKeys(newSeed()).boxPub }),
    );
    await a.directory.refresh();
    expect((await a.directory.user(rowB.userId))!.keyChange).not.toBeNull();
    server.users.get(rowB.userId)!.identity = original;
    await a.directory.refresh();
    expect((await a.directory.user(rowB.userId))!.keyChange).toBeNull();
  });
});

describe('push handling for a service worker', () => {
  it('fetches, decrypts and stores the event; generic when it cannot', async () => {
    const { server, ctxA, rowA, ctxB, rowB, a } = await setup();
    const chatId = a.directory.chatIdFor(rowB.userId);
    await ctxA.db.chats.put({ accountId: rowA.id, chatId, kind: 'dm', peerId: rowB.userId, createdAt: 0, last: null, readGseq: 0, unread: 0 });
    await enqueueMessage(a, chatId, 'привет');
    await a.outbox.drain();
    const gseq = server.log[0]!.gseq;

    const opts = { db: ctxB.db, fetch: server.fetch, ...FAST };
    const notice = await handlePushPayload({ chatId, gseq }, opts);
    expect(notice).toMatchObject({ kind: 'message', accountId: rowB.id, senderId: rowA.userId, senderName: 'A', familyName: 'Семья', text: null });
    expect(await ctxB.db.messages.count()).toBe(1);
    // Second time it is answered from the database.
    const n = server.requests.length;
    expect((await handlePushPayload({ chatId, gseq }, opts)).kind).toBe('message');
    expect(server.requests.length).toBe(n);

    // A corrupted event: generic notice, nothing stored.
    server.appendRaw({ chatId, senderId: rowA.userId, devId: rowA.devId, epoch: 0, msgId: newMessageId(), body: new Uint8Array(400) });
    const bad = await handlePushPayload({ chatId, gseq: server.nextGseq - 1 }, opts);
    expect(bad).toMatchObject({ kind: 'generic', accountId: rowB.id, chatId, familyName: 'Семья', chatName: 'A' });
    expect(await ctxB.db.messages.count()).toBe(1);

    // Unknown chat, garbage payload, server down.
    expect((await handlePushPayload({ chatId: 'zzzzzzzzzzzzzzzzzzzzzzzzzz', gseq: 1 }, opts)).kind).toBe('generic');
    expect((await handlePushPayload('not json', opts)).kind).toBe('generic');
    expect((await handlePushPayload({ chatId, gseq: 0 }, opts)).kind).toBe('generic');
    server.offline = true;
    expect((await handlePushPayload({ chatId, gseq: gseq + 100 }, opts)).kind).toBe('generic');
    server.offline = false;
    // A removed account is not asked.
    await ctxB.db.accounts.update(rowB.id, { status: 'removed' });
    expect((await handlePushPayload({ chatId, gseq }, opts)).kind).toBe('generic');
    // Without a usable database at all.
    expect((await handlePushPayload({ chatId, gseq }, { dbName: 'x', dbDeps: { indexedDB: {} as IDBFactory } })).kind).toBe('generic');
  });
});
