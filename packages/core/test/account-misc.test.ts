// Account pieces against the in-memory server: the chat with oneself, the
// invitation check, avatars, the verified mark, revocation, retention and the
// archive.

import { createProfileEnvelope, deriveIdentityKeys, newSeed } from '@family-chat/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { avatarType, sha256b64 } from '../src/avatars.ts';
import type { AccountView, FamilyChatCore } from '../src/core.ts';
import { isCoreError } from '../src/errors.ts';
import { until, type Readable } from '../src/util/readable.ts';
import { FakeServer } from './support/fake-server.ts';
import { eventually, makeCore } from './support/helpers.ts';

const URL_ = 'https://fc.test';
const cores: FamilyChatCore[] = [];

afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => undefined);
});

function waitFor<T>(store: Readable<T>, predicate: (v: T) => boolean, ms = 4000): Promise<T> {
  return Promise.race([until(store, predicate), new Promise<T>((_, r) => setTimeout(() => r(new Error('timed out')), ms))]);
}

async function pair(server: FakeServer) {
  const a = makeCore(server);
  const b = makeCore(server);
  cores.push(a, b);
  await a.start();
  await b.start();
  const accA = await a.join({ serverUrl: URL_, code: { adminCode: server.adminCode }, name: 'Мама' });
  const inv = await a.admin.createInvite(accA.id);
  const accB = await b.join({ serverUrl: URL_, code: { invite: inv.code }, name: 'Папа' });
  await a.refreshMembers(accA.id);
  return { a, b, accA, accB, inv };
}

async function bodies(c: FamilyChatCore, acc: AccountView, chatId: string): Promise<string[]> {
  const rows = await c.db.messages.where('[accountId+chatId+gseq]').between([acc.id, chatId, -Infinity], [acc.id, chatId, Infinity]).toArray();
  return rows.filter((m) => m.kind === 'msg').map((m) => m.body);
}

