// Edits, deletions and reactions in every arrival order, the facade
// actions over the fake server (edit, delete for everyone and for me,
// reactions, forward with files), local search and the archive round trip.

import { afterEach, describe, expect, it } from 'vitest';
import { newDevId, newMessageId, type DecodedPayload, type GroupState } from '@family-chat/protocol';
import { commitEvents, deleteLocally, type Applicable } from '../src/apply.ts';
import { CoreContext } from '../src/context.ts';
import type { AccountView, FamilyChatCore } from '../src/core.ts';
import type { CoreDb, MessageRow } from '../src/db/schema.ts';
import { isCoreError } from '../src/errors.ts';
import { normalize, searchMessages, snippet, tokenize } from '../src/search.ts';
import { until, type Readable } from '../src/util/readable.ts';
import type { MessageView } from '../src/views.ts';
import { FakeServer } from './support/fake-server.ts';
import { eventually, family, makeCore, memDb } from './support/helpers.ts';

const URL_ = 'https://fc.test';
const cores: FamilyChatCore[] = [];

afterEach(async () => {
  for (const c of cores.splice(0)) await c.close().catch(() => undefined);
});

function waitFor<T>(store: Readable<T>, predicate: (v: T) => boolean, ms = 8000): Promise<T> {
  return Promise.race([until(store, predicate), new Promise<T>((_, r) => setTimeout(() => r(new Error('timed out')), ms))]);
}

// ---- apply rules without crypto: synthesized verified events ----

const ACC = 'acc';
const ME = 'm'.repeat(26);
const ALICE = 'a'.repeat(26);
const BOB = 'b'.repeat(26);
const OWNER = 'o'.repeat(26);
const CHAT = 'c'.repeat(26);
const DEV = newDevId();

function ctxOf(db: CoreDb = memDb()): CoreContext {
  return new CoreContext({ db, fileStore: 'idb' });
}

let seqs = 0;
function item(senderId: string, gseq: number, payload: DecodedPayload, msgId: string, chatKind: 'dm' | 'group' = 'dm'): Applicable {
  return {
    chatId: CHAT,
    chatKind,
    peerId: chatKind === 'dm' ? ALICE : '',
    senderId,
    msgId,
    devId: DEV,
    epoch: 0,
    gseq,
    time: 1000 + gseq,
    body: new Uint8Array([gseq]),
    payload,
  };
}

const common = (id: string) => ({ v: 1 as const, id, dev: DEV, seq: ++seqs });

function msg(sender: string, gseq: number, id: string, body: string, extra: object = {}, kind: 'dm' | 'group' = 'dm'): Applicable {
  return item(sender, gseq, { kind: 'msg', msg: { ...common(id), t: 'msg', body, ...extra } }, id, kind);
}
function edit(sender: string, gseq: number, target: { author: string; id: string }, body: string, kind: 'dm' | 'group' = 'dm'): Applicable {
  const id = newMessageId();
  return item(sender, gseq, { kind: 'edit', edit: { ...common(id), t: 'edit', target, body } }, id, kind);
}
function del(sender: string, gseq: number, target: { author: string; id: string }, kind: 'dm' | 'group' = 'dm'): Applicable {
  const id = newMessageId();
  return item(sender, gseq, { kind: 'delete', delete: { ...common(id), t: 'delete', target, targetDev: DEV, targetSeq: 1 } }, id, kind);
}
function react(sender: string, gseq: number, target: { author: string; id: string }, emoji: string, on: boolean): Applicable {
  const id = newMessageId();
  return item(sender, gseq, { kind: 'react', react: { ...common(id), t: 'react', target, emoji, on } }, id);
}
function zeroed(sender: string, gseq: number, id: string): Applicable {
  return { ...item(sender, gseq, { kind: 'ignore', t: '', id }, id), body: new Uint8Array(0), serverDeleted: true };
}

