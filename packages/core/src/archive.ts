// Export and import of the local history in the protocol's `.fcarchive`
// container (docs/PROTOCOL.md 17, docs/PLAN.md 7.1).
//
// The archive belongs to one identity (encrypted with a key derived from its
// selfKey) and holds every account of that identity on this device: servers
// without tokens, contacts, chats, signed group states with their epoch
// secrets, server notices, verified events exactly as received and,
// optionally, the attachment files. Records are JSON (bytes in base64url)
// except file chunks, which are binary.
//
// Import replays the events through the same decode-and-apply path as sync
// (signatures and keys are checked again) and skips what is already known.
// Edits and reactions are events too, so they replay into the same state.
// Deleted messages (M4) travel as tombstones (`everyone` and `local`), written
// before the events: their own events are no longer on this device, and the
// tombstone keeps a copy from another source from coming back.
// Records are processed as they are read: neither side holds the whole
// archive in memory.

import {
  base32Encode,
  base64urlDecode,
  base64urlEncode,
  createArchiveReader,
  createArchiveWriter,
  isProtocolError,
  newDevId,
  randomBytes,
  type ArchiveReader,
  type ArchiveRecord,
  type BlobRef,
  type IdentityKeys,
  type SignedEnvelope,
} from '@family-chat/protocol';
import type { NoticeBody, ServerEvent, ServerNotice } from './api/types.ts';
import { commitEvents, decodeEvents, importTombstones, type AccountRuntimeLike } from './apply.ts';
import { fileKey } from './attachments.ts';
import type { CoreContext } from './context.ts';
import type { AccountRow, ChatKind, TombstoneRow } from './db/schema.ts';
import { CoreError } from './errors.ts';
import { FILE_CHUNK } from './files.ts';

const R_META = 1;
const R_ACCOUNT = 2;
const R_USER = 3;
const R_CHAT = 4;
const R_GROUP_STATE = 5;
const R_EPOCH_KEY = 6;
const R_NOTICE = 7;
const R_EVENT = 8;
const R_FILE = 9;
const R_FILE_CHUNK = 10;
const R_TOMBSTONE = 11;

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const EVENT_BATCH = 200;

export interface ExportOptions {
  /** Identity to export (default: the only identity on this device). */
  readonly userId?: string;
  /** Include downloaded and sent attachment files. */
  readonly includeFiles?: boolean;
}

export interface ImportResult {
  /** Events newly stored. */
  readonly added: number;
  /** Events already known (or not verifiable). */
  readonly skipped: number;
  /** Attachment files restored. */
  readonly files: number;
  /** Local ids of accounts created by the import (they sign in by signature on first use). */
  readonly newAccounts: readonly string[];
}

function json(o: unknown): Uint8Array {
  return ENC.encode(JSON.stringify(o));
}

function parse<T>(data: Uint8Array): T {
  return JSON.parse(DEC.decode(data)) as T;
}