describe('account facade', { timeout: 30_000 }, () => {
  it('the chat with oneself: pinned first, synced to the second device', async () => {
    const server = new FakeServer();
    const { a, accA } = await pair(server);
    const list = await waitFor(a.chatList, (l) => l.length > 0);
    expect(list[0]).toMatchObject({ chatId: accA.selfChatId, kind: 'self', pinned: true, title: null });
    const a2 = makeCore(server);
    cores.push(a2);
    await a2.start();
    const acc2 = await a2.restore({ serverUrl: URL_, phrase: await a.recoveryPhrase(accA.userId) });
    await a.send(accA.id, accA.selfChatId, 'себе');
    await eventually(async () => (await bodies(a2, acc2, acc2.selfChatId)).includes('себе'));
  });

  it('the invitation check and the chat with the inviter', async () => {
    const server = new FakeServer();
    const { a, b, accA, accB, inv } = await pair(server);
    expect(await b.checkInvite(URL_, inv.code)).toMatchObject({ status: 'used', familyName: 'Семья', createdBy: { userId: accA.userId, name: 'Мама' } });
    expect(await b.checkInvite(URL_, 'aaaaaaaaaaaaaaaaaaaaaaaaaa')).toEqual({ status: 'invalid' });
    const fresh = await a.admin.createInvite(accA.id);
    expect(await b.checkInvite(URL_, ` ${fresh.code.toUpperCase()} `)).toMatchObject({ status: 'valid' });
    const c = makeCore(server);
    cores.push(c);
    await c.start();
    const accC = await c.join({ serverUrl: URL_, code: { invite: fresh.code }, name: 'Катя' });
    expect(accC.firstChatId).toBe(await c.openChat(accC.id, accA.userId));
    // With the admin code there is no inviter.
    expect(accB.firstChatId).toBe(await b.openChat(accB.id, accA.userId));
    // A failing check does not stop joining.
    const d = makeCore(server);
    cores.push(d);
    await d.start();
    server.failNext('POST /v1/invites/check', { status: 500, body: { error: 'internal', message: 'x' } });
    const accD = await d.join({ serverUrl: URL_, code: { invite: (await a.admin.createInvite(accA.id)).code }, name: 'Дима' });
    expect(accD.firstChatId).toBeNull();
  });

  it('avatars: type check, upload, profile, fetch by hash, cache, removal', async () => {
    const server = new FakeServer();
    const { a, b, accA, accB } = await pair(server);
    expect(avatarType(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe('image/jpeg');
    expect(avatarType(new TextEncoder().encode('RIFF1234WEBPVP8 '))).toBe('image/webp');
    expect(avatarType(new Uint8Array([1, 2, 3]))).toBeUndefined();
    await expect(a.setAvatar(accA.id, new Uint8Array([1, 2, 3, 4]))).rejects.toSatisfy((e) => isCoreError(e, 'invalid-input'));
    await expect(a.setAvatar(accA.id, new Uint8Array(0))).rejects.toSatisfy((e) => isCoreError(e, 'invalid-input'));
    await expect(a.setAvatar(accA.id, new Uint8Array(262145).fill(0xff))).rejects.toSatisfy((e) => isCoreError(e, 'too-large'));
    const img = new Uint8Array([0xff, 0xd8, 0xff, 9, 8, 7]);
    const ref = await a.setAvatar(accA.id, new Blob([img]));
    expect(ref.sha256).toBe(await sha256b64(img));
    await b.refreshMembers(accB.id);
    const av = await waitFor(b.avatar(accB.id, accA.userId), (v) => v !== null);
    expect(new Uint8Array(await av!.blob.arrayBuffer())).toEqual(img);
    const requests = server.requests.filter((r) => r.includes('/avatar/')).length;
    expect(await b.avatarBlob(accB.id, accA.userId)).not.toBeNull();
    expect(server.requests.filter((r) => r.includes('/avatar/')).length).toBe(requests); // cached
    // A different image under the same hash is refused.
    server.users.get(accA.userId)!.avatars!.get(ref.sha256)!.bytes = new Uint8Array([0xff, 0xd8, 0xff, 0]);
    await b.db.avatars.clear();
    expect(await b.avatarBlob(accB.id, accA.userId)).toBeNull();
    await a.removeAvatar(accA.id);
    await b.refreshMembers(accB.id);
    await waitFor(b.members(accB.id), (l) => l.some((m) => m.userId === accA.userId && m.avatar === null));
    expect(await b.avatarBlob(accB.id, accA.userId)).toBeNull();
  });

  it('the verified mark follows the keys', async () => {
    const server = new FakeServer();
    const { b, accA, accB } = await pair(server);
    await b.setVerified(accB.id, accA.userId, true);
    await waitFor(b.members(accB.id), (l) => l.some((m) => m.userId === accA.userId && m.verified));
    // The server offers other keys for A and B accepts them: no longer verified.
    const other = deriveIdentityKeys(newSeed());
    const row = (await b.db.users.get([accB.id, accA.userId]))!;
    await b.db.users.put({ ...row, signPub: other.signPub, boxPub: other.boxPub });
    await waitFor(b.members(accB.id), (l) => l.some((m) => m.userId === accA.userId && !m.verified));
    await expect(b.setVerified(accB.id, 'aaaaaaaaaaaaaaaaaaaaaaaaaa', true)).rejects.toSatisfy((e) => isCoreError(e, 'unknown-user'));
  });

  it('revocation: by device and by phrase; others see it and stop encrypting to it', async () => {
    const server = new FakeServer();
    const { a, b, accA, accB } = await pair(server);
    const chat = await a.openChat(accA.id, accB.userId);
    const phrase = await b.recoveryPhrase(accB.userId);
    await b.revokeIdentityByPhrase(URL_, phrase);
    const v = await waitFor(b.accounts, (l) => l.some((x) => x.revoked));
    expect(v[0]).toMatchObject({ status: 'removed', revoked: true });
    await a.refreshMembers(accA.id);
    await waitFor(a.members(accA.id), (l) => l.some((m) => m.userId === accB.userId && m.revoked));
    await expect(a.send(accA.id, chat, 'x')).rejects.toSatisfy((e) => isCoreError(e, 'peer-revoked'));
    const list = await waitFor(a.chatList, (l) => l.some((c) => c.chatId === chat && c.peerRevoked));
    expect(list.length).toBeGreaterThan(0);
    // A phrase that does not decode (checksum) is refused before anything is sent.
    await expect(a.revokeIdentityByPhrase(URL_, (await a.recoveryPhrase(accA.userId)).split(' ').reverse().join(' '))).rejects.toThrow();
    // Revoking a device's own identity: its connection says "removed, revoked".
    const c = makeCore(server);
    cores.push(c);
    await c.start();
    const accC = await c.join({ serverUrl: URL_, code: { invite: (await a.admin.createInvite(accA.id)).code }, name: 'Катя' });
    await c.revokeIdentity(accC.id);
    expect((await c.accountList())[0]).toMatchObject({ status: 'removed', revoked: true });
    await expect(c.restore({ serverUrl: URL_, phrase: await c.recoveryPhrase(accC.userId) })).rejects.toSatisfy(
      (e) => isCoreError(e, 'account-exists') || isCoreError(e, 'revoked'),
    );
  });

  it('a revocation with a bad signature is ignored', async () => {
    const server = new FakeServer();
    const { a, accA, accB } = await pair(server);
    const evil = deriveIdentityKeys(newSeed());
    // An envelope signed by another key under B's userId.
    const fake = createProfileEnvelope(evil, { name: 'x', rev: 1 });
    server.users.get(accB.userId)!.revoked = fake;
    await a.refreshMembers(accA.id);
    const m = await waitFor(a.members(accA.id), (l) => l.some((x) => x.userId === accB.userId));
    expect(m.find((x) => x.userId === accB.userId)!.revoked).toBe(false);
    expect(await a.diagnosticsReport()).toContain('revocation of');
  });

  it('retention: oldestTime and the trimmed history flag', async () => {
    const server = new FakeServer();
    const { a, b, accA, accB } = await pair(server);
    const chat = await a.openChat(accA.id, accB.userId);
    await a.send(accA.id, chat, 'старое');
    await eventually(async () => (await bodies(b, accB, chat)).includes('старое'));
    const view0 = await waitFor(b.accounts, (l) => l.some((x) => x.id === accB.id));
    expect(view0.find((x) => x.id === accB.id)!.historyTrimmed).toBe(false);
    // Retention removed everything so far: the account knows since when the server has records.
    server.expireBefore(server.nextGseq);
    await a.send(accA.id, chat, 'новое');
    const view = await waitFor(b.accounts, (l) => l.some((x) => x.id === accB.id && x.historyTrimmed && x.oldestTime !== null));
    expect(view.find((x) => x.id === accB.id)!.oldestTime).toBe(server.log[0]!.time);
  });

  it('archive: round trip, repeat, another identity, damaged data', async () => {
    const server = new FakeServer();
    const { a, b, accA, accB } = await pair(server);
    const chat = await a.openChat(accA.id, accB.userId);
    await a.send(accA.id, chat, 'в архив');
    await b.send(accB.id, accB.selfChatId, 'заметка');
    const g = await a.createGroup(accA.id, 'Семья', [accB.userId]);
    await a.send(accA.id, g, 'в группе');
    await a.sendMessage(accA.id, chat, { text: 'с файлом', attachments: [{ data: new Blob([new Uint8Array([1, 2, 3])]), name: 'f.bin', mime: 'application/octet-stream' }] });
    await eventually(async () => (await bodies(b, accB, g)).includes('в группе') && (await bodies(b, accB, chat)).includes('с файлом'));
    const blobId = (await b.db.blobs.toArray())[0]!.blobId;
    await b.downloadAttachment(accB.id, blobId);
    await eventually(async () => (await b.db.blobs.get([accB.id, blobId]))?.status === 'done');

    const chunks: Uint8Array[] = [];
    for await (const c of b.exportArchive({ includeFiles: true })) chunks.push(c);
    const stream = await b.exportArchiveStream();
    const viaStream = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(viaStream.length).toBeGreaterThan(36);

    const fresh = makeCore(server);
    cores.push(fresh);
    const accF = await fresh.restore({ serverUrl: URL_, phrase: await b.recoveryPhrase(accB.userId) });
    const res = await fresh.importArchive(new Blob(chunks as Uint8Array<ArrayBuffer>[]));
    expect(res).toMatchObject({ files: 1, newAccounts: [] });
    const list = async (x: FamilyChatCore, id: string) =>
      (await x.db.messages.where('accountId').equals(id).toArray()).filter((m) => m.kind === 'msg').map((m) => `${m.chatId}/${m.msgId}/${m.body}`).sort();
    expect(await list(fresh, accF.id)).toEqual(await list(b, accB.id));
    expect(new Uint8Array(await (await fresh.attachmentBlob(accF.id, blobId)).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await fresh.db.groups.get([accF.id, g]))!.state!.name).toBe('Семья');
    const again = await fresh.importArchive(chunks);
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(res.added + res.skipped);

    await expect(a.importArchive(chunks)).rejects.toSatisfy((e) => isCoreError(e, 'wrong-identity'));
    const damaged = chunks.map((c) => c.slice());
    damaged[damaged.length - 1]![5]! ^= 1;
    await expect(fresh.importArchive(damaged)).rejects.toSatisfy((e) => isCoreError(e, 'bad-archive'));
    await expect(fresh.importArchive([new Uint8Array(10)])).rejects.toSatisfy((e) => isCoreError(e, 'bad-archive'));

    // A device without the account: the import creates it (signing in by signature later).
    const other = makeCore(server);
    cores.push(other);
    await other.start();
    const uid = await other.createIdentity();
    await expect(other.importArchive(chunks)).rejects.toSatisfy((e) => isCoreError(e, 'wrong-identity'));
    expect(uid).not.toBe(accB.userId);
  });

  it('an archive imported where the account does not exist yet creates it', async () => {
    const server = new FakeServer();
    const { a, b, accA, accB } = await pair(server);
    const chat = await a.openChat(accA.id, accB.userId);
    await a.send(accA.id, chat, 'перенос');
    await eventually(async () => (await bodies(b, accB, chat)).includes('перенос'));
    const chunks: Uint8Array[] = [];
    for await (const c of b.exportArchive()) chunks.push(c);
    // The identity only (as after "restore" on another server): store the seed directly.
    const x = makeCore(server);
    cores.push(x);
    await x.start();
    const seed = (await b.db.identities.toArray())[0]!.seed;
    await x.db.identities.put({ userId: accB.userId, seed, createdAt: 0 });
    const res = await x.importArchive(chunks);
    expect(res.newAccounts).toHaveLength(1);
    const acc = (await x.accountList())[0]!;
    expect(acc.userId).toBe(accB.userId);
    expect(await bodies(x, acc as AccountView, chat)).toContain('перенос');
    // The new account signs in by signature and syncs.
    await eventually(async () => (await x.db.accounts.get(acc.id))!.token.length > 0, 4000);
  });
});