async function snapshot(db: CoreDb) {
  const rows = (await db.messages.toArray()).sort((a, b) => a.gseq - b.gseq);
  const chat = await db.chats.get([ACC, CHAT]);
  return {
    messages: rows.map((m: MessageRow) => ({
      sender: m.senderId,
      id: m.msgId,
      kind: m.kind,
      body: m.body,
      edited: m.edited?.gseq ?? null,
      reactions: m.reactions ?? [],
      words: m.words ?? [],
      attachments: (m.attachments ?? []).length,
    })),
    last: chat?.last ? { id: chat.last.msgId, kind: chat.last.kind, body: chat.last.body } : null,
    unread: chat?.unread ?? 0,
  };
}

/** Deterministic shuffles (mulberry32). */
function shuffles<T>(list: readonly T[], n: number, seed = 7): T[][] {
  let s = seed;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: T[][] = [[...list], [...list].reverse()];
  for (let k = 0; k < n; k++) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    out.push(a);
  }
  return out;
}

function permutations<T>(list: readonly T[]): T[][] {
  if (list.length <= 1) return [[...list]];
  return list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((p) => [x, ...p]));
}

/** Applies `items` in the given order, one commit each (like separate sync pages). */
async function applyInOrder(order: readonly Applicable[], prepare?: (db: CoreDb) => Promise<void>) {
  const db = memDb();
  const ctx = ctxOf(db);
  await prepare?.(db);
  for (const it of order) await commitEvents(ctx, ACC, ME, [it]);
  const snap = await snapshot(db);
  const events = (await db.events.toArray()).map((e) => e.msgId).sort();
  db.close();
  return { snap, events };
}

