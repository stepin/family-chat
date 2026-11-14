// Groups against the in-memory server: changes and their idempotency, the
// owner's automatic removals, epoch changes while sending, events waiting
// for keys, rejected states and the error paths.

import { afterEach, describe, expect, it } from 'vitest';
import { AccountRuntime } from '../src/accounts.ts';
import { isNetworkError } from '../src/api/errors.ts';
import { CoreContext } from '../src/context.ts';
import type { AccountView, FamilyChatCore } from '../src/core.ts';
import { isCoreError } from '../src/errors.ts';
import { until, type Readable } from '../src/util/readable.ts';
import { FakeServer } from './support/fake-server.ts';
import { eventually, FAST, makeCore } from './support/helpers.ts';

const URL_ = 'https://fc.test';
const cores: FamilyChatCore[] = [];

afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => undefined);
});

function waitFor<T>(store: Readable<T>, predicate: (v: T) => boolean, ms = 4000): Promise<T> {
  return Promise.race([
    until(store, predicate),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
}

async function family(server: FakeServer, names = ['Мама', 'Папа', 'Катя']) {
  const out: { core: FamilyChatCore; acc: AccountView }[] = [];
  const first = makeCore(server);
  cores.push(first);
  await first.start();
  const accA = await first.join({ serverUrl: URL_, code: { adminCode: server.adminCode }, name: names[0]! });
  out.push({ core: first, acc: accA });
  for (const name of names.slice(1)) {
    const x = makeCore(server);
    cores.push(x);
    await x.start();
    const inv = await first.admin.createInvite(accA.id);
    out.push({ core: x, acc: await x.join({ serverUrl: URL_, code: { invite: inv.code }, name }) });
  }
  await first.refreshMembers(accA.id);
  return out;
}

async function bodies(c: FamilyChatCore, accountId: string, chatId: string): Promise<string[]> {
  const rows = await c.db.messages.where('[accountId+chatId+gseq]').between([accountId, chatId, -Infinity], [accountId, chatId, Infinity]).toArray();
  return rows.filter((m) => m.kind === 'msg').map((m) => m.body);
}

async function services(c: FamilyChatCore, accountId: string, chatId: string) {
  const rows = await c.db.messages.where('[accountId+chatId+gseq]').between([accountId, chatId, -Infinity], [accountId, chatId, Infinity]).toArray();
  return rows.filter((m) => m.kind === 'service').map((m) => m.service!);
}

describe('groups', { timeout: 30_000 }, () => {
  it('create, send, rename, add, remove, transfer, leave, with service entries', async () => {
    const server = new FakeServer();
    const [A, B, C] = await family(server);
    const g = await A!.core.createGroup(A!.acc.id, 'Семья', [B!.acc.userId]);
    await waitFor(B!.core.group(B!.acc.id, g), (v) => v?.canSend === true);
    await B!.core.send(B!.acc.id, g, 'привет');
    await eventually(async () => (await bodies(A!.core, A!.acc.id, g)).includes('привет'));

    await A!.core.renameGroup(A!.acc.id, g, 'Дом');
    await A!.core.addGroupMembers(A!.acc.id, g, [C!.acc.userId]);
    const vc = await waitFor(C!.core.group(C!.acc.id, g), (v) => v?.canSend === true && v.name === 'Дом');
    expect(vc!.epoch).toBe(0);
    await A!.core.removeGroupMembers(A!.acc.id, g, [B!.acc.userId]);
    await waitFor(B!.core.group(B!.acc.id, g), (v) => v?.member === false);
    const va = await waitFor(A!.core.group(A!.acc.id, g), (v) => v?.version === 4);
    expect(va!.epoch).toBe(1);
    await A!.core.transferGroupOwnership(A!.acc.id, g, C!.acc.userId);
    await waitFor(C!.core.group(C!.acc.id, g), (v) => v?.isOwner === true);
    await A!.core.leaveGroup(A!.acc.id, g);
    await waitFor(A!.core.group(A!.acc.id, g), (v) => v?.member === false && v.left?.reason === 'left');
    // C (owner now) removes A, who left, from the signed state.
    const vc2 = await waitFor(C!.core.group(C!.acc.id, g), (v) => v !== null && !v.members.some((m) => m.userId === A!.acc.userId));
    expect(vc2!.epoch).toBe(2);

    const types = (await services(C!.core, C!.acc.id, g)).map((s) => s.type);
    expect(types).toEqual(expect.arrayContaining(['joined', 'removed', 'owner', 'left']));
    const typesA = (await services(A!.core, A!.acc.id, g)).map((s) => s.type);
    expect(typesA).toEqual(expect.arrayContaining(['created', 'renamed', 'added', 'removed', 'owner', 'you-left']));
    // The removed member's chat stays readable but sending is refused.
    expect(await bodies(B!.core, B!.acc.id, g)).toContain('привет');
    await expect(B!.core.send(B!.acc.id, g, 'x')).rejects.toSatisfy((e) => isCoreError(e, 'not-member'));
    const listB = await waitFor(B!.core.chatList, (l) => l.some((x) => x.chatId === g));
    expect(listB.find((x) => x.chatId === g)!.member).toBe(false);
  });

  it('errors: not the owner, the owner leaving, not a member, unknown users', async () => {
    const server = new FakeServer();
    const [A, B] = await family(server, ['Мама', 'Папа']);
    const g = await A!.core.createGroup(A!.acc.id, 'Семья', [B!.acc.userId]);
    await waitFor(B!.core.group(B!.acc.id, g), (v) => v?.canSend === true);
    await expect(B!.core.renameGroup(B!.acc.id, g, 'x')).rejects.toSatisfy((e) => isCoreError(e, 'not-owner'));
    await expect(A!.core.leaveGroup(A!.acc.id, g)).rejects.toSatisfy((e) => isCoreError(e, 'owner-cannot-leave'));
    await expect(A!.core.addGroupMembers(A!.acc.id, g, ['aaaaaaaaaaaaaaaaaaaaaaaaaa'])).rejects.toSatisfy((e) => isCoreError(e, 'unknown-user'));
    await expect(A!.core.removeGroupMembers(A!.acc.id, g, [A!.acc.userId])).rejects.toSatisfy((e) => isCoreError(e, 'invalid-input'));
    await expect(A!.core.renameGroup(A!.acc.id, 'bbbbbbbbbbbbbbbbbbbbbbbbbb', 'x')).rejects.toSatisfy((e) => isCoreError(e, 'unknown-chat'));
    await B!.core.leaveGroup(B!.acc.id, g);
    await B!.core.leaveGroup(B!.acc.id, g); // twice: nothing happens
    await expect(B!.core.send(B!.acc.id, g, 'x')).rejects.toSatisfy((e) => isCoreError(e, 'not-member'));
  });

  it('a change whose answer was lost is recognised when it is sent again', async () => {
    const server = new FakeServer();
    const [A, B] = await family(server, ['Мама', 'Папа']);
    // Creation: the server stores the group, the answer is lost.
    server.failAfter('POST /v1/chats');
    await expect(A!.core.createGroup(A!.acc.id, 'Семья', [B!.acc.userId])).rejects.toSatisfy(isNetworkError);
    const pending = await A!.core.db.groupPending.toArray();
    expect(pending).toHaveLength(1);
    const g = pending[0]!.chatId;
    expect(pending[0]!.secret.length).toBe(32); // the secret was stored before sending
    await A!.core.refreshGroups(A!.acc.id); // re-sent: 409 chat_exists, same state on the server
    expect(await A!.core.db.groupPending.count()).toBe(0);
    await waitFor(A!.core.group(A!.acc.id, g), (v) => v?.version === 1 && v.canSend);

    // A state change: the same.
    server.failAfter('PUT /v1/chats/');
    await expect(A!.core.renameGroup(A!.acc.id, g, 'Дом')).rejects.toSatisfy(isNetworkError);
    expect(server.chats.get(g)!.version).toBe(2);
    await A!.core.refreshGroups(A!.acc.id); // 409 stale_version, version 2 is ours
    const v = await waitFor(A!.core.group(A!.acc.id, g), (x) => x?.name === 'Дом');
    expect(v!.version).toBe(2);
    expect(server.chats.get(g)!.version).toBe(2);
    await waitFor(B!.core.group(B!.acc.id, g), (x) => x?.name === 'Дом');
  });

  it('a change that lost the version race is rebuilt on the new state', async () => {
    const server = new FakeServer();
    const [A, B] = await family(server, ['Мама', 'Папа']);
    const g = await A!.core.createGroup(A!.acc.id, 'Семья', [B!.acc.userId]);
    // The owner's second device.
    const A2 = makeCore(server);
    cores.push(A2);
    await A2.start();
    const acc2 = await A2.restore({ serverUrl: URL_, phrase: await A!.core.recoveryPhrase(A!.acc.userId) });
    await waitFor(A2.group(acc2.id, g), (v) => v?.version === 1 && v.canSend);
    await A2.stop();
    await A!.core.renameGroup(A!.acc.id, g, 'Первое');
    // A2 still at version 1: its rename gets 409, re-reads, and goes on top of version 2.
    await A2.renameGroup(acc2.id, g, 'Второе');
    expect(server.chats.get(g)!.version).toBe(3);
    await waitFor(B!.core.group(B!.acc.id, g), (v) => v?.name === 'Второе' && v.version === 3);
  });

  it('the owner removes members who left, were removed from the family or revoked, once with two devices', async () => {
    const server = new FakeServer();
    const [A, B, C, D] = await family(server, ['Мама', 'Папа', 'Катя', 'Дима']);
    const g = await A!.core.createGroup(A!.acc.id, 'Семья', [B!.acc.userId, C!.acc.userId, D!.acc.userId]);
    const A2 = makeCore(server);
    cores.push(A2);
    await A2.start();
    const acc2 = await A2.restore({ serverUrl: URL_, phrase: await A!.core.recoveryPhrase(A!.acc.userId) });
    await waitFor(A2.group(acc2.id, g), (v) => v?.version === 1);
    await waitFor(B!.core.group(B!.acc.id, g), (v) => v?.canSend === true);

    await B!.core.leaveGroup(B!.acc.id, g);
    await waitFor(A!.core.group(A!.acc.id, g), (v) => v !== null && !v.members.some((m) => m.userId === B!.acc.userId));
    await waitFor(A2.group(acc2.id, g), (v) => v !== null && !v.members.some((m) => m.userId === B!.acc.userId));
    await new Promise((r) => setTimeout(r, 200));
    expect(server.chats.get(g)!.version).toBe(2);

    await A!.core.admin.removeUser(A!.acc.id, C!.acc.userId);
    await waitFor(A!.core.group(A!.acc.id, g), (v) => v !== null && !v.members.some((m) => m.userId === C!.acc.userId));
    await waitFor(D!.core.group(D!.acc.id, g), (v) => v?.version === 3 && v.canSend);

    await D!.core.revokeIdentity(D!.acc.id);
    await waitFor(A!.core.group(A!.acc.id, g), (v) => v !== null && v.members.length === 1, 6000);
    await new Promise((r) => setTimeout(r, 200));
    expect(server.chats.get(g)!.version).toBe(4);
    expect(server.chats.get(g)!.epoch).toBe(3);
  });

  it('a message sent during an epoch change is re-encrypted with the same id and arrives once', async () => {
    const server = new FakeServer();
    const [A, B, C] = await family(server);
    const g = await A!.core.createGroup(A!.acc.id, 'Семья', [B!.acc.userId, C!.acc.userId]);
    await waitFor(B!.core.group(B!.acc.id, g), (v) => v?.canSend === true);
    await B!.core.stop();
    const msgId = await B!.core.send(B!.acc.id, g, 'в момент смены');
    await A!.core.removeGroupMembers(A!.acc.id, g, [C!.acc.userId]);
    const row = (await B!.core.db.accounts.get(B!.acc.id))!;
    const rt = new AccountRuntime(new CoreContext({ db: B!.core.db, fetch: server.fetch, ...FAST }), row);
    await rt.outbox.drain();
    const sent = server.log.filter((e) => e.msgId === msgId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.epoch).toBe(1);
    await eventually(async () => (await bodies(A!.core, A!.acc.id, g)).includes('в момент смены'));
    expect(await bodies(C!.core, C!.acc.id, g)).not.toContain('в момент смены');
  });

  it('events that wait for a key are decrypted once the key arrives', async () => {
    const server = new FakeServer();
    const [A, B] = await family(server, ['Мама', 'Папа']);
    // B finds no keys until the test lets them through.
    server.failNext('GET /v1/keys', { status: 200, body: { keys: [], cursor: 0, more: false } }, 1000);
    const g = await A!.core.createGroup(A!.acc.id, 'Семья', [B!.acc.userId]);
    await A!.core.send(A!.acc.id, g, 'ждёт ключа');
    await eventually(async () => (await B!.core.db.pendingEvents.count()) === 1);
    expect((await B!.core.db.groups.get([B!.acc.id, g]))?.needKey).toBe(true);
    server.inject.length = 0;
    await B!.core.refreshGroups(B!.acc.id);
    await eventually(async () => (await bodies(B!.core, B!.acc.id, g)).includes('ждёт ключа'));
    expect(await B!.core.db.pendingEvents.count()).toBe(0);
  });

  it('a tampered state is rejected and stops the group', async () => {
    const server = new FakeServer();
    const [A, B] = await family(server, ['Мама', 'Папа']);
    await B!.core.stop();
    const g = await A!.core.createGroup(A!.acc.id, 'Семья', [B!.acc.userId]);
    await A!.core.renameGroup(A!.acc.id, g, 'Дом');
    const blob = server.chats.get(g)!.states!.get(2)!;
    blob[blob.length - 1]! ^= 1;
    await B!.core.start();
    const v = await waitFor(B!.core.group(B!.acc.id, g), (x) => x?.broken !== null && x?.broken !== undefined);
    expect(v!.broken).toBe('wrong-key');
    expect(v!.version).toBe(1);
    const report = await B!.core.diagnosticsReport();
    expect(report).toContain('state 2 rejected');
  });

  it('the server list differing from the signed state is shown', async () => {
    const server = new FakeServer();
    const [A, B, C] = await family(server);
    const g = await A!.core.createGroup(A!.acc.id, 'Семья', [B!.acc.userId]);
    await waitFor(B!.core.group(B!.acc.id, g), (v) => v?.canSend === true);
    server.chats.get(g)!.members.push(C!.acc.userId);
    await B!.core.refreshGroups(B!.acc.id);
    const v = await waitFor(B!.core.group(B!.acc.id, g), (x) => (x?.mismatch?.extraOnServer.length ?? 0) > 0);
    expect(v!.mismatch).toEqual({ missingOnServer: [], extraOnServer: [C!.acc.userId] });
  });

  it('a restored device reads every epoch it has keys for, and push works for the group', async () => {
    const server = new FakeServer();
    const [A, B, C] = await family(server);
    const g = await A!.core.createGroup(A!.acc.id, 'Семья', [B!.acc.userId, C!.acc.userId]);
    await A!.core.send(A!.acc.id, g, 'эпоха 0');
    await A!.core.removeGroupMembers(A!.acc.id, g, [C!.acc.userId]);
    await waitFor(B!.core.group(B!.acc.id, g), (v) => v?.epoch === 1 && v.canSend);
    await A!.core.send(A!.acc.id, g, 'эпоха 1');
    await eventually(async () => (await bodies(B!.core, B!.acc.id, g)).length === 2);
    const B2 = makeCore(server);
    cores.push(B2);
    await B2.start();
    const acc2 = await B2.restore({ serverUrl: URL_, phrase: await B!.core.recoveryPhrase(B!.acc.userId) });
    await eventually(async () => (await bodies(B2, acc2.id, g)).sort().join() === 'эпоха 0,эпоха 1');
    const last = server.log.filter((e) => e.chatId === g && !e.notice).pop()!;
    expect(await B2.handlePush({ chatId: g, gseq: last.gseq })).toMatchObject({ kind: 'message', chatKind: 'group', chatName: 'Семья' });
  });
});