/** The archive as a stream of byte chunks: header first, then encrypted blocks. */
export async function* exportArchive(ctx: CoreContext, keys: IdentityKeys, options: ExportOptions = {}): AsyncGenerator<Uint8Array> {
  const { db } = ctx;
  const w = createArchiveWriter(keys);
  yield w.header;
  const emit = async function* (type: number, data: Uint8Array): AsyncGenerator<Uint8Array> {
    for (const b of await w.write(type, data)) yield b;
  };
  yield* emit(R_META, json({ v: 1, userId: keys.userId, exportedAt: ctx.clock.now(), files: options.includeFiles === true }));
  const accounts = (await db.accounts.toArray()).filter((a) => a.userId === keys.userId);
  for (const a of accounts) {
    const sid = a.serverId;
    yield* emit(R_ACCOUNT, json({ serverId: sid, serverUrl: a.serverUrl, familyName: a.familyName, userId: a.userId, retentionDays: a.retentionDays }));
    for (const u of await db.users.where('accountId').equals(a.id).toArray()) {
      yield* emit(
        R_USER,
        json({
          serverId: sid,
          userId: u.userId,
          identity: u.identity,
          profile: u.profile,
          revoked: u.revoked?.envelope ?? null,
          admin: u.admin,
          removed: u.removed,
          verifiedFingerprint: u.verifiedFingerprint ?? null,
        }),
      );
    }
    for (const c of await db.chats.where('accountId').equals(a.id).toArray()) {
      yield* emit(R_CHAT, json({ serverId: sid, chatId: c.chatId, kind: c.kind, peerId: c.peerId, readGseq: c.readGseq }));
    }
    for (const t of await db.tombstones.where('[accountId+chatId]').between([a.id, ''], [a.id, '\uffff']).toArray()) {
      if (t.reason === 'server') continue; // a placeholder; the zeroed record comes from the server again
      yield* emit(
        R_TOMBSTONE,
        json({ serverId: sid, chatId: t.chatId, senderId: t.senderId, msgId: t.msgId, reason: t.reason, by: t.by, at: t.at, gseq: t.gseq ?? null, time: t.time ?? null }),
      );
    }
    const states = (await db.groupStates.where('[accountId+chatId+version]').between([a.id, '', 0], [a.id, '￿', Infinity]).toArray()).sort(
      (x, y) => (x.chatId === y.chatId ? x.version - y.version : x.chatId < y.chatId ? -1 : 1),
    );
    for (const s of states) {
      yield* emit(R_GROUP_STATE, json({ serverId: sid, chatId: s.chatId, version: s.version, envelope: s.state.envelope }));
    }
    for (const k of await db.epochKeys.where('[accountId+chatId+epoch]').between([a.id, '', 0], [a.id, '￿', Infinity]).toArray()) {
      yield* emit(R_EPOCH_KEY, json({ serverId: sid, chatId: k.chatId, epoch: k.epoch, stateVersion: k.stateVersion, secret: base64urlEncode(k.secret) }));
    }
    for (const n of await db.notices.where('[accountId+gseq]').between([a.id, 0], [a.id, Infinity]).toArray()) {
      yield* emit(R_NOTICE, json({ serverId: sid, gseq: n.gseq, time: n.time, chatId: n.chatId, notice: n.notice }));
    }
    // Events in server order, a page at a time.
    let after = -Infinity;
    for (;;) {
      const page = await db.events.where('[accountId+gseq]').between([a.id, after], [a.id, Infinity], false, true).limit(500).toArray();
      if (page.length === 0) break;
      for (const e of page) {
        yield* emit(
          R_EVENT,
          json({
            serverId: sid,
            senderId: e.senderId,
            msgId: e.msgId,
            gseq: e.gseq,
            time: e.time,
            chatId: e.chatId,
            devId: e.devId,
            epoch: e.epoch,
            body: base64urlEncode(e.body),
          }),
        );
      }
      after = page[page.length - 1]!.gseq;
    }
    if (options.includeFiles) {
      for (const b of await db.blobs.where('accountId').equals(a.id).toArray()) {
        if (b.status !== 'done' || !b.storage) continue;
        const store = await ctx.files.of(b.storage);
        yield* emit(
          R_FILE,
          json({
            serverId: sid,
            blobId: b.blobId,
            direction: b.direction,
            chatId: b.chatId,
            senderId: b.senderId,
            msgId: b.msgId,
            ref: b.ref,
            name: b.name,
            mime: b.mime,
            kind: b.kind,
            size: b.size,
          }),
        );
        for (let i = 0; i < b.ref.parts; i++) {
          const len = i < b.ref.parts - 1 ? FILE_CHUNK : b.size - (b.ref.parts - 1) * FILE_CHUNK;
          const data = await store.read(fileKey(a.id, b.blobId), i, len);
          const head = json({ serverId: sid, blobId: b.blobId, index: i });
          const rec = new Uint8Array(2 + head.length + data.length);
          new DataView(rec.buffer).setUint16(0, head.length, false);
          rec.set(head, 2);
          rec.set(data, 2 + head.length);
          yield* emit(R_FILE_CHUNK, rec);
        }
      }
    }
  }
  for (const b of await w.finish()) yield b;
}

/** Source of an archive file. */
export type ArchiveSource = AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Blob | ReadableStream<Uint8Array>;

async function* chunks(source: ArchiveSource): AsyncGenerator<Uint8Array> {
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const step = 1 << 20;
    for (let off = 0; off < source.size; off += step) yield new Uint8Array(await source.slice(off, off + step).arrayBuffer());
    return;
  }
  if (typeof ReadableStream !== 'undefined' && source instanceof ReadableStream) {
    const reader = source.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  yield* source as AsyncIterable<Uint8Array>;
}

