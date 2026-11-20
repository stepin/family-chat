// MCP against a real fcd: the server acts for an identity with the Rust
// implementation of the protocol (server/src/client), and the app's core
// (this TypeScript implementation) reads and verifies what it wrote, and the
// other way round. A helper with its own identity, then a member's own one.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore, type AccountView, type CoreOptions, type FamilyChatCore } from '../src/core.ts';
import { until, type Readable } from '../src/util/readable.ts';
import type { McpLevel } from '../src/api/types.ts';
import type { MessageView } from '../src/views.ts';
import { Fcd } from './integration/fcd.ts';
import { eventually, FAST, memDb } from './support/helpers.ts';

function waitFor<T>(store: Readable<T>, predicate: (v: T) => boolean, ms = 15_000): Promise<T> {
  return Promise.race([until(store, predicate), new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);
}

const fcd = new Fcd();
const cores: FamilyChatCore[] = [];

function core(options: Partial<CoreOptions> = {}): FamilyChatCore {
  const c = createCore({ db: memDb(), ...FAST, ...options });
  cores.push(c);
  return c;
}

function view(x: FamilyChatCore, acc: AccountView, chat: string, pred: (l: MessageView[]) => boolean): Promise<MessageView[]> {
  return waitFor(x.chat(acc.id, chat).messages, pred);
}

interface Connection {
  id: string;
  token: string;
  userId: string;
}

/** Creates a connection through the facade, as the app's screen does. */
async function connect(x: FamilyChatCore, acc: AccountView, body: { mode: 'helper' | 'me'; name: string }): Promise<Connection> {
  const made = body.mode === 'helper' ? await x.assistants.createHelper(acc.id, body.name) : await x.assistants.connectMe(acc.id, body.name);
  expect(made.token.startsWith('fcm_')).toBe(true);
  expect(made.connection.levels).toEqual(['read', 'write']);
  return { id: made.connection.id, token: made.token, userId: made.connection.userId };
}

async function setLevels(x: FamilyChatCore, acc: AccountView, conn: Connection, levels: McpLevel[]): Promise<void> {
  expect((await x.assistants.update(acc.id, conn.id, { levels })).levels).toEqual(levels);
}

/** One tool call of MCP revision 2026-07-28; returns the tool's JSON, or throws its error. */
async function tool<T = Record<string, never>>(conn: Connection, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${fcd.url}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${conn.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
      },
    }),
  });
  expect(res.status).toBe(200);
  const j = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  const value = JSON.parse(j.result.content[0]!.text) as T;
  if (j.result.isError) throw new Error(`${name}: ${JSON.stringify(value)}`);
  return value;
}

interface ToolMessage {
  id: number;
  from: string;
  text?: string;
  mine?: boolean;
  deleted?: boolean;
  edited?: string;
  replyTo?: { id: number | null; text?: string };
  reactions?: { emoji: string; by: string[] }[];
}

async function messages(conn: Connection, chat: string): Promise<ToolMessage[]> {
  return (await tool<{ messages: ToolMessage[] }>(conn, 'messages_list', { chat })).messages;
}

/** Warnings the app wrote while verifying events: none are expected. */
async function complaints(x: FamilyChatCore): Promise<string[]> {
  return (await x.db.diagnostics.toArray()).filter((d) => d.kind === 'verify' || d.kind === 'gap').map((d) => `${d.kind}: ${d.message}`);
}

let a: FamilyChatCore;
let b: FamilyChatCore;
let accA: AccountView;
let accB: AccountView;

beforeAll(async () => {
  await fcd.start();
  a = core();
  b = core();
  await a.start();
  await b.start();
  accA = await a.setUpFamily({ serverUrl: fcd.url, serverCode: fcd.adminCode, name: 'Мама' });
  accB = await b.join({ serverUrl: fcd.url, code: { invite: (await a.admin.createInvite(accA.id)).code }, name: 'Папа' });
});

afterAll(async () => {
  for (const x of cores.splice(0)) await x.close().catch(() => undefined);
  await fcd.dispose();
});