describe('apply rules', { timeout: 60_000 }, () => {
  it('edits and reactions give the same result in every arrival order', async () => {
    const id = newMessageId();
    const t = { author: ALICE, id };
    const items = [
      msg(ALICE, 2, id, 'исходный текст'),
      edit(ALICE, 3, t, 'первая правка'),
      edit(ALICE, 5, t, 'вторая правка'),
      edit(BOB, 6, t, 'чужая правка'), // not the author: ignored
      react(BOB, 4, t, '👍', true),
      react(BOB, 7, t, '👍', false),
      react(ALICE, 8, t, '❤️', true),
      react(BOB, 9, t, '😂', true),
      react(ME, 10, t, '😂', true),
    ];
    const expected = {
      kind: 'msg',
      body: 'вторая правка',
      edited: 5,
      reactions: [
        { emoji: '❤️', users: [ALICE] },
        { emoji: '😂', users: [BOB, ME].sort() },
      ],
      words: ['вторая', 'правка'],
    };
    const results = [];
    for (const order of shuffles(items, 24)) {
      const { snap } = await applyInOrder(order);
      expect(snap.messages).toHaveLength(1);
      expect(snap.messages[0]).toMatchObject(expected);
      expect(snap.last).toEqual({ id, kind: 'msg', body: 'вторая правка' });
      results.push(JSON.stringify(snap));
    }
    expect(new Set(results).size).toBe(1);
  });

  it('a delete by the author wins in every order: no text, no edits, no reactions left on the device', async () => {
    const id = newMessageId();
    const t = { author: ALICE, id };
    const d = del(ALICE, 6, t);
    const items = [msg(ALICE, 2, id, 'секрет'), edit(ALICE, 3, t, 'секрет 2'), react(BOB, 4, t, '👍', true), d];
    const seen = new Set<string>();
    for (const order of permutations(items)) {
      const { snap, events } = await applyInOrder(order);
      expect(snap.messages).toEqual([{ sender: ALICE, id, kind: 'deleted', body: '', edited: null, reactions: [], words: [], attachments: 0 }]);
      expect(snap.last).toEqual({ id, kind: 'deleted', body: '' });
      // Only the delete event itself stays; the message and the edit and reaction events about it are gone.
      expect(events).toEqual([d.msgId]);
      seen.add(JSON.stringify(snap));
    }
    expect(seen.size).toBe(1);
  });

  it('"Избранное": the preview skips a deleted note and falls back to the previous one, in every order', async () => {
    const self = (a: Applicable): Applicable => ({ ...a, chatKind: 'self', peerId: ME });
    const keep = newMessageId();
    const gone = newMessageId();
    const items = [self(msg(ME, 2, keep, 'хлеб')), self(msg(ME, 3, gone, 'молоко')), self(del(ME, 4, { author: ME, id: gone }))];
    for (const order of permutations(items)) {
      const { snap } = await applyInOrder(order);
      expect(snap.messages.map((m) => m.kind)).toEqual(['msg', 'deleted']);
      expect(snap.last).toEqual({ id: keep, kind: 'msg', body: 'хлеб' });
    }
    // A fresh device: the server's zeroed record of the deleted note.
    for (const order of permutations([self(msg(ME, 2, keep, 'хлеб')), self(zeroed(ME, 3, gone))])) {
      expect((await applyInOrder(order)).snap.last).toEqual({ id: keep, kind: 'msg', body: 'хлеб' });
    }
  });

  it('a delete or an edit from someone else is ignored in a direct chat; a group owner may delete', async () => {
    const id = newMessageId();
    const t = { author: ALICE, id };
    const dm = await applyInOrder([del(BOB, 3, t), edit(BOB, 4, t, 'подмена'), msg(ALICE, 2, id, 'моё')]);
    expect(dm.snap.messages[0]).toMatchObject({ kind: 'msg', body: 'моё', edited: null });

    const owner = async (db: CoreDb) => {
      await db.chats.put({ accountId: ACC, chatId: CHAT, kind: 'group', peerId: '', createdAt: 0, last: null, readGseq: 0, unread: 0 });
      await db.groupStates.put({ accountId: ACC, chatId: CHAT, version: 1, epoch: 0, state: { owner: OWNER } as unknown as GroupState });
    };
    for (const order of permutations([msg(ALICE, 2, id, 'в группе', {}, 'group'), del(OWNER, 3, t, 'group')])) {
      const g = await applyInOrder(order, owner);
      expect(g.snap.messages[0]).toMatchObject({ kind: 'deleted' });
    }
    // Someone who is not the owner (in the state of the event's epoch) cannot.
    const notOwner = await applyInOrder([msg(ALICE, 2, id, 'в группе', {}, 'group'), del(BOB, 3, t, 'group')], owner);
    expect(notOwner.snap.messages[0]).toMatchObject({ kind: 'msg' });
  });

  it('reactions after a delete disappear; duplicates count once; two devices of one person', async () => {
    const id = newMessageId();
    const t = { author: ALICE, id };
    const r = await applyInOrder([msg(ALICE, 2, id, 'x'), del(ALICE, 3, t), react(BOB, 4, t, '👍', true)]);
    expect(r.snap.messages[0]!.reactions).toEqual([]);

    const db = memDb();
    const ctx = ctxOf(db);
    const m = msg(ALICE, 2, id, 'дубль');
    const on = react(BOB, 5, t, '🔥', true);
    expect((await commitEvents(ctx, ACC, ME, [m, m, on])).added).toBe(2);
    expect((await commitEvents(ctx, ACC, ME, [on, m])).added).toBe(0);
    expect((await snapshot(db)).messages[0]!.reactions).toEqual([{ emoji: '🔥', users: [BOB] }]);
    expect((await snapshot(db)).unread).toBe(1);
    db.close();

    // The same person on two devices: the newer value (by gseq) wins, whatever arrives first.
    const fromPhone = react(BOB, 10, t, '👍', true);
    const fromLaptop = { ...react(BOB, 12, t, '👍', false), devId: newDevId() };
    for (const order of permutations([msg(ALICE, 2, id, 'y'), fromPhone, fromLaptop])) {
      expect((await applyInOrder(order)).snap.messages[0]!.reactions).toEqual([]);
    }
  });

  it("the server's zeroed record is a placeholder only; the signed delete removes a readable message", async () => {
    const id = newMessageId();
    const t = { author: ALICE, id };
    // Zeroed record alone where nothing was known: a quiet deleted line.
    const only = await applyInOrder([zeroed(ALICE, 2, id)]);
    expect(only.snap.messages).toMatchObject([{ kind: 'deleted', id }]);
    // A readable message is not hidden by the server's record...
    const kept = await applyInOrder([msg(ALICE, 2, id, 'есть'), zeroed(ALICE, 2, id)]);
    expect(kept.snap.messages[0]).toMatchObject({ kind: 'msg', body: 'есть' });
    // ...the signed delete does it, in either order with the zeroed record.
    for (const order of permutations([zeroed(ALICE, 2, id), del(ALICE, 3, t)])) {
      expect((await applyInOrder(order)).snap.messages).toMatchObject([{ kind: 'deleted', id }]);
    }
    for (const order of permutations([msg(ALICE, 2, id, 'есть'), zeroed(ALICE, 2, id), del(ALICE, 3, t)])) {
      expect((await applyInOrder(order)).snap.messages).toMatchObject([{ kind: 'deleted', id, body: '' }]);
    }
  });

  it('delete for me removes the message and its files here; it never comes back', async () => {
    const db = memDb();
    const ctx = ctxOf(db);
    const id = newMessageId();
    const att = { blob: { id: 'q'.repeat(26), key: 'A'.repeat(43), parts: 1, partSize: 4194304, size: 3 }, name: 'f.txt', mime: 'text/plain', kind: 'file' as const };
    const m = msg(ALICE, 2, id, 'с файлом', { attachments: [att] });
    const other = msg(ALICE, 3, newMessageId(), 'другое');
    await commitEvents(ctx, ACC, ME, [m, other]);
    expect(await db.blobs.count()).toBe(1);
    await deleteLocally(ctx, ACC, ME, ALICE, id);
    expect((await snapshot(db)).messages.map((x) => x.body)).toEqual(['другое']);
    expect(await db.blobs.count()).toBe(0);
    await commitEvents(ctx, ACC, ME, [m]);
    expect((await snapshot(db)).messages.map((x) => x.body)).toEqual(['другое']);
    expect((await db.tombstones.toArray()).map((x) => x.reason)).toEqual(['local']);
    db.close();
  });

  it('a delete that fills the seq gap of the deleted event is not reported as a loss', async () => {
    const db = memDb();
    const ctx = ctxOf(db);
    const first = { ...msg(ALICE, 1, newMessageId(), 'один'), payload: { kind: 'msg', msg: { v: 1, t: 'msg', id: 'x', dev: DEV, seq: 1, body: 'один' } } } as Applicable;
    const target = { author: ALICE, id: newMessageId() };
    const delId = newMessageId();
    const d = item(ALICE, 3, { kind: 'delete', delete: { v: 1, t: 'delete', id: delId, dev: DEV, seq: 3, target, targetDev: DEV, targetSeq: 2 } }, delId);
    const r = await commitEvents(ctx, ACC, ME, [first, d]);
    expect(r.gaps).toEqual([]);
    db.close();
  });
});

