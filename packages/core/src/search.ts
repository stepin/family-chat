// Local search over decrypted messages on this device.
// Nothing is sent to the server.
//
// Every message row carries `words`: its normalized words (NFKC, lower case,
// `ё` = `е`, letters and digits only, at least 2 characters, each once), with a
// Dexie multiEntry index. The words are computed whenever the row is written
// (sync, sending, edit, archive import), and a deleted message keeps none, so
// the index always follows the messages.
//
// A query is split the same way. Each query word matches a message word by
// prefix; a query word shorter than 3 characters only matches a whole word (a
// two-letter prefix would match half the history). Several words: all must
// match (AND). The rarest query word is looked up in the index first, the
// other words are checked on those candidates. Results are newest first.

import { Dexie } from 'dexie';
import type { CoreDb, MessageRow } from './db/schema.ts';

/** Shortest indexed word. */
export const MIN_WORD = 2;
/** Shorter query words match whole words only. */
export const MIN_PREFIX = 3;
/** Longer words are cut (keeps the index small; prefix search still finds them). */
export const MAX_WORD = 40;

const WORD = /[\p{L}\p{N}]+/gu;

/** Lower case, NFKC, `ё` → `е`. */
export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/ё/g, 'е');
}

/** Distinct normalized words of a text (at least MIN_WORD characters). */
export function tokenize(text: string): string[] {
  const out = new Set<string>();
  for (const m of normalize(text).matchAll(WORD)) {
    const w = m[0];
    if ([...w].length < MIN_WORD) continue;
    out.add(w.length > MAX_WORD ? w.slice(0, MAX_WORD) : w);
  }
  return [...out];
}

/** Words of a query in the order typed (single letters are dropped). */
export function queryWords(text: string): string[] {
  return tokenize(text);
}

/** The search words of a message row: its text and file names; none for anything but a msg. */
export function messageWords(m: Pick<MessageRow, 'kind' | 'body' | 'attachments'>): string[] {
  if (m.kind !== 'msg') return [];
  const names = (m.attachments ?? []).map((a) => a.name).join(' ');
  return tokenize(names ? `${m.body} ${names}` : m.body);
}

/** Whether one message word list satisfies one query word. */
export function wordMatches(words: readonly string[], q: string): boolean {
  return q.length >= MIN_PREFIX ? words.some((w) => w.startsWith(q)) : words.includes(q);
}

/** Whether a text matches all query words (chat and contact names in the global search). */
export function textMatches(text: string, query: readonly string[]): boolean {
  if (query.length === 0) return false;
  const words = tokenize(text);
  return query.every((q) => wordMatches(words, q));
}

export interface SearchQuery {
  readonly text: string;
  /** Only this account (default: all). */
  readonly accountId?: string;
  /** Only this chat (search inside a chat). */
  readonly chatId?: string;
  /** At most this many hits (default: all). */
  readonly limit?: number;
}

export interface SearchHit {
  readonly accountId: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly msgId: string;
  readonly gseq: number;
  readonly time: number;
  readonly body: string;
  /** File names of the message (they are searched too). */
  readonly fileNames: readonly string[];
}

export interface SearchResult {
  /** Newest first. */
  readonly hits: readonly SearchHit[];
  /** Number of matching messages (also when `limit` cut the list). */
  readonly total: number;
  /** The normalized query words (for highlighting). */
  readonly words: readonly string[];
}

function range(db: CoreDb, q: string) {
  return q.length >= MIN_PREFIX ? db.messages.where('words').startsWith(q) : db.messages.where('words').equals(q);
}