describe('MCP against fcd', () => {
  it('a helper and the app talk in a direct chat', async () => {
    const helper = await connect(a, accA, { mode: 'helper', name: 'Помощник' });
    await a.refreshMembers(accA.id);
    const chat = await a.openChat(accA.id, helper.userId);

    // The app writes; the server reads it for the helper.
    const first = await a.send(accA.id, chat, 'Напомни про молоко');
    await view(a, accA, chat, (l) => l.some((m) => m.msgId === first && m.gseq !== null));
    const seen = await messages(helper, chat);
    expect(seen.map((m) => [m.from, m.text])).toEqual([[accA.userId, 'Напомни про молоко']]);

    // The helper answers with a reply; the app verifies and shows it.
    const sent = await tool<{ id: number }>(helper, 'message_send', { chat, text: 'Напомню в шесть', reply_to: seen[0]!.id });
    let l = await view(a, accA, chat, (v) => v.some((m) => m.gseq === sent.id));
    const answer = l.find((m) => m.gseq === sent.id)!;
    expect(answer.senderId).toBe(helper.userId);
    expect(answer.body).toBe('Напомню в шесть');
    expect(answer.reply).toEqual({ author: accA.userId, id: first });

    // Edits and reactions, both ways.
    await tool(helper, 'message_edit', { chat, message: sent.id, text: 'Напомню в семь' });
    l = await view(a, accA, chat, (v) => v.some((m) => m.gseq === sent.id && m.body === 'Напомню в семь'));
    expect(l.find((m) => m.gseq === sent.id)!.edited).toBe(true);
    await tool(helper, 'message_react', { chat, message: seen[0]!.id, emoji: '👍' });
    l = await view(a, accA, chat, (v) => (v.find((m) => m.msgId === first)?.reactions?.length ?? 0) === 1);
    expect(l.find((m) => m.msgId === first)!.reactions![0]!.users).toEqual([helper.userId]);
    await a.react(accA.id, chat, helper.userId, answer.msgId, '❤️', true);
    await a.editMessage(accA.id, chat, first, 'Напомни про молоко и хлеб');
    await expect
      .poll(async () => {
        const now = await messages(helper, chat);
        return [now[0]!.text, now[1]!.reactions?.map((r) => r.emoji)];
      })
      .toEqual(['Напомни про молоко и хлеб', ['❤️']]);

    // Delete for everyone, once a person switched the level on.
    await expect(tool(helper, 'message_delete', { chat, message: sent.id, for_everyone: true })).rejects.toThrow(/level_off/);
    await setLevels(a, accA, helper, ['read', 'write', 'destructive']);
    await tool(helper, 'message_delete', { chat, message: sent.id, for_everyone: true });
    l = await view(a, accA, chat, (v) => v.some((m) => m.gseq === sent.id && m.kind === 'deleted'));
    expect(l.find((m) => m.gseq === sent.id)!.body).toBe('');

    expect(await complaints(a)).toEqual([]);
  });

  it("a member's own identity: the other side sees the member", async () => {
    const me = await connect(a, accA, { mode: 'me', name: 'Claude' });
    expect(me.userId).toBe(accA.userId);
    const chat = await b.openChat(accB.id, accA.userId);

    const asked = await b.send(accB.id, chat, 'Ты скоро?');
    await view(b, accB, chat, (l) => l.some((m) => m.msgId === asked && m.gseq !== null));
    const waiting = (await messages(me, accB.userId)).find((m) => m.text === 'Ты скоро?')!;
    expect(waiting.from).toBe(accB.userId);

    const sent = await tool<{ id: number }>(me, 'message_send', { chat: accB.userId, text: 'Через десять минут', reply_to: waiting.id });
    // The other member's app: a message from the member, verified with the member's key.
    const lb = await view(b, accB, chat, (v) => v.some((m) => m.gseq === sent.id));
    const got = lb.find((m) => m.gseq === sent.id)!;
    expect([got.senderId, got.body, got.outgoing]).toEqual([accA.userId, 'Через десять минут', false]);
    // The member's own app: its own message, written by another device.
    const la = await view(a, accA, chat, (v) => v.some((m) => m.gseq === sent.id));
    expect(la.find((m) => m.gseq === sent.id)!.outgoing).toBe(true);

    // What the member writes in the app is news for the connection, marked as its own.
    const cursor = (await tool<{ cursor: number }>(me, 'events_wait', { timeout_s: 0 })).cursor;
    await a.send(accA.id, chat, 'Уже выхожу');
    const news = await tool<{ events: { type: string; message: ToolMessage }[] }>(me, 'events_wait', { cursor, timeout_s: 10 });
    expect(news.events.map((e) => [e.type, e.message.text, e.message.mine])).toEqual([['message', 'Уже выхожу', true]]);

    expect(await complaints(a)).toEqual([]);
    expect(await complaints(b)).toEqual([]);
  });

  it('groups: the app owns one with a helper in it, a helper owns one with the apps in it', async () => {
    const helper = await connect(a, accA, { mode: 'helper', name: 'Секретарь' });
    await a.refreshMembers(accA.id);
    await b.refreshMembers(accB.id);

    // The app's group: the helper opens the key sealed to it and follows the signed states.
    const family = await a.createGroup(accA.id, 'Семья', [accB.userId, helper.userId]);
    const said = await a.send(accA.id, family, 'Кто дома?');
    await view(a, accA, family, (l) => l.some((m) => m.msgId === said && m.gseq !== null));
    await expect.poll(async () => (await messages(helper, family)).map((m) => m.text)).toEqual(['Кто дома?']);
    const info = await tool<{ name: string; ownerName: string; members: { name: string }[] }>(helper, 'group_info', { chat: family });
    expect([info.name, info.ownerName, info.members.map((m) => m.name)]).toEqual(['Семья', 'Мама', ['Мама', 'Папа', 'Секретарь']]);
    const answer = await tool<{ id: number }>(helper, 'message_send', { chat: family, text: 'Я всегда дома' });
    for (const [x, acc] of [
      [a, accA],
      [b, accB],
    ] as const) {
      const l = await view(x, acc, family, (v) => v.some((m) => m.gseq === answer.id));
      expect([l.find((m) => m.gseq === answer.id)!.senderId, l.find((m) => m.gseq === answer.id)!.body]).toEqual([helper.userId, 'Я всегда дома']);
    }
    // A rename and a new epoch (the other member is removed): the helper keeps reading and writing.
    await a.renameGroup(accA.id, family, 'Семья и секретарь');
    await a.removeGroupMembers(accA.id, family, [accB.userId]);
    const later = await a.send(accA.id, family, 'Теперь мы вдвоём');
    await view(a, accA, family, (l) => l.some((m) => m.msgId === later && m.gseq !== null));
    await expect.poll(async () => (await messages(helper, family)).at(-1)?.text).toBe('Теперь мы вдвоём');
    expect((await tool<{ name: string }>(helper, 'group_info', { chat: family })).name).toBe('Семья и секретарь');
    const again = await tool<{ id: number }>(helper, 'message_send', { chat: family, text: 'Вдвоём' });
    await view(a, accA, family, (v) => v.some((m) => m.gseq === again.id && m.body === 'Вдвоём'));

    // The helper's group: the apps accept its state, its keys and its changes.
    const made = await tool<{ chat: string }>(helper, 'group_create', { name: 'Покупки', members: [accA.userId, accB.userId] });
    const first = await tool<{ id: number }>(helper, 'message_send', { chat: made.chat, text: 'Что купить?' });
    for (const [x, acc] of [
      [a, accA],
      [b, accB],
    ] as const) {
      await waitFor(x.chatList, (l) => l.some((c) => c.chatId === made.chat && c.title === 'Покупки'));
      await view(x, acc, made.chat, (v) => v.some((m) => m.gseq === first.id && m.body === 'Что купить?'));
    }
    const fromB = await b.send(accB.id, made.chat, 'Хлеб');
    await view(b, accB, made.chat, (l) => l.some((m) => m.msgId === fromB && m.gseq !== null));
    await expect.poll(async () => (await messages(helper, made.chat)).map((m) => m.text)).toEqual(['Что купить?', 'Хлеб']);
    await tool(helper, 'group_rename', { chat: made.chat, name: 'Покупки на неделю' });
    await waitFor(a.chatList, (l) => l.some((c) => c.chatId === made.chat && c.title === 'Покупки на неделю'));
    await tool(helper, 'group_members_remove', { chat: made.chat, members: [accB.userId] });
    const secret = await tool<{ id: number }>(helper, 'message_send', { chat: made.chat, text: 'Только маме' });
    await view(a, accA, made.chat, (v) => v.some((m) => m.gseq === secret.id && m.body === 'Только маме'));
    // The app takes the group over and goes on with the helper's chain.
    await tool(helper, 'group_transfer', { chat: made.chat, to: accA.userId });
    await expect.poll(async () => {
      try {
        await a.renameGroup(accA.id, made.chat, 'Мамины покупки');
        return true;
      } catch {
        return false;
      }
    }).toBe(true);
    await expect.poll(async () => (await tool<{ name: string; ownerName: string }>(helper, 'group_info', { chat: made.chat })).name).toBe('Мамины покупки');

    expect(await complaints(a)).toEqual([]);
    expect(await complaints(b)).toEqual([]);
  });

  it('files: the app decrypts what a helper sent, a helper reads what the app sent', async () => {
    const helper = await connect(a, accA, { mode: 'helper', name: 'Архивариус' });
    await setLevels(a, accA, helper, ['read', 'write', 'files']);
    await a.refreshMembers(accA.id);
    const chat = await a.openChat(accA.id, helper.userId);

    // From the helper: a file inside the call.
    const text = 'молоко\nхлеб\n';
    const sent = await tool<{ id: number }>(helper, 'file_send', {
      chat,
      name: 'список.txt',
      data: Buffer.from(text, 'utf8').toString('base64'),
      text: 'Список',
    });
    const l = await view(a, accA, chat, (v) => v.some((m) => m.gseq === sent.id));
    const got = l.find((m) => m.gseq === sent.id)!;
    expect(got.body).toBe('Список');
    const att = got.attachments![0]!;
    expect([att.name, att.mime, att.kind, att.size]).toEqual(['список.txt', 'text/plain', 'file', Buffer.byteLength(text)]);
    await a.downloadAttachment(accA.id, att.blobId);
    await eventually(async () => (await a.db.blobs.get([accA.id, att.blobId]))?.status === 'done', 15_000, 'download');
    expect(Buffer.from(await (await a.attachmentBlob(accA.id, att.blobId)).arrayBuffer()).toString('utf8')).toBe(text);

    // From the app: the helper takes it, small in the answer, and through a one-time link.
    const bytes = new Uint8Array(3000).map((_, i) => (i * 7) % 256);
    const id = await a.sendMessage(accA.id, chat, { attachments: [{ data: new Blob([bytes]), name: 'data.bin', mime: 'application/octet-stream' }] });
    const mine = await view(a, accA, chat, (v) => v.some((m) => m.msgId === id && m.gseq !== null));
    const gseq = mine.find((m) => m.msgId === id)!.gseq!;
    const inline = await tool<{ data: string; name: string; size: number }>(helper, 'file_get', { chat, message: gseq });
    expect([inline.name, inline.size]).toEqual(['data.bin', 3000]);
    expect(new Uint8Array(Buffer.from(inline.data, 'base64'))).toEqual(bytes);
    const link = await tool<{ url: string }>(helper, 'file_get', { chat, message: gseq, as_link: true });
    const res = await fetch(link.url);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect((await fetch(link.url)).status).toBe(404);

    expect(await complaints(a)).toEqual([]);
  });

  it('the app manages connections: who sees which, a new token, deleting', async () => {
    expect((await a.serverInfo(fcd.url)).mcp).toBe(true);
    expect(await a.assistants.endpoint(accA.id)).toBe(`${fcd.url}/mcp`);
    const before = await a.assistants.list(accA.id);
    const helper = await connect(a, accA, { mode: 'helper', name: 'Временный' });
    const mine = await connect(b, accB, { mode: 'me', name: 'Папин' });

    // The administrator sees everything and manages helpers; a member sees and manages their own.
    const forAdmin = await a.assistants.list(accA.id);
    expect(forAdmin.length).toBe(before.length + 2);
    expect(forAdmin.find((c) => c.id === helper.id)).toMatchObject({ mode: 'helper', name: 'Временный', mine: true, active: true });
    expect(forAdmin.find((c) => c.id === mine.id)).toMatchObject({ mode: 'me', userId: accB.userId, mine: false });
    expect((await b.assistants.list(accB.id)).map((c) => c.id)).toEqual([mine.id]);
    await expect(b.assistants.createHelper(accB.id, 'Нельзя')).rejects.toMatchObject({ code: 'not_admin' });
    await expect(a.assistants.update(accA.id, mine.id, { levels: ['read'] })).rejects.toMatchObject({ code: 'not_allowed' });
    expect((await a.assistants.update(accA.id, helper.id, { name: 'Постоянный' })).name).toBe('Постоянный');
    // The helper is a member of the family like any other.
    await waitFor(a.members(accA.id), (l) => l.some((m) => m.userId === helper.userId));

    // A new token replaces the old one.
    await tool(helper, 'whoami');
    const token = await a.assistants.newToken(accA.id, helper.id);
    const res = await fetch(`${fcd.url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${helper.token}` }, body: '{}' });
    expect(res.status).toBe(401);
    expect((await tool<{ userId: string }>({ ...helper, token }, 'whoami')).userId).toBe(helper.userId);

    // Deleting: the token stops working, and a helper leaves the family.
    await a.assistants.remove(accA.id, helper.id);
    await b.assistants.remove(accB.id, mine.id);
    expect((await a.assistants.list(accA.id)).map((c) => c.id)).toEqual(before.map((c) => c.id));
    await waitFor(a.members(accA.id), (l) => l.find((m) => m.userId === helper.userId)?.removed === true);
  });
});