// ---- search ----

describe('search', { timeout: 60_000 }, () => {
  it('normalizes Russian and English words', () => {
    expect(tokenize('Ёжик, ЁЛКА и Fish-and-chips! 2024 г.')).toEqual(['ежик', 'елка', 'fish', 'and', 'chips', '2024']);
    expect(normalize('ＡＢＣ Ё')).toBe('abc е');
    const s = snippet('Сегодня мы ходили в лес за ёлкой, а потом пили чай дома с бабушкой и дедушкой и было очень хорошо', ['елк']);
    expect(s.text.slice(s.marks[0]![0], s.marks[0]![1])).toBe('ёлкой');
  });

  it('prefix, whole short words, AND, chat filter; follows edits and deletions', async () => {
    const db = memDb();
    const ctx = ctxOf(db);
    const ids = Array.from({ length: 5 }, () => newMessageId());
    await commitEvents(ctx, ACC, ME, [
      msg(ALICE, 1, ids[0]!, 'Купи молоко и хлеб'),
      msg(ALICE, 2, ids[1]!, 'Молоко уже купила'),
      msg(BOB, 3, ids[2]!, 'Встретимся у ёлки в 6'),
      msg(BOB, 4, ids[3]!, 'Meeting at the Station'),
      msg(ALICE, 5, ids[4]!, 'не забудь про молочный суп'),
    ]);
    const find = async (text: string, chatId?: string) =>
      (await searchMessages(db, { text, ...(chatId ? { chatId } : {}) })).hits.map((h) => ids.indexOf(h.msgId));
    expect(await find('молок')).toEqual([1, 0]);
    expect(await find('МОЛ')).toEqual([4, 1, 0]);
    expect(await find('елки')).toEqual([2]);
    expect(await find('ёлк')).toEqual([2]);
    expect(await find('молоко купи')).toEqual([1, 0]); // «купи» is a prefix of «купила» too
    expect(await find('молоко хлеб')).toEqual([0]);
    expect(await find('молоко хлеб купила')).toEqual([]);
    expect(await find('station meet')).toEqual([3]);
    expect(await find('не')).toEqual([4]); // a two-letter word matches only itself
    expect(await find('у')).toEqual([]); // single letters are not searched
    expect(await find('молоко', 'other-chat')).toEqual([]);

    await commitEvents(ctx, ACC, ME, [edit(ALICE, 6, { author: ALICE, id: ids[0]! }, 'Купи кефир')]);
    expect(await find('хлеб')).toEqual([]);
    expect(await find('кефир')).toEqual([0]);
    await commitEvents(ctx, ACC, ME, [del(ALICE, 7, { author: ALICE, id: ids[1]! })]);
    expect(await find('молоко')).toEqual([]);
    await deleteLocally(ctx, ACC, ME, ALICE, ids[4]!);
    expect(await find('суп')).toEqual([]);
    db.close();
  });

  // Not part of the default run (about a minute on fake-indexeddb): FC_PERF=1 pnpm --filter @family-chat/core test m4
  it.runIf(process.env['FC_PERF'] === '1')('50 000 messages: build, query, size (fake-indexeddb)', { timeout: 600_000 }, async () => {
    const db = memDb();
    const ctx = ctxOf(db);
    const words = 'мама папа бабушка дедушка школа работа магазин молоко хлеб ёлка дача машина собака кошка завтра сегодня вечером утром позвони купи привет пока хорошо отлично встреча врач аптека поезд билет'.split(' ');
    let rnd = 1;
    const next = () => (rnd = (rnd * 48271) % 2147483647);
    const t0 = performance.now();
    const batch: Applicable[] = [];
    for (let i = 0; i < 50_000; i++) {
      const n = 4 + (next() % 12);
      const text = Array.from({ length: n }, () => words[next() % words.length]).join(' ') + ` номер${i}`;
      batch.push(msg(i % 2 ? ALICE : BOB, i + 1, newMessageId(), text));
      if (batch.length === 1000) await commitEvents(ctx, ACC, ME, batch.splice(0));
    }
    const build = performance.now() - t0;
    const q = async (text: string) => {
      const s = performance.now();
      const r = await searchMessages(db, { text, limit: 50 });
      return { ms: performance.now() - s, total: r.total };
    };
    const results = { rare: await q('номер4242'), common: await q('молоко'), and: await q('молоко хлеб завтра'), short: await q('ма') };
    const sample = await db.messages.limit(1000).toArray();
    const wordBytes = sample.reduce((n, m) => n + JSON.stringify(m.words).length, 0) / sample.length;
    console.log(JSON.stringify({ messages: 50_000, buildMs: Math.round(build), queries: results, wordsBytesPerMessage: Math.round(wordBytes) }));
    expect(results.rare.total).toBe(11); // номер4242 and номер42420..42429 (prefix)
    db.close();
  });
});

