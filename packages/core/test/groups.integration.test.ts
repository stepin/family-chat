// Against a real fcd: groups (create, add with and without history,
// remove, leave with two owner devices, ownership transfer), restore by
// phrase, the chat with oneself, attachments (resume, deletion on the
// server), avatars, revocation, the invitation check and the archive.

import { IDBFactory } from 'fake-indexeddb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountRuntime } from '../src/accounts.ts';
import { isApiError } from '../src/api/errors.ts';
import type { FetchFn } from '../src/api/transport.ts';
import { CoreContext } from '../src/context.ts';
import { createCore, type AccountView, type FamilyChatCore, type CoreOptions } from '../src/core.ts';
import { isCoreError } from '../src/errors.ts';
import { until, type Readable } from '../src/util/readable.ts';
import { Fcd } from './integration/fcd.ts';
import { eventually, FAST, memDb } from './support/helpers.ts';

/** `until` with a timeout (a hanging store fails the test with a clear message). */
function waitFor<T>(store: Readable<T>, predicate: (v: T) => boolean, ms = 15_000): Promise<T> {
  let last: T | undefined;
  return Promise.race([
    until(store, (v) => {
      last = v;
      return predicate(v);
    }),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out; last value: ${JSON.stringify(last, (_k, v) => (v instanceof Uint8Array ? `[${v.length} bytes]` : v))?.slice(0, 600)}`)), ms),
    ),
  ]);
}

const fcd = new Fcd();
const cores: FamilyChatCore[] = [];

function core(options: Partial<CoreOptions> = {}): FamilyChatCore {
  const c = createCore({ db: memDb(), ...FAST, ...options });
  cores.push(c);
  return c;
}

async function bodies(c: FamilyChatCore, accountId: string, chatId: string): Promise<string[]> {
  const rows = await c.db.messages
    .where('[accountId+chatId+gseq]')
    .between([accountId, chatId, -Infinity], [accountId, chatId, Infinity])
    .toArray();
  return rows.filter((m) => m.kind === 'msg').map((m) => m.body);
}

async function services(c: FamilyChatCore, accountId: string, chatId: string): Promise<string[]> {
  const rows = await c.db.messages
    .where('[accountId+chatId+gseq]')
    .between([accountId, chatId, -Infinity], [accountId, chatId, Infinity])
    .toArray();
  return rows.filter((m) => m.kind === 'service').map((m) => m.service!.type);
}

async function groupOf(c: FamilyChatCore, accountId: string, chatId: string) {
  return c.db.groups.get([accountId, chatId]);
}

/** Bytes 0..n-1 of a deterministic pattern. */
function pattern(n: number, seed = 7): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

let a: FamilyChatCore;
let b: FamilyChatCore;
let c: FamilyChatCore;
let d: FamilyChatCore;
let accA: AccountView;
let accB: AccountView;
let accC: AccountView;
let accD: AccountView;
let group = '';

beforeAll(async () => {
  await fcd.start();
});

afterAll(async () => {
  for (const x of cores.splice(0)) await x.close().catch(() => undefined);
  await fcd.dispose();
});

describe('groups and more against fcd', () => {
  it('invitation check, joining, and the chat with the inviter', async () => {
    a = core();
    b = core();
    c = core();
    d = core();
    for (const x of [a, b, c, d]) await x.start();
    accA = await a.join({ serverUrl: fcd.url, code: { adminCode: fcd.adminCode }, name: 'Мама' });

    expect(await a.checkInvite(fcd.url, 'aaaaaaaaaaaaaaaaaaaaaaaaaa')).toEqual({ status: 'invalid' });
    const invB = await a.admin.createInvite(accA.id);
    const check = await b.checkInvite(fcd.url, invB.code);
    expect(check).toMatchObject({ status: 'valid', familyName: 'Тест', createdBy: { userId: accA.userId, name: 'Мама' } });
    const joined = await b.join({ serverUrl: fcd.url, code: { invite: invB.code }, name: 'Папа' });
    accB = joined;
    expect(joined.firstChatId).toBe((await a.openChat(accA.id, accB.userId)));
    expect(await b.checkInvite(fcd.url, invB.code)).toMatchObject({ status: 'used' });

    accC = await c.join({ serverUrl: fcd.url, code: { invite: (await a.admin.createInvite(accA.id)).code }, name: 'Катя' });
    accD = await d.join({ serverUrl: fcd.url, code: { invite: (await a.admin.createInvite(accA.id)).code }, name: 'Дима' });
    await a.refreshMembers(accA.id);
    // The chat with oneself exists on every account and is pinned first.
    const list = await waitFor(a.chatList, (l) => l.length >= 1 && l[0]!.kind === 'self');
    expect(list[0]!.chatId).toBe(accA.selfChatId);
  });

  it('a group of three exchanges messages', async () => {
    group = await a.createGroup(accA.id, 'Семья', [accB.userId, accC.userId]);
    const view = await waitFor(a.group(accA.id, group), (g) => g?.version === 1);
    expect(view).toMatchObject({ name: 'Семья', isOwner: true, member: true, canSend: true, epoch: 0 });
    expect(view!.members.map((m) => m.userId).sort()).toEqual([accA.userId, accB.userId, accC.userId].sort());

    for (const [x, acc] of [
      [b, accB],
      [c, accC],
    ] as const) {
      const g = await waitFor(x.group(acc.id, group), (v) => v?.version === 1 && v.canSend);
      expect(g!.name).toBe('Семья');
      expect(g!.owner).toBe(accA.userId);
    }
    await a.send(accA.id, group, 'от мамы');
    await b.send(accB.id, group, 'от папы');
    await c.send(accC.id, group, 'от кати');
    for (const [x, acc] of [
      [a, accA],
      [b, accB],
      [c, accC],
    ] as const) {
      await eventually(async () => (await bodies(x, acc.id, group)).length === 3, 15_000, 'three group messages');
      expect((await bodies(x, acc.id, group)).sort()).toEqual(['от кати', 'от мамы', 'от папы']);
      expect(await services(x, acc.id, group)).toContain('created');
    }
    // D is not a member: nothing arrives there.
    expect(await groupOf(d, accD.id, group)).toBeUndefined();
    const listB = await waitFor(b.chatList, (l) => l.some((x) => x.chatId === group && x.title === 'Семья'));
    expect(listB.find((x) => x.chatId === group)).toMatchObject({ kind: 'group', member: true });
  });

  it('adds a member with earlier history', async () => {
    await a.addGroupMembers(accA.id, group, [accD.userId]);
    const g = await waitFor(d.group(accD.id, group), (v) => v?.version === 2 && v.canSend, 15_000);
    expect(g!.members.length).toBe(4);
    expect(g!.epoch).toBe(0);
    // Earlier messages of this epoch come through the history.
    const view = d.chat(accD.id, group);
    while (await view.loadOlder()) {
      // until nothing older
    }
    expect((await bodies(d, accD.id, group)).sort()).toEqual(['от кати', 'от мамы', 'от папы']);
    expect(await services(a, accA.id, group)).toContain('added');
    await d.send(accD.id, group, 'привет от димы');
    await eventually(async () => (await bodies(b, accB.id, group)).includes('привет от димы'), 15_000, 'D message at B');
  });

  it('removes a member: the removed one cannot read new messages, a message sent during the change arrives once', async () => {
    // B's core stops and queues a message while it still knows only epoch 0.
    await b.stop();
    const queued = await b.send(accB.id, group, 'во время смены эпохи');
    await a.removeGroupMembers(accA.id, group, [accD.userId]);
    const ga = await waitFor(a.group(accA.id, group), (v) => v?.version === 3);
    expect(ga!.epoch).toBe(1);
    expect(ga!.members.some((m) => m.userId === accD.userId)).toBe(false);

    // Drive B's outbox directly: it encrypts with epoch 0, gets 409 epoch_mismatch,
    // fetches the new key, re-encrypts with the same message id and sends again.
    const rowB = (await b.db.accounts.get(accB.id))!;
    const rt = new AccountRuntime(new CoreContext({ db: b.db, ...FAST }), rowB);
    await rt.outbox.drain();
    expect(await b.db.outbox.get([accB.id, queued])).toBeUndefined();
    const ev = await b.db.events.get([accB.id, accB.userId, queued]);
    expect(ev?.epoch).toBe(1);
    await b.start();

    // D sees that it was removed and stays read-only.
    const gd = await waitFor(d.group(accD.id, group), (v) => v?.member === false, 15_000);
    expect(gd!.left?.reason).toBe('removed');
    expect(gd!.canSend).toBe(false);
    await expect(d.send(accD.id, group, 'нельзя')).rejects.toSatisfy((e) => isCoreError(e, 'not-member'));
    expect(await services(d, accD.id, group)).toContain('you-removed');

    await a.send(accA.id, group, 'после удаления');
    for (const [x, acc] of [
      [a, accA],
      [c, accC],
    ] as const) {
      await eventually(async () => (await bodies(x, acc.id, group)).includes('после удаления'), 15_000, 'message after removal');
      const all = await bodies(x, acc.id, group);
      expect(all.filter((m) => m === 'во время смены эпохи')).toHaveLength(1);
    }
    await eventually(async () => (await bodies(b, accB.id, group)).includes('после удаления'), 15_000, 'B continues');
    // D never gets the new messages (and could not decrypt them anyway).
    await new Promise((r) => setTimeout(r, 500));
    const dBodies = await bodies(d, accD.id, group);
    expect(dBodies).not.toContain('после удаления');
    expect(dBodies).not.toContain('во время смены эпохи');
    expect(await services(a, accA.id, group)).toContain('removed');
  });

  let a2: FamilyChatCore;
  let accA2: AccountView;

  it('the chat with oneself syncs between two devices', async () => {
    a2 = core();
    await a2.start();
    accA2 = await a2.restore({ serverUrl: fcd.url, phrase: await a.recoveryPhrase(accA.userId) });
    expect(accA2.selfChatId).toBe(accA.selfChatId);
    await a.send(accA.id, accA.selfChatId, 'заметка себе');
    await eventually(async () => (await bodies(a2, accA2.id, accA.selfChatId)).includes('заметка себе'), 15_000, 'self chat on device 2');
    const list = await waitFor(a2.chatList, (l) => l[0]?.chatId === accA2.selfChatId && l[0].lastMessage?.body === 'заметка себе');
    expect(list[0]!.pinned).toBe(true);
    await a2.send(accA2.id, accA2.selfChatId, 'со второго');
    await eventually(async () => (await bodies(a, accA.id, accA.selfChatId)).includes('со второго'), 15_000, 'self chat back');
  });

  it('restore by phrase sees the group and the history of the current epoch', async () => {
    await waitFor(a2.group(accA2.id, group), (v) => v?.version === 3 && v.canSend, 15_000);
    const view = a2.chat(accA2.id, group);
    while (await view.loadOlder()) {
      // all of it
    }
    const all = await bodies(a2, accA2.id, group);
    expect(all).toContain('после удаления');
    expect(all).toContain('во время смены эпохи');
  });

  it('two devices of the owner react to the same leave with one state change', async () => {
    const before = (await groupOf(a, accA.id, group))!.state!.version;
    await c.leaveGroup(accC.id, group);
    const gc = await waitFor(c.group(accC.id, group), (v) => v?.member === false);
    expect(gc!.left?.reason).toBe('left');
    // Both owner devices see the leave; exactly one new version removes C.
    await waitFor(a.group(accA.id, group), (v) => v !== null && !v.members.some((m) => m.userId === accC.userId), 20_000);
    await waitFor(a2.group(accA2.id, group), (v) => v !== null && !v.members.some((m) => m.userId === accC.userId), 20_000);
    await new Promise((r) => setTimeout(r, 1000));
    const entry = (await a.db.groups.get([accA.id, group]))!;
    expect(entry.state!.version).toBe(before + 1);
    expect((await a2.db.groups.get([accA2.id, group]))!.state!.version).toBe(before + 1);
    expect(entry.server!.version).toBe(before + 1);
    expect(entry.state!.epoch).toBe(2);
    expect(await services(a, accA.id, group)).toContain('left');
    expect(await a.db.groupPending.count()).toBe(0);
    expect(await a2.db.groupPending.count()).toBe(0);
  });

  it('transfers ownership; the new owner renames; the old one cannot', async () => {
    await a.transferGroupOwnership(accA.id, group, accB.userId);
    const gb = await waitFor(b.group(accB.id, group), (v) => v?.isOwner === true, 15_000);
    expect(gb!.owner).toBe(accB.userId);
    await b.renameGroup(accB.id, group, 'Родители');
    await waitFor(a.group(accA.id, group), (v) => v?.name === 'Родители', 15_000);
    await expect(a.renameGroup(accA.id, group, 'Нет')).rejects.toSatisfy((e) => isCoreError(e, 'not-owner'));
    const s = await services(a, accA.id, group);
    expect(s).toContain('owner');
    expect(s).toContain('renamed');
    // The owner cannot leave without naming a successor.
    await expect(b.leaveGroup(accB.id, group)).rejects.toSatisfy((e) => isCoreError(e, 'owner-cannot-leave'));
    // Written while C is out of the group.
    await b.send(accB.id, group, 'без кати');
    await eventually(async () => (await bodies(a, accA.id, group)).includes('без кати'), 15_000, 'message without C');
  });

  it('adds a member without earlier history (new epoch)', async () => {
    const g0 = (await groupOf(b, accB.id, group))!.state!;
    await b.addGroupMembers(accB.id, group, [accC.userId], { history: false });
    const gc = await waitFor(c.group(accC.id, group), (v) => v?.member === true && v.canSend && v.version === g0.version + 1, 15_000);
    expect(gc!.epoch).toBe(g0.epoch + 1);
    await b.send(accB.id, group, 'для новенькой');
    await eventually(async () => (await bodies(c, accC.id, group)).includes('для новенькой'), 15_000, 'message after re-add');
    // C keeps its own earlier history; what was written while C was out stays unreadable (older epoch).
    const view = c.chat(accC.id, group);
    while (await view.loadOlder()) {
      // all of it
    }
    const all = await bodies(c, accC.id, group);
    expect(all).toContain('после удаления');
    expect(all).not.toContain('без кати');
  });

  it('push payloads work for group chats', async () => {
    const ev = (await a.db.events.where('[accountId+chatId+gseq]').between([accA.id, group, -Infinity], [accA.id, group, Infinity]).last())!;
    const fresh = core();
    await fresh.restore({ serverUrl: fcd.url, phrase: await c.recoveryPhrase(accC.userId) });
    // The fresh device has no group data yet: the push handler fetches states and keys itself.
    const notice = await fresh.handlePush({ chatId: group, gseq: ev.gseq });
    expect(notice).toMatchObject({ kind: 'message', chatKind: 'group', chatName: 'Родители', text: null });
  });

  it('an attachment larger than one part survives an interrupted upload and a restart', async () => {
    const factory = new IDBFactory();
    const name = 'resume-db';
    let failPart1 = true;
    const failing: FetchFn = async (input, init) => {
      if (failPart1 && init.method === 'PUT' && /\/v1\/blobs\/[a-z2-7]+\/1$/.test(input)) throw new TypeError('network down');
      return fetch(input, init);
    };
    const e1 = createCore({ db: memDb(name, factory), ...FAST, fetch: failing, backoff: { baseMs: 60_000, maxMs: 60_000 } });
    await e1.start();
    const accE = await e1.restore({ serverUrl: fcd.url, phrase: await b.recoveryPhrase(accB.userId) });
    const chat = await e1.openChat(accE.id, accA.userId);
    const data = pattern(5 * 1024 * 1024 + 123);
    const msgId = await e1.sendMessage(accE.id, chat, {
      text: 'файл',
      attachments: [{ data: new Blob([data as Uint8Array<ArrayBuffer>]), name: 'big.bin', mime: 'application/octet-stream' }],
    });
    // Part 0 goes up, part 1 fails (network): the message stays on the device.
    const blobId = (await e1.db.outbox.get([accE.id, msgId]))!.attachments![0]!.blob.id;
    await eventually(async () => (await e1.db.blobs.get([accE.id, blobId]))?.error === 'network', 15_000, 'upload interrupted');
    const transport = (await import('../src/api/transport.ts')).Transport;
    const t = new transport({ baseUrl: fcd.url });
    const row = (await e1.db.accounts.get(accE.id))!;
    const info = await t.blobInfo(row.token, blobId);
    expect(info.parts.map((p) => p.part)).toEqual([0]);
    await e1.close();

    // A new core on the same database resumes with the missing part only.
    failPart1 = false;
    const puts: string[] = [];
    const counting: FetchFn = async (input, init) => {
      if (init.method === 'PUT' && input.includes('/v1/blobs/')) puts.push(input.slice(input.lastIndexOf('/') + 1));
      return fetch(input, init);
    };
    const e2 = createCore({ db: memDb(name, factory), ...FAST, fetch: counting });
    cores.push(e2);
    await e2.start();
    await eventually(async () => !(await e2.db.outbox.get([accE.id, msgId])), 20_000, 'message sent after resume');
    expect(puts).toEqual(['1']);

    // A downloads on demand and gets the same bytes.
    await eventually(async () => (await bodies(a, accA.id, chat)).includes('файл'), 15_000, 'file message at A');
    const view = await waitFor(a.chat(accA.id, chat).messages, (m) => m.some((x) => x.body === 'файл'));
    const att = view.find((x) => x.body === 'файл')!.attachments![0]!;
    expect(att).toMatchObject({ name: 'big.bin', size: data.length, status: 'not-downloaded' });
    await a.downloadAttachment(accA.id, att.blobId);
    await waitFor(a.chat(accA.id, chat).messages, (m) => m.some((x) => x.attachments?.[0]?.status === 'ready'), 30_000);
    const blob = await a.attachmentBlob(accA.id, att.blobId);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(data);
  });

  it('an attachment deleted on the server shows as gone', async () => {
    const chat = await b.openChat(accB.id, accA.userId);
    const msgId = await b.sendMessage(accB.id, chat, {
      attachments: [{ data: new Blob([pattern(1000)]), name: 'doc.txt', mime: 'text/plain' }],
    });
    await eventually(async () => !(await b.db.outbox.get([accB.id, msgId])), 15_000, 'sent');
    const blobId = (await b.db.messages.get([accB.id, accB.userId, msgId]))!.attachments![0]!.blob.id;
    const { Transport } = await import('../src/api/transport.ts');
    await new Transport({ baseUrl: fcd.url }).deleteBlob((await b.db.accounts.get(accB.id))!.token, blobId);
    await eventually(async () => !!(await a.db.blobs.get([accA.id, blobId])), 15_000, 'message at A');
    await a.downloadAttachment(accA.id, blobId);
    await eventually(async () => (await a.db.blobs.get([accA.id, blobId]))?.status === 'gone', 15_000, 'gone');
    await expect(a.attachmentBlob(accA.id, blobId)).rejects.toSatisfy((e) => isCoreError(e, 'gone'));
    // The sender still has the local copy.
    expect((await (await b.attachmentBlob(accB.id, blobId)).arrayBuffer()).byteLength).toBe(1000);
  });

  it('images up to 10 MB download by themselves; the size limit is checked first', async () => {
    const chat = await a.openChat(accA.id, accB.userId);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, ...pattern(2000)]);
    const thumb = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    await a.sendMessage(accA.id, chat, {
      text: 'фото',
      attachments: [{ data: new Blob([jpeg]), name: 'p.jpg', mime: 'image/jpeg', width: 10, height: 20, thumb }],
    });
    const m = await waitFor(b.chat(accB.id, chat).messages, (l) => l.some((x) => x.body === 'фото' && x.attachments?.[0]?.status === 'ready'), 20_000);
    expect(m.find((x) => x.body === 'фото')!.attachments![0]).toMatchObject({ kind: 'image', width: 10, height: 20 });
    const huge = { size: 10 ** 12, slice: () => new Blob([]) } as unknown as Blob;
    await expect(
      a.sendMessage(accA.id, chat, { attachments: [{ data: huge, name: 'x.bin', mime: 'application/octet-stream' }] }),
    ).rejects.toSatisfy((e) => isCoreError(e, 'too-large'));
  });

  it('avatar round trip', async () => {
    const img = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...pattern(500)]);
    const ref = await a.setAvatar(accA.id, img);
    expect(ref.type).toBe('image/jpeg');
    await b.refreshMembers(accB.id);
    const members = await waitFor(b.members(accB.id), (l) => l.some((x) => x.userId === accA.userId && x.avatar?.sha256 === ref.sha256));
    expect(members.find((x) => x.userId === accA.userId)!.name).toBe('Мама');
    const av = await waitFor(b.avatar(accB.id, accA.userId), (v) => v !== null, 10_000);
    expect(new Uint8Array(await av!.blob.arrayBuffer())).toEqual(img);
    // Changing the name keeps the avatar.
    await a.updateProfile(accA.id, 'Мама Оля');
    await b.refreshMembers(accB.id);
    const after = await waitFor(b.members(accB.id), (l) => l.some((x) => x.name === 'Мама Оля'));
    expect(after.find((x) => x.userId === accA.userId)!.avatar?.sha256).toBe(ref.sha256);
    await expect(a.setAvatar(accA.id, new Uint8Array([1, 2, 3]))).rejects.toSatisfy((e) => isCoreError(e, 'invalid-input'));
  });

  it('verified mark follows the fingerprint', async () => {
    await b.setVerified(accB.id, accA.userId, true);
    expect((await waitFor(b.members(accB.id), (l) => l.some((x) => x.userId === accA.userId && x.verified))).length).toBeGreaterThan(0);
    await b.setVerified(accB.id, accA.userId, false);
    await waitFor(b.members(accB.id), (l) => l.some((x) => x.userId === accA.userId && !x.verified));
  });

  it('archive: export on one database, import on a fresh one gives the same messages', async () => {
    const chunks: Uint8Array[] = [];
    for await (const ch of b.exportArchive({ includeFiles: true })) chunks.push(ch);
    const fresh = core();
    // A fresh device: the identity is restored by phrase, but sync is not started.
    const accF = await fresh.restore({ serverUrl: fcd.url, phrase: await b.recoveryPhrase(accB.userId) });
    const res = await fresh.importArchive(chunks);
    expect(res.added).toBeGreaterThan(0);
    const mine = async (x: FamilyChatCore, accountId: string) =>
      (await x.db.messages.where('accountId').equals(accountId).toArray())
        .filter((m) => m.kind === 'msg')
        .map((m) => `${m.chatId}/${m.senderId}/${m.msgId}/${m.body}`)
        .sort();
    expect(await mine(fresh, accF.id)).toEqual(await mine(b, accB.id));
    // Importing again adds nothing.
    const again = await fresh.importArchive(chunks);
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(res.added + res.skipped);
    // Another identity cannot open it.
    await expect(c.importArchive(chunks)).rejects.toSatisfy((e) => isCoreError(e, 'wrong-identity'));
  });

  it('revocation: the identity is marked, nothing is encrypted to it, its devices stop, the owner removes it', async () => {
    const chat = await a.openChat(accA.id, accD.userId);
    // B (the owner now) takes D back into the group first.
    await b.addGroupMembers(accB.id, group, [accD.userId]);
    await waitFor(d.group(accD.id, group), (v) => v?.member === true && v.canSend, 15_000);
    const before = (await groupOf(b, accB.id, group))!.state!;
    await d.revokeIdentity(accD.id);
    const dView = await waitFor(d.accounts, (l) => l.some((x) => x.id === accD.id && x.revoked));
    expect(dView.find((x) => x.id === accD.id)!.status).toBe('removed');
    await a.refreshMembers(accA.id);
    await waitFor(a.members(accA.id), (l) => l.some((x) => x.userId === accD.userId && x.revoked));
    await expect(a.send(accA.id, chat, 'тебе')).rejects.toSatisfy((e) => isCoreError(e, 'peer-revoked'));
    // The owner's client got member_revoked and removed D with a new epoch.
    const g = await waitFor(b.group(accB.id, group), (v) => v !== null && !v.members.some((m) => m.userId === accD.userId), 20_000);
    expect(g!.version).toBe(before.version + 1);
    expect(g!.epoch).toBe(before.epoch + 1);
    // Signing in with that identity is refused for good.
    const again = core();
    await expect(again.restore({ serverUrl: fcd.url, phrase: await d.recoveryPhrase(accD.userId) })).rejects.toSatisfy(
      (e) => isApiError(e, 'revoked') || isCoreError(e, 'removed') || isCoreError(e, 'revoked'),
    );
  });

  it('no secrets in the server log or in diagnostics', async () => {
    for (const x of [a, b]) {
      const report = await x.diagnosticsReport();
      const row = (await x.db.accounts.toArray())[0]!;
      expect(report).not.toContain(row.token);
      expect(report).not.toContain('после удаления');
    }
  });
});