/** Wraps an async generator into a ReadableStream (for `new Response(stream)` or File System Access). */
export function toReadableStream(gen: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      const { done, value } = await gen.next();
      if (done) ctl.close();
      else ctl.enqueue(value);
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
}

export interface ImportHost {
  readonly ctx: CoreContext;
  /** Identity keys of the identities stored on this device. */
  identities(): Promise<IdentityKeys[]>;
  /** The runtime of an account (created on demand). */
  runtime(accountId: string): Promise<AccountRuntimeLike>;
}

function wrapError(e: unknown): never {
  if (isProtocolError(e, 'wrong-identity')) throw new CoreError('wrong-identity', 'the archive was created by another identity');
  if (isProtocolError(e)) throw new CoreError('bad-archive', `the archive cannot be read (${e.code})`);
  throw e;
}

/** Imports an archive; returns how many events were added and skipped. */
export async function importArchive(host: ImportHost, source: ArchiveSource): Promise<ImportResult> {
  const { ctx } = host;
  const ids = await host.identities();
  // Find the identity whose key opens the header.
  let pending: Uint8Array = new Uint8Array(0);
  const it = chunks(source)[Symbol.asyncIterator]();
  while (pending.length < 36) {
    const n = await it.next();
    if (n.done) break;
    const merged = new Uint8Array(pending.length + n.value.length);
    merged.set(pending);
    merged.set(n.value, pending.length);
    pending = merged;
  }
  if (pending.length < 36) throw new CoreError('bad-archive', 'the archive is too short');
  let reader: ArchiveReader | undefined;
  let keys: IdentityKeys | undefined;
  for (const k of ids) {
    const r = createArchiveReader(k);
    try {
      await r.push(pending.subarray(0, 36));
      reader = r;
      keys = k;
      break;
    } catch (e) {
      if (!isProtocolError(e, 'wrong-identity')) wrapError(e);
    }
  }
  if (!reader || !keys) throw new CoreError('wrong-identity', 'the archive was created by another identity');

  const state = new ImportState(host, keys);
  try {
    for (const r of await reader.push(pending.subarray(36))) await state.record(r);
    for (;;) {
      const n = await it.next();
      if (n.done) break;
      for (const r of await reader.push(n.value)) await state.record(r);
    }
    for (const r of await reader.finish()) await state.record(r);
  } catch (e) {
    wrapError(e);
  }
  await state.flush();
  void ctx.diag.info('archive', `archive imported: ${state.added} added, ${state.skipped} skipped, ${state.files} file(s)`);
  return { added: state.added, skipped: state.skipped, files: state.files, newAccounts: state.newAccounts };
}

interface EventRec extends ServerEvent {
  readonly serverId: string;
}

class ImportState {
  added = 0;
  skipped = 0;
  files = 0;
  readonly newAccounts: string[] = [];
  readonly #accounts = new Map<string, AccountRow>();
  #events: EventRec[] = [];
  #notices: (ServerNotice & { serverId: string })[] = [];
  readonly #fileParts = new Map<string, { accountId: string; left: number; ref: BlobRef }>();

  constructor(
    private readonly host: ImportHost,
    private readonly keys: IdentityKeys,
  ) {}