// ---- the facade over the fake server ----

async function view(core: FamilyChatCore, acc: AccountView, chat: string, pred: (m: MessageView[]) => boolean): Promise<MessageView[]> {
  return waitFor(core.chat(acc.id, chat).messages, pred);
}

describe('facade', { timeout: 60_000 }, () => {
  it('reply, edit, reactions and delete for everyone reach the other person', async () => {
    const server = new FakeServer();
    const { a, b, accA, accB } = await family(server);
    cores.push(a, b);
    const chat = await a.openChat(accA.id, accB.userId);
    const first = await a.send(accA.id, chat, 'Купи молоко');
    await view(b, accB, chat, (l) => l.some((m) => m.msgId === first));
    // Reply with a quote.
    const reply = await b.sendMessage(accB.id, chat, { text: 'Хорошо', reply: { author: accA.userId, id: first } });
    let lb = await view(b, accB, chat, (l) => l.some((m) => m.msgId === reply && m.status === 'on-server'));
    expect(lb.find((m) => m.msgId === reply)!.replyTo).toMatchObject({ available: true, body: 'Купи молоко', author: accA.userId });

    // Edit: shown at once on A, then on B with "edited".
    await a.editMessage(accA.id, chat, first, 'Купи кефир');
    await view(b, accB, chat, (l) => l.some((m) => m.msgId === first && m.body === 'Купи кефир' && m.edited === true));
    lb = await view(b, accB, chat, (l) => l.some((m) => m.msgId === reply && m.replyTo?.body === 'Купи кефир'));
    await expect(b.editMessage(accB.id, chat, first, 'нельзя')).rejects.toSatisfy((e) => isCoreError(e, 'not-allowed'));

    // Reactions: several emoji per person, the same emoji once; a tap toggles.
    await b.react(accB.id, chat, accA.userId, first, '👍', true);
    await b.react(accB.id, chat, accA.userId, first, '❤️', true);
    await a.react(accA.id, chat, accA.userId, first, '👍', true);
    let la = await view(a, accA, chat, (l) => l.find((m) => m.msgId === first)?.reactions?.length === 2 && l.find((m) => m.msgId === first)!.reactions![0]!.count === 2);
    expect(la.find((m) => m.msgId === first)!.reactions).toEqual([
      { emoji: '👍', count: 2, mine: true, users: [accA.userId, accB.userId].sort() },
      { emoji: '❤️', count: 1, mine: false, users: [accB.userId] },
    ]);
    await b.react(accB.id, chat, accA.userId, first, '❤️', false);
    await view(a, accA, chat, (l) => l.find((m) => m.msgId === first)?.reactions?.length === 1);

    // Delete for everyone: the encrypted delete, then the server record.
    await a.deleteForEveryone(accA.id, chat, accA.userId, first);
    lb = await view(b, accB, chat, (l) => l.find((m) => m.msgId === first)?.kind === 'deleted');
    expect(lb.find((m) => m.msgId === reply)!.replyTo).toMatchObject({ available: false });
    await eventually(() => server.deleteRequests.length === 1);
    expect(server.deleteRequests[0]).toMatchObject({ chatId: chat, by: accA.userId });
    await eventually(async () => (await a.db.outbox.count()) === 0);
    await expect(b.deleteForEveryone(accB.id, chat, accA.userId, reply)).rejects.toSatisfy((e) => isCoreError(e, 'not-allowed'));

    // A new device restored from the phrase sees the deleted record and the delete: a quiet line, no text.
    const fresh = makeCore(server);
    cores.push(fresh);
    await fresh.start();
    const accF = await fresh.restore({ serverUrl: URL_, phrase: await b.recoveryPhrase(accB.userId) });
    const lf = await view(fresh, accF, chat, (l) => l.some((m) => m.msgId === reply));
    expect(lf.find((m) => m.msgId === first)).toMatchObject({ kind: 'deleted', body: '' });
    expect(await fresh.db.events.where('[accountId+gseq]').between([accF.id, 0], [accF.id, Infinity]).count()).toBeGreaterThan(0);
  });

  it('delete for everyone removes my uploads from the server; delete for me stays local', async () => {
    const server = new FakeServer();
    const { a, b, accA, accB } = await family(server);
    cores.push(a, b);
    const chat = await a.openChat(accA.id, accB.userId);
    const withFile = await a.sendMessage(accA.id, chat, { text: 'файл', attachments: [{ data: new Blob([new Uint8Array([7, 8, 9])]), name: 'x.bin', mime: 'application/octet-stream' }] });
    await view(a, accA, chat, (l) => l.some((m) => m.msgId === withFile && m.status === 'on-server'));
    expect(server.blobs.size).toBe(1);
    await a.deleteForEveryone(accA.id, chat, accA.userId, withFile);
    await eventually(() => server.blobs.size === 0 && server.deleteRequests.length === 1);
    expect(await a.db.blobs.count()).toBe(0);
    await view(b, accB, chat, (l) => l.find((m) => m.msgId === withFile)?.kind === 'deleted');
    expect(await b.db.blobs.count()).toBe(0);

    const keep = await a.send(accA.id, chat, 'останется у Папы');
    await view(b, accB, chat, (l) => l.some((m) => m.msgId === keep));
    await b.deleteForMe(accB.id, chat, accA.userId, keep);
    await view(b, accB, chat, (l) => !l.some((m) => m.msgId === keep));
    expect(server.deleteRequests.length).toBe(1);
    expect((await a.db.messages.get([accA.id, accA.userId, keep]))?.kind).toBe('msg');
  });

  it('forward re-encrypts files for each destination; files that are not here must be downloaded first', async () => {
    const server = new FakeServer();
    const { a, b, accA, accB } = await family(server);
    cores.push(a, b);
    const chat = await a.openChat(accA.id, accB.userId);
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const src = await a.sendMessage(accA.id, chat, {
      text: 'смотри',
      attachments: [{ data: new Blob([data]), name: 'doc.bin', mime: 'application/octet-stream' }],
      location: { lat: 55.75, lon: 37.62, accuracy: 20 },
    });
    await view(a, accA, chat, (l) => l.some((m) => m.msgId === src && m.status === 'on-server'));
    const original = (await a.db.messages.get([accA.id, accA.userId, src]))!.attachments![0]!;

    // B has not downloaded the file: forwarding says so and sends nothing.
    await view(b, accB, chat, (l) => l.some((m) => m.msgId === src));
    await expect(b.forwardMessage(accB.id, chat, accA.userId, src, [accB.selfChatId])).rejects.toSatisfy(
      (e) => isCoreError(e, 'not-downloaded') && (e as Error).message === original.blob.id,
    );
    expect(await b.db.outbox.count()).toBe(0);

    const g = await a.createGroup(accA.id, 'Семья', [accB.userId]);
    const [toSelf, toGroup] = await a.forwardMessage(accA.id, chat, accA.userId, src, [accA.selfChatId, g]);
    const ls = await view(a, accA, accA.selfChatId, (l) => l.some((m) => m.msgId === toSelf && m.status === 'on-server'));
    const fwd = ls.find((m) => m.msgId === toSelf)!;
    expect(fwd).toMatchObject({ fwd: true, body: 'смотри', location: { lat: 55.75, lon: 37.62, accuracy: 20 } });
    const copy = (await a.db.messages.get([accA.id, accA.userId, toSelf]))!.attachments![0]!;
    expect(copy.blob.id).not.toBe(original.blob.id);
    expect(copy.blob.key).not.toBe(original.blob.key);
    expect(copy.name).toBe('doc.bin');
    // B receives the forwarded copy in the group and downloads it with the new key.
    const lg = await view(b, accB, g, (l) => l.some((m) => m.msgId === toGroup));
    const att = lg.find((m) => m.msgId === toGroup)!.attachments![0]!;
    expect(lg.find((m) => m.msgId === toGroup)!.fwd).toBe(true);
    await b.downloadAttachment(accB.id, att.blobId);
    await eventually(async () => (await b.db.blobs.get([accB.id, att.blobId]))?.status === 'done');
    expect(new Uint8Array(await (await b.attachmentBlob(accB.id, att.blobId)).arrayBuffer())).toEqual(data);
    const groupCopy = (await b.db.messages.get([accB.id, accA.userId, toGroup]))!.attachments![0]!;
    expect(new Set([original.blob.key, copy.blob.key, groupCopy.blob.key]).size).toBe(3);
  });

  it('global and in-chat search, chat view reveal', async () => {
    const server = new FakeServer();
    const { a, b, accA, accB } = await family(server);
    cores.push(a, b);
    const chat = await a.openChat(accA.id, accB.userId);
    const ids: string[] = [];
    for (let i = 0; i < 70; i++) ids.push(await a.send(accA.id, chat, i % 10 === 0 ? `Ёлка номер ${i}` : `сообщение ${i}`));
    await a.send(accA.id, accA.selfChatId, 'ёлка и игрушки');
    await eventually(async () => (await a.db.outbox.count()) === 0, 10_000);
    const g = await a.search('ЕЛК');
    expect(g.total).toBe(8);
    expect(g.messages[0]!.chatId).toBe(accA.selfChatId);
    expect((await a.search('Папа')).chats.map((c) => c.chatId)).toEqual([chat]);
    const inChat = await a.searchChat(accA.id, chat, 'елка номер');
    expect(inChat.hits.map((h) => h.body)).toEqual([60, 50, 40, 30, 20, 10, 0].map((n) => `Ёлка номер ${n}`));
    // The oldest hit is beyond the first page of the chat view: reveal loads it from the local database.
    const cv = a.chat(accA.id, chat);
    await waitFor(cv.messages, (l) => l.length === 50);
    expect(await cv.reveal(inChat.hits.at(-1)!.gseq)).toBe(true);
    await waitFor(cv.messages, (l) => l.some((m) => m.msgId === ids[0]));
    expect(await cv.reveal(999_999)).toBe(false);
  });

  it('archive: edits, deletions (for everyone and for me) and reactions come back the same', async () => {
    const server = new FakeServer();
    const { a, b, accA, accB } = await family(server);
    cores.push(a, b);
    const chat = await a.openChat(accA.id, accB.userId);
    const m1 = await a.send(accA.id, chat, 'было');
    const m2 = await a.send(accA.id, chat, 'удалю у всех');
    const m3 = await a.send(accA.id, chat, 'удалю у себя');
    const m4 = await a.send(accA.id, chat, 'реакция');
    await view(b, accB, chat, (l) => l.some((m) => m.msgId === m4));
    await a.editMessage(accA.id, chat, m1, 'стало');
    await a.deleteForEveryone(accA.id, chat, accA.userId, m2);
    await b.react(accB.id, chat, accA.userId, m4, '🎉', true);
    await view(b, accB, chat, (l) => l.find((m) => m.msgId === m1)?.body === 'стало' && l.find((m) => m.msgId === m2)?.kind === 'deleted');
    await view(b, accB, chat, (l) => l.find((m) => m.msgId === m4)?.reactions?.length === 1);
    await b.deleteForMe(accB.id, chat, accA.userId, m3);
    await eventually(async () => (await b.db.outbox.count()) === 0);

    const chunks: Uint8Array[] = [];
    for await (const c of b.exportArchive()) chunks.push(c);
    const fresh = makeCore(server);
    cores.push(fresh);
    const accF = await fresh.restore({ serverUrl: URL_, phrase: await b.recoveryPhrase(accB.userId) });
    await fresh.importArchive(chunks);
    const shape = async (x: FamilyChatCore, id: string) =>
      (await x.db.messages.where('accountId').equals(id).toArray())
        .filter((m) => m.chatId === chat)
        .sort((p, q) => p.gseq - q.gseq)
        .map((m) => ({ id: m.msgId, kind: m.kind, body: m.body, edited: !!m.edited, reactions: m.reactions ?? [], words: m.words }));
    const restored = await shape(fresh, accF.id);
    expect(restored).toEqual(await shape(b, accB.id));
    expect(restored.map((m) => m.id)).toEqual([m1, m2, m4]);
    expect(restored.map((m) => m.kind)).toEqual(['msg', 'deleted', 'msg']);
    expect((await searchMessages(fresh.db, { text: 'стало' })).total).toBe(1);
    expect((await searchMessages(fresh.db, { text: 'было' })).total).toBe(0);

    // The same archive into the device that already has these messages changes nothing.
    await b.importArchive(chunks);
    expect(await shape(b, accB.id)).toEqual(restored);
  });
});