/** Searches the messages stored on this device. */
export async function searchMessages(db: CoreDb, query: SearchQuery): Promise<SearchResult> {
  const words = queryWords(query.text);
  if (words.length === 0) return { hits: [], total: 0, words };
  // The rarest word first: fewest candidates to load.
  const counts = await Promise.all(words.map((w) => range(db, w).count()));
  const order = words.map((w, i) => ({ w, n: counts[i]! })).sort((a, b) => a.n - b.n);
  if (order[0]!.n === 0) return { hits: [], total: 0, words };
  // Intersect the key sets word by word (keys only, cheap) while the candidates
  // are many; the remaining words are checked on the loaded rows.
  const id = (k: readonly [string, string, string]) => `${k[0]}\u0000${k[1]}\u0000${k[2]}`;
  let candidates = new Map<string, [string, string, string]>();
  for (const k of (await range(db, order[0]!.w).primaryKeys()) as unknown as [string, string, string][]) {
    if (query.accountId !== undefined && k[0] !== query.accountId) continue;
    candidates.set(id(k), k);
  }
  let checked = 1;
  while (checked < order.length && candidates.size > 200) {
    const next = new Map<string, [string, string, string]>();
    for (const k of (await range(db, order[checked]!.w).primaryKeys()) as unknown as [string, string, string][]) {
      const key = id(k);
      if (candidates.has(key)) next.set(key, k);
    }
    candidates = next;
    checked++;
  }
  const wanted = [...candidates.values()];
  const rest = order.slice(checked).map((o) => o.w);
  const rows = await db.messages.bulkGet(wanted);
  const matched: MessageRow[] = [];
  for (const r of rows) {
    if (!r || r.kind !== 'msg') continue;
    if (query.chatId !== undefined && r.chatId !== query.chatId) continue;
    const ws = r.words ?? [];
    if (rest.every((q) => wordMatches(ws, q))) matched.push(r);
  }
  matched.sort((a, b) => b.gseq - a.gseq);
  const limited = query.limit !== undefined ? matched.slice(0, query.limit) : matched;
  return {
    hits: limited.map((r) => ({
      accountId: r.accountId,
      chatId: r.chatId,
      senderId: r.senderId,
      msgId: r.msgId,
      gseq: r.gseq,
      time: r.time,
      body: r.body,
      fileNames: (r.attachments ?? []).map((a) => a.name),
    })),
    total: matched.length,
    words,
  };
}

/** Number of messages newer than or equal to `gseq` in a chat (how far back a chat view must reach). */
export async function countFrom(db: CoreDb, accountId: string, chatId: string, gseq: number): Promise<number> {
  return db.messages.where('[accountId+chatId+gseq]').between([accountId, chatId, gseq], [accountId, chatId, Dexie.maxKey]).count();
}

export interface Snippet {
  readonly text: string;
  /** [start, end) ranges in `text` to highlight. */
  readonly marks: readonly (readonly [number, number])[];
}

/**
 * A short piece of `text` around the first match of the query words, with
 * the matching words marked. Matching is done on the normalized text; NFKC
 * can change lengths, so marks are found per word of the original text.
 */
export function snippet(text: string, words: readonly string[], radius = 60): Snippet {
  const flat = text.replace(/\s+/g, ' ').trim();
  const marks: [number, number][] = [];
  for (const m of flat.matchAll(WORD)) {
    const w = normalize(m[0]);
    if (words.some((q) => (q.length >= MIN_PREFIX ? w.startsWith(q) : w === q))) marks.push([m.index, m.index + m[0].length]);
  }
  if (flat.length <= radius * 2) return { text: flat, marks };
  const first = marks[0]?.[0] ?? 0;
  let start = Math.max(0, first - Math.floor(radius / 2));
  if (start > 0) {
    const space = flat.lastIndexOf(' ', start);
    start = space > 0 && first - space < radius ? space + 1 : start;
  }
  const end = Math.min(flat.length, start + radius * 2);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < flat.length ? '…' : '';
  const shift = prefix.length - start;
  return {
    text: prefix + flat.slice(start, end) + suffix,
    marks: marks.filter(([a, b]) => a >= start && b <= end).map(([a, b]) => [a + shift, b + shift] as const),
  };
}