  #account(serverId: string): AccountRow {
    const a = this.#accounts.get(serverId);
    if (!a) throw new CoreError('bad-archive', 'record before its account');
    return a;
  }

  async record(r: ArchiveRecord): Promise<void> {
    const { db } = this.host.ctx;
    if (r.type === R_FILE_CHUNK) return this.#chunk(r.data);
    if (r.type !== R_EVENT && r.type !== R_NOTICE) {
      // Events need contacts, states and keys first; those come before them in the archive.
      await this.#flushNotices();
      await this.flush();
    }
    switch (r.type) {
      case R_META: {
        const m = parse<{ userId: string }>(r.data);
        if (m.userId !== this.keys.userId) throw new CoreError('wrong-identity', 'the archive was created by another identity');
        return;
      }
      case R_ACCOUNT:
        return this.#importAccount(parse(r.data));
      case R_USER: {
        const u = parse<{
          serverId: string;
          userId: string;
          identity: SignedEnvelope;
          profile: SignedEnvelope | null;
          revoked: SignedEnvelope | null;
          admin: boolean;
          removed: boolean;
          verifiedFingerprint: string | null;
        }>(r.data);
        const a = this.#account(u.serverId);
        const rt = await this.host.runtime(a.id);
        const known = await db.users.get([a.id, u.userId]);
        await rt.directory.ingest([
          { userId: u.userId, identity: u.identity, profile: u.profile, admin: known?.admin ?? u.admin, removed: known?.removed ?? u.removed, revoked: u.revoked },
        ]);
        if (u.verifiedFingerprint && !known?.verifiedFingerprint) {
          await db.users.update([a.id, u.userId], { verifiedFingerprint: u.verifiedFingerprint });
        }
        return;
      }
      case R_CHAT: {
        const c = parse<{ serverId: string; chatId: string; kind: ChatKind; peerId: string; readGseq: number }>(r.data);
        const a = this.#account(c.serverId);
        await db.transaction('rw', db.chats, async () => {
          if (await db.chats.get([a.id, c.chatId])) return;
          await db.chats.put({ accountId: a.id, chatId: c.chatId, kind: c.kind, peerId: c.peerId, createdAt: this.host.ctx.clock.now(), last: null, readGseq: c.readGseq, unread: 0 });
        });
        return;
      }
      case R_GROUP_STATE: {
        const s = parse<{ serverId: string; chatId: string; version: number; envelope: SignedEnvelope }>(r.data);
        const a = this.#account(s.serverId);
        const rt = await this.host.runtime(a.id);
        try {
          await rt.groups.importState(s.chatId, s.envelope);
        } catch (e) {
          if (!isProtocolError(e)) throw e;
          void this.host.ctx.diag.warn('archive', `group ${s.chatId} state ${s.version} rejected: ${e.code}`, a.id);
        }
        return;
      }
      case R_EPOCH_KEY: {
        const k = parse<{ serverId: string; chatId: string; epoch: number; stateVersion: number; secret: string }>(r.data);
        const a = this.#account(k.serverId);
        await db.transaction('rw', db.epochKeys, async () => {
          if (await db.epochKeys.get([a.id, k.chatId, k.epoch])) return;
          await db.epochKeys.put({ accountId: a.id, chatId: k.chatId, epoch: k.epoch, stateVersion: k.stateVersion, secret: base64urlDecode(k.secret) });
        });
        return;
      }
      case R_NOTICE: {
        const n = parse<{ serverId: string; gseq: number; time: number; chatId: string; notice: NoticeBody }>(r.data);
        this.#notices.push(n);
        return;
      }
      case R_EVENT: {
        await this.#flushNotices();
        const e = parse<Omit<EventRec, 'body'> & { body: string }>(r.data);
        this.#events.push({ ...e, body: base64urlDecode(e.body) });
        if (this.#events.length >= EVENT_BATCH) await this.flush();
        return;
      }
      case R_FILE:
        return this.#file(parse(r.data));
      case R_TOMBSTONE: {
        const t = parse<Omit<TombstoneRow, 'accountId' | 'gseq' | 'time'> & { serverId: string; gseq: number | null; time: number | null }>(r.data);
        if (t.reason !== 'everyone' && t.reason !== 'local') return;
        const a = this.#account(t.serverId);
        const { serverId: _sid, gseq, time, ...row } = t;
        await importTombstones(this.host.ctx, a.id, this.keys.userId, [{ ...row, ...(typeof gseq === 'number' && typeof time === 'number' ? { gseq, time } : {}) }]);
        return;
      }
      default:
        return; // A record type from a newer client: skipped.
    }
  }

  async #importAccount(x: { serverId: string; serverUrl: string; familyName: string; userId: string; retentionDays: number }): Promise<void> {
    const { db, clock } = this.host.ctx;
    if (x.userId !== this.keys.userId) throw new CoreError('wrong-identity');
    let a = (await db.accounts.where('serverId').equals(x.serverId).toArray()).find((r) => r.userId === x.userId);
    if (!a) {
      // No token: the first request gets 401 and the session signs in by signature with this new device id.
      a = {
        id: base32Encode(randomBytes(10)),
        serverUrl: x.serverUrl,
        serverId: x.serverId,
        familyName: x.familyName,
        userId: x.userId,
        devId: newDevId(),
        token: '',
        admin: false,
        status: 'active',
        cursor: 0,
        initialSyncDone: false,
        retentionGap: null,
        retentionDays: x.retentionDays,
        pushAvailable: false,
        vapidPublicKey: null,
        pushRegistered: false,
        createdAt: clock.now(),
        lastSyncAt: null,
        keysCursor: 0,
        oldest: null,
        revoked: false,
        limits: null,
      };
      await db.accounts.add(a);
      this.newAccounts.push(a.id);
    }
    this.#accounts.set(x.serverId, a);
  }

  async #flushNotices(): Promise<void> {
    if (this.#notices.length === 0) return;
    const byServer = new Map<string, ServerNotice[]>();
    for (const n of this.#notices) {
      const list = byServer.get(n.serverId) ?? [];
      list.push({ gseq: n.gseq, time: n.time, chatId: n.chatId, notice: n.notice });
      byServer.set(n.serverId, list);
    }
    this.#notices = [];
    for (const [sid, list] of byServer) {
      const a = this.#account(sid);
      const rt = await this.host.runtime(a.id);
      const fresh: ServerNotice[] = [];
      for (const n of list) if (!(await this.host.ctx.db.notices.get([a.id, n.gseq]))) fresh.push(n);
      await rt.groups.handleNotices(fresh.sort((x, y) => x.gseq - y.gseq));
    }
  }

  /** Decodes and stores the buffered events through the sync apply path. */
  async flush(): Promise<void> {
    if (this.#events.length === 0) return;
    const batch = this.#events;
    this.#events = [];
    const byServer = new Map<string, EventRec[]>();
    for (const e of batch) {
      const list = byServer.get(e.serverId) ?? [];
      list.push(e);
      byServer.set(e.serverId, list);
    }
    for (const [sid, list] of byServer) {
      const a = this.#account(sid);
      const rt = await this.host.runtime(a.id);
      const items = await decodeEvents(rt, list, { reconcile: false, keepPending: false, refresh: false });
      const r = await commitEvents(this.host.ctx, a.id, this.keys.userId, items);
      this.added += r.added;
      this.skipped += list.length - r.added;
    }
  }

  async #file(f: {
    serverId: string;
    blobId: string;
    direction: 'up' | 'down';
    chatId: string;
    senderId: string;
    msgId: string;
    ref: BlobRef;
    name: string;
    mime: string;
    kind: 'image' | 'voice' | 'file';
    size: number;
  }): Promise<void> {
    const { db, clock, files } = this.host.ctx;
    const a = this.#account(f.serverId);
    const existing = await db.blobs.get([a.id, f.blobId]);
    if (existing?.status === 'done') return;
    const store = await files.preferred();
    const now = clock.now();
    await db.blobs.put({
      accountId: a.id,
      blobId: f.blobId,
      direction: existing?.direction ?? f.direction,
      chatId: f.chatId,
      senderId: f.senderId,
      msgId: f.msgId,
      ref: f.ref,
      name: f.name,
      mime: f.mime,
      kind: f.kind,
      size: f.size,
      status: 'active',
      bytesDone: 0,
      partsDone: 0,
      attempts: 0,
      nextAttemptAt: now,
      error: null,
      storage: store.kind,
      createdAt: existing?.createdAt ?? now,
    });
    this.#fileParts.set(`${a.id}/${f.blobId}`, { accountId: a.id, left: f.ref.parts, ref: f.ref });
  }

  async #chunk(data: Uint8Array): Promise<void> {
    const { db, files } = this.host.ctx;
    const len = new DataView(data.buffer, data.byteOffset).getUint16(0, false);
    const head = parse<{ serverId: string; blobId: string; index: number }>(data.subarray(2, 2 + len));
    const a = this.#account(head.serverId);
    const key = `${a.id}/${head.blobId}`;
    const st = this.#fileParts.get(key);
    if (!st) return; // already on this device
    const row = await db.blobs.get([a.id, head.blobId]);
    if (!row?.storage) return;
    const store = await files.of(row.storage);
    const bytes = data.subarray(2 + len);
    await store.write(fileKey(a.id, head.blobId), head.index, bytes);
    st.left--;
    await db.blobs.update([a.id, head.blobId], { partsDone: row.partsDone + 1, bytesDone: row.bytesDone + bytes.length });
    if (st.left === 0) {
      this.#fileParts.delete(key);
      await db.blobs.update([a.id, head.blobId], { status: 'done', bytesDone: row.size });
      this.files++;
    }
  }
}
