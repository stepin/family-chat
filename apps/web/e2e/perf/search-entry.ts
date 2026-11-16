// Bundled by e2e/search.perf.spec.ts and run in Chromium: fills the real
// IndexedDB with 50 000 messages and measures the local search.

import { CoreDb, messageWords, openDb, searchMessages, type MessageRow } from '@family-chat/core';

// Dexie is the core's dependency, not this app's: reach it through CoreDb.
type DexieLike = { version(n: number): { stores(s: Record<string, string>): void }; open(): Promise<unknown>; table(n: string): { bulkPut(r: unknown[]): Promise<unknown> }; close(): void };
const Dexie = Object.getPrototypeOf(CoreDb) as new (name: string) => DexieLike;

function dropDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}

const WORDS =
  'мама папа бабушка дедушка школа работа магазин молоко хлеб ёлка дача машина собака кошка завтра сегодня вечером утром позвони купи привет пока хорошо отлично встреча врач аптека поезд билет погода дождь солнце море отпуск подарок праздник день рождения торт чай кофе'.split(' ');

function text(i: number, next: () => number): string {
  const n = 4 + (next() % 14);
  return Array.from({ length: n }, () => WORDS[next() % WORDS.length]).join(' ') + ` номер${i}`;
}

async function time<T>(f: () => Promise<T>): Promise<[number, T]> {
  const t0 = performance.now();
  const r = await f();
  return [Math.round((performance.now() - t0) * 10) / 10, r];
}

/** The longest gap between animation frames while `f` runs (does the UI stay responsive?). */
async function longestFrameGap<T>(f: () => Promise<T>): Promise<[number, T]> {
  let last = performance.now();
  let worst = 0;
  let on = true;
  const tick = () => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
    if (on) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const r = await f();
  on = false;
  return [Math.round(worst), r];
}

export async function run(n: number): Promise<Record<string, unknown>> {
  let seed = 1;
  const next = () => (seed = (seed * 48271) % 2147483647);
  const rows: MessageRow[] = [];
  for (let i = 0; i < n; i++) {
    const m: MessageRow = {
      accountId: 'acc',
      chatId: `chat${i % 12}`,
      senderId: i % 3 === 0 ? 'a'.repeat(26) : 'b'.repeat(26),
      msgId: `m${String(i).padStart(25, '0')}`,
      devId: 'd'.repeat(16),
      seq: i,
      gseq: i + 1,
      time: 1_790_000_000_000 + i * 60_000,
      kind: 'msg',
      body: text(i, next),
      reply: null,
    };
    rows.push(m);
  }

  // 1. A new device or sync: every message is written with its words (batches of 1000, like sync pages).
  await dropDb('perf-new');
  const db = await openDb(new CoreDb('perf-new'));
  const estimateBefore = (await navigator.storage.estimate()).usage ?? 0;
  const [buildMs] = await time(async () => {
    for (let i = 0; i < rows.length; i += 1000) {
      await db.messages.bulkPut(rows.slice(i, i + 1000).map((m) => ({ ...m, words: messageWords(m) })));
    }
  });
  const estimateAfter = (await navigator.storage.estimate()).usage ?? 0;
  const q = async (t: string, chatId?: string) => {
    const [ms, r] = await time(() => searchMessages(db, { text: t, limit: 100, ...(chatId ? { chatId } : {}) }));
    return { ms, total: r.total };
  };
  await q('прогрев');
  const queries = {
    rareWord: await q('номер42424'),
    commonWord: await q('молоко'),
    twoWords: await q('молоко хлеб'),
    threeWords: await q('молоко хлеб завтра'),
    prefix3: await q('мол'),
    shortWhole: await q('пока'),
    inChat: await q('ёлка дача', 'chat3'),
    nothing: await q('абракадабра'),
  };
  const [frameGapMs] = await longestFrameGap(() => searchMessages(db, { text: 'молоко', limit: 100 }));
  const sample = await db.messages.limit(2000).toArray();
  const wordsBytes = sample.reduce((s, m) => s + JSON.stringify(m.words).length, 0) / sample.length;
  db.close();

  // The same messages without search words: the difference is what the index costs on disk.
  await dropDb('perf-nowords');
  const plain = await openDb(new CoreDb('perf-nowords'));
  const plainBefore = (await navigator.storage.estimate()).usage ?? 0;
  const [plainMs] = await time(async () => {
    for (let i = 0; i < rows.length; i += 1000) await plain.messages.bulkPut(rows.slice(i, i + 1000).map((m) => ({ ...m, words: [] })));
  });
  const plainAfter = (await navigator.storage.estimate()).usage ?? 0;
  plain.close();
  await dropDb('perf-nowords');

  // 2. An old database with these messages: the version 3 upgrade indexes them.
  await dropDb('perf-upgrade');
  const old = new Dexie('perf-upgrade');
  old.version(1).stores({ messages: '[accountId+senderId+msgId], [accountId+chatId+gseq], accountId' });
  await old.open();
  for (let i = 0; i < rows.length; i += 5000) await old.table('messages').bulkPut(rows.slice(i, i + 5000));
  old.close();
  const [upgradeMs, upgraded] = await time(() => openDb(new CoreDb('perf-upgrade')));
  const upgradedHits = (await searchMessages(upgraded, { text: 'номер42424' })).total;
  upgraded.close();

  return {
    messages: n,
    buildMs,
    upgradeMs,
    upgradedHits,
    queries,
    longestFrameGapDuringCommonQueryMs: frameGapMs,
    storageWithWordsMB: Math.round(((estimateAfter - estimateBefore) / 1048576) * 10) / 10,
    storageWithoutWordsMB: Math.round(((plainAfter - plainBefore) / 1048576) * 10) / 10,
    buildWithoutWordsMs: plainMs,
    wordsJsonBytesPerMessage: Math.round(wordsBytes),
  };
}

(globalThis as { perfRun?: typeof run }).perfRun = run;
