// Attachments (docs/API.md 8, docs/PROTOCOL.md 16).
//
// Sending: each file is copied once into app-owned storage (OPFS or
// IndexedDB, files.ts), then encrypted part by part on the fly and uploaded
// in 4 MiB parts. After a restart the uploader asks the server which parts
// exist (GET /v1/blobs/<id>) and re-sends the missing ones: the same bytes
// with the same key encrypt to the same ciphertext. The message itself is
// sent by the outbox only after every part of every attachment is uploaded.
//
// Receiving: descriptors are validated by the protocol package when the
// event is decoded; images and voice up to 10 MB are downloaded
// automatically, the rest on demand. Parts are decrypted one by one into
// app-owned storage. At most one part (plus its ciphertext) is in memory.
//
// Image preparation (resize, EXIF removal, thumbnail) needs browser APIs and
// is the UI's job: it passes the prepared bytes, dimensions and thumbnail.

import {
  base64urlEncode,
  blobPartLength,
  checkAttachmentInput,
  decryptBlobPart,
  encryptBlobPart,
  IMAGE_TYPES,
  isProtocolError,
  MAX_ATTACHMENTS,
  newBlob,
  VOICE_TYPES,
  type Attachment,
  type AttachmentKind,
} from '@family-chat/protocol';
import { isApiError, isTransient } from './api/errors.ts';
import type { AccountRuntimeLike } from './apply.ts';
import { describeError } from './db/diagnostics.ts';
import type { BlobRow, BlobStatus } from './db/schema.ts';
import { CoreError, isCoreError } from './errors.ts';
import { FILE_CHUNK, roomFor, type FileStores } from './files.ts';
import { backoffDelay } from './util/backoff.ts';
import { Waker } from './util/clock.ts';

/** One file to send. For images the UI passes the already prepared (resized, EXIF-free) bytes. */
export interface AttachmentInput {
  /** The file contents (a File or Blob). Read once, in 4 MiB slices. */
  readonly data: Blob;
  /** File name shown to others (1-128 characters, no path separators). */
  readonly name: string;
  /** MIME type, lower case, without parameters. */
  readonly mime: string;
  /** Default: 'image' for image MIME types with width and height, 'voice' with durationMs and peaks, else 'file'. */
  readonly kind?: AttachmentKind;
  /** Pixel size (required for images). */
  readonly width?: number;
  readonly height?: number;
  /** Inline JPEG thumbnail, at most 4096 bytes (images and files). */
  readonly thumb?: Uint8Array;
  /** Voice: duration in ms and exactly 64 peaks 0-255. */
  readonly durationMs?: number;
  readonly peaks?: readonly number[];
}


/** Largest file the server accepts, from `/v1/hello` (cached on the account). */
export async function maxBlobBytes(rt: AccountRuntimeLike): Promise<number> {
  const { ctx, session } = rt;
  const acc = await ctx.db.accounts.get(session.accountId);
  const cached = acc?.limits;
  if (cached && ctx.clock.now() - cached.fetchedAt < 3_600_000) return cached.maxBlobBytes;
  const hello = await session.transport.hello();
  const limits = {
    maxFileMb: hello.maxFileMb,
    maxPartBytes: hello.maxPartBytes,
    maxBlobBytes: hello.maxBlobBytes,
    maxAvatarBytes: hello.maxAvatarBytes,
    maxGroupMembers: hello.maxGroupMembers,
    fetchedAt: ctx.clock.now(),
  };
  await ctx.db.accounts.update(session.accountId, { limits });
  return limits.maxBlobBytes;
}

function kindOf(input: AttachmentInput): AttachmentKind {
  if (input.kind) return input.kind;
  if (IMAGE_TYPES.includes(input.mime) && input.width !== undefined && input.height !== undefined) return 'image';
  if (VOICE_TYPES.includes(input.mime) && input.durationMs !== undefined && input.peaks !== undefined) return 'voice';
  return 'file';
}

export function fileKey(accountId: string, blobId: string): string {
  return `${accountId}/${blobId}`;
}

/**
 * Checks the inputs (count, size against the server limit, descriptor rules),
 * copies every file into app-owned storage and returns the descriptors and
 * the upload rows to store together with the outbox row. Nothing is sent.
 */
export async function prepareUploads(
  rt: AccountRuntimeLike,
  files: FileStores,
  chatId: string,
  msgId: string,
  inputs: readonly AttachmentInput[],
): Promise<{ attachments: Attachment[]; rows: BlobRow[] }> {
  const { ctx, session } = rt;
  if (inputs.length === 0) return { attachments: [], rows: [] };
  if (inputs.length > MAX_ATTACHMENTS) throw new CoreError('invalid-input', `at most ${MAX_ATTACHMENTS} attachments per message`);
  const limit = await maxBlobBytes(rt);
  for (const f of inputs) {
    if (f.data.size > limit) throw new CoreError('too-large', `the file is larger than the server accepts (${limit} bytes)`);
  }
  const store = await files.preferred();
  const total = inputs.reduce((n, f) => n + f.data.size, 0);
  if (!(await roomFor(total))) throw new CoreError('no-space', 'not enough space on this device');
  const attachments: Attachment[] = [];
  const rows: BlobRow[] = [];
  const now = ctx.clock.now();
  try {
    for (const f of inputs) {
      const size = f.data.size;
      const ref = newBlob(size, { maxSize: limit });
      const kind = kindOf(f);
      const descriptor: Record<string, unknown> = { blob: ref, name: f.name, mime: f.mime, kind };
      if (f.width !== undefined) descriptor.w = f.width;
      if (f.height !== undefined) descriptor.h = f.height;
      if (f.thumb) descriptor.thumb = base64urlEncode(f.thumb);
      if (f.durationMs !== undefined) descriptor.dur = f.durationMs;
      if (f.peaks) descriptor.peaks = [...f.peaks];
      let attachment: Attachment;
      try {
        // The size was checked against the server limit by newBlob above.
        attachment = checkAttachmentInput(descriptor);
      } catch (e) {
        if (isProtocolError(e)) throw new CoreError('invalid-input', `attachment ${e.message.replace(/^attachment: /, '')}`);
        throw e;
      }
      rows.push({
        accountId: session.accountId,
        blobId: ref.id,
        direction: 'up',
        chatId,
        senderId: session.userId,
        msgId,
        ref,
        name: attachment.name,
        mime: attachment.mime,
        kind,
        size,
        status: 'queued',
        bytesDone: 0,
        partsDone: 0,
        attempts: 0,
        nextAttemptAt: now,
        error: null,
        storage: store.kind,
        createdAt: now,
      });
      // The one copy: 4 MiB at a time from the caller's Blob into app storage.
      const key = fileKey(session.accountId, ref.id);
      for (let i = 0, off = 0; off < size; i++, off += FILE_CHUNK) {
        const chunk = new Uint8Array(await f.data.slice(off, Math.min(size, off + FILE_CHUNK)).arrayBuffer());
        await store.write(key, i, chunk);
      }
      attachments.push(attachment);
    }
  } catch (e) {
    for (const r of rows) await store.delete(fileKey(session.accountId, r.blobId)).catch(() => undefined);
    throw e;
  }
  return { attachments, rows };
}

export interface TransferHooks {
  /** All parts of an upload are on the server (the outbox may send the message). */
  onUploaded?(): void;
}

const RUNNING: readonly BlobStatus[] = ['queued', 'active'];

/**
 * Uploads and downloads of one account: one pass at a time across tabs.
 *
 * Every status change of a running transfer is a compare-and-set in one
 * transaction (`#set`): a cancel can land at any moment (this tab, another
 * tab), and a later write of the transfer must never bring a cancelled row
 * back to life. The abort controller is registered before the transfer marks
 * itself active, and `cancel()` writes its status before aborting, so either
 * the transfer sees the cancel at its start or the cancel aborts its request.
 */
export class Transfers {
  readonly #waker: Waker;
  readonly #aborts = new Map<string, AbortController>();
  #running = false;
  #loop: Promise<void> | undefined;

  constructor(
    private readonly rt: AccountRuntimeLike,
    private readonly files: FileStores,
    private readonly hooks: TransferHooks = {},
  ) {
    this.#waker = new Waker(rt.ctx.clock);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#loop = this.#resumeNow().then(() => this.#run());
  }

  /** After a restart, interrupted transfers continue at once (not after their old backoff). */
  async #resumeNow(): Promise<void> {
    const { db, clock } = this.rt.ctx;
    const acc = this.rt.session.accountId;
    try {
      const rows = await db.blobs.where('accountId').equals(acc).toArray();
      for (const r of rows) {
        if (RUNNING.includes(r.status) && r.nextAttemptAt > clock.now()) {
          await this.#set(r, RUNNING, { nextAttemptAt: clock.now() });
        }
      }
    } catch {
      // The database may be closing.
    }
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    for (const a of this.#aborts.values()) a.abort();
    this.#waker.kick();
    await this.#loop;
    this.#loop = undefined;
  }

  kick(): void {
    this.#waker.kick();
  }

  async #run(): Promise<void> {
    const { ctx, session } = this.rt;
    while (this.#running) {
      let nextAt = Infinity;
      if (session.status.get() === 'active') {
        try {
          nextAt = await ctx.locks.request(`fc-transfers-${session.accountId}`, () => this.drain());
        } catch (e) {
          void ctx.diag.error('transfer', `transfer pass failed: ${describeError(e)}`, session.accountId);
          nextAt = ctx.clock.now() + backoffDelay(1, ctx.backoff, ctx.random);
        }
      }
      if (!this.#running) break;
      await this.#waker.wait(nextAt - ctx.clock.now());
    }
  }

  /** One pass: uploads first (messages wait for them), then downloads. Returns the next retry time. */
  async drain(): Promise<number> {
    const { ctx, session } = this.rt;
    const rows = (await ctx.db.blobs.where('accountId').equals(session.accountId).toArray())
      .filter((r) => RUNNING.includes(r.status))
      .sort((a, b) => (a.direction === b.direction ? a.createdAt - b.createdAt : a.direction === 'up' ? -1 : 1));
    let next = Infinity;
    for (const row of rows) {
      if (!this.#running && this.#loop) break;
      if (row.nextAttemptAt > ctx.clock.now()) {
        next = Math.min(next, row.nextAttemptAt);
        continue;
      }
      const at = row.direction === 'up' ? await this.#upload(row) : await this.#download(row);
      if (at !== undefined) next = Math.min(next, at);
    }
    return next;
  }

  /**
   * Compare-and-set: applies `changes` only while the row's status is one of
   * `allowed`. Returns whether it did (false: cancelled or finished meanwhile).
   */
  async #set(row: BlobRow, allowed: readonly BlobStatus[], changes: Partial<BlobRow>): Promise<boolean> {
    const { db } = this.rt.ctx;
    return db.transaction('rw', db.blobs, async () => {
      const fresh = await db.blobs.get([row.accountId, row.blobId]);
      if (!fresh || !allowed.includes(fresh.status)) return false;
      await db.blobs.update([row.accountId, row.blobId], changes);
      return true;
    });
  }

  /** Transient failure: retry later; anything else: failed. Returns the retry time, if any. */
  async #fail(row: BlobRow, e: unknown): Promise<number | undefined> {
    const { ctx } = this.rt;
    const fresh = await ctx.db.blobs.get([row.accountId, row.blobId]);
    if (!fresh || !RUNNING.includes(fresh.status)) return undefined; // cancelled meanwhile
    if (isTransient(e) || isCoreError(e, 'login-invalid')) {
      const attempts = fresh.attempts + 1;
      const retryAfter = isApiError(e) ? (e.retryAfterMs ?? 0) : 0;
      const nextAttemptAt = ctx.clock.now() + Math.max(retryAfter, backoffDelay(attempts, ctx.backoff, ctx.random));
      if (!(await this.#set(row, RUNNING, { status: 'queued', attempts, nextAttemptAt, error: code(e) }))) return undefined;
      void ctx.diag.info('transfer', `${row.direction} ${row.blobId} interrupted: ${describeError(e)}`, row.accountId);
      return nextAttemptAt;
    }
    const gone = isApiError(e, 'blob_not_found');
    if (!(await this.#set(row, RUNNING, { status: gone ? 'gone' : 'failed', error: code(e) }))) return undefined;
    void ctx.diag.warn('transfer', `${row.direction} ${row.blobId} ${gone ? 'is not on the server' : 'failed'}: ${describeError(e)}`, row.accountId);
    if (row.direction === 'up') this.hooks.onUploaded?.();
    return undefined;
  }

  /** A cancel landed while parts were going up: the server copy may have been created after cancel's DELETE. */
  async #removeFromServer(blobId: string): Promise<void> {
    const { ctx, session } = this.rt;
    try {
      await session.call((t) => session.transport.deleteBlob(t, blobId));
    } catch (e) {
      if (!isApiError(e, 'blob_not_found')) {
        void ctx.diag.info('transfer', `removing cancelled upload ${blobId} failed: ${describeError(e)}`, session.accountId);
      }
    }
  }

  async #upload(row: BlobRow): Promise<number | undefined> {
    const { ctx, session } = this.rt;
    const ctl = new AbortController();
    this.#aborts.set(row.blobId, ctl);
    let sent = false;
    try {
      if (!(await this.#set(row, RUNNING, { status: 'active' }))) return undefined;
      const store = await this.files.of(row.storage ?? 'idb');
      const key = fileKey(row.accountId, row.blobId);
      // What is already on the server (an earlier attempt, before a restart).
      const have = new Map<number, number>();
      try {
        const info = await session.call((t) => session.transport.blobInfo(t, row.blobId, ctl.signal));
        for (const p of info.parts) have.set(p.part, p.size);
      } catch (e) {
        if (!isApiError(e, 'blob_not_found')) throw e;
      }
      let done = 0;
      for (let i = 0; i < row.ref.parts; i++) {
        const len = blobPartLength(row.ref, i);
        if (have.get(i) === len + 16) {
          done += len;
          continue;
        }
        if (ctl.signal.aborted) return undefined;
        const plain = await store.read(key, i, len);
        const ct = await encryptBlobPart(row.ref, i, plain);
        sent = true;
        await session.call((t) => session.transport.putBlobPart(t, row.blobId, i, ct, ctl.signal));
        done += len;
        // Also the cancellation check before the next part.
        if (!(await this.#set(row, ['active'], { bytesDone: Math.min(done, row.size), partsDone: i + 1, error: null }))) {
          await this.#removeFromServer(row.blobId);
          return undefined;
        }
      }
      if (!(await this.#set(row, ['active'], { status: 'done', bytesDone: row.size, partsDone: row.ref.parts, error: null }))) {
        if (sent) await this.#removeFromServer(row.blobId);
        return undefined;
      }
      void ctx.diag.info('transfer', `upload ${row.blobId} complete (${row.ref.parts} part(s))`, row.accountId);
      this.hooks.onUploaded?.();
      return undefined;
    } catch (e) {
      const at = await this.#fail(row, e);
      if (sent && (await ctx.db.blobs.get([row.accountId, row.blobId]))?.status === 'cancelled') await this.#removeFromServer(row.blobId);
      return at;
    } finally {
      if (this.#aborts.get(row.blobId) === ctl) this.#aborts.delete(row.blobId);
    }
  }

  async #download(row: BlobRow): Promise<number | undefined> {
    const { ctx, session } = this.rt;
    const ctl = new AbortController();
    this.#aborts.set(row.blobId, ctl);
    try {
      const store = row.storage ? await this.files.of(row.storage) : await this.files.preferred();
      if (!(await this.#set(row, RUNNING, { status: 'active', storage: store.kind }))) return undefined;
      // Resume from the parts already written (they survive a restart).
      const fresh = await ctx.db.blobs.get([row.accountId, row.blobId]);
      const from = fresh?.partsDone ?? row.partsDone;
      let bytes = fresh?.bytesDone ?? row.bytesDone;
      if (!(await roomFor(row.size - bytes))) throw new CoreError('no-space', 'not enough space on this device');
      const key = fileKey(row.accountId, row.blobId);
      for (let i = from; i < row.ref.parts; i++) {
        if (ctl.signal.aborted) return undefined;
        const ct = await session.call((t) => session.transport.getBlobPart(t, row.blobId, i, ctl.signal));
        const plain = await decryptBlobPart(row.ref, i, ct);
        await store.write(key, i, plain);
        bytes += plain.length;
        if (!(await this.#set(row, ['active'], { partsDone: i + 1, bytesDone: bytes, error: null }))) {
          // Stopped meanwhile: cancel() may have removed the copy before this part landed.
          if ((await ctx.db.blobs.get([row.accountId, row.blobId]))?.status === 'none') await store.delete(key).catch(() => undefined);
          return undefined;
        }
      }
      await this.#set(row, ['active'], { status: 'done', bytesDone: row.size, error: null });
      return undefined;
    } catch (e) {
      if (isProtocolError(e) || isCoreError(e, 'no-space')) {
        const errorCode = isProtocolError(e) ? e.code : 'no-space';
        if (await this.#set(row, RUNNING, { status: 'failed', error: errorCode })) {
          void ctx.diag.warn('transfer', `download ${row.blobId} rejected: ${describeError(e)}`, row.accountId);
        }
        return undefined;
      }
      return this.#fail(row, e);
    } finally {
      if (this.#aborts.get(row.blobId) === ctl) this.#aborts.delete(row.blobId);
    }
  }

  /** Starts (or restarts) the download of an attachment. */
  async download(blobId: string): Promise<void> {
    const { db, clock } = this.rt.ctx;
    const acc = this.rt.session.accountId;
    await db.transaction('rw', db.blobs, async () => {
      const row = await db.blobs.get([acc, blobId]);
      if (!row) throw new CoreError('invalid-input', 'no such attachment');
      if (row.status === 'done' || row.status === 'queued' || row.status === 'active') return;
      if (row.direction === 'up') throw new CoreError('invalid-input', 'not a received attachment');
      await db.blobs.put({ ...row, status: 'queued', attempts: 0, nextAttemptAt: clock.now(), error: null });
    });
    this.kick();
  }

  /**
   * Stops a transfer. A download goes back to "not downloaded" (the partial
   * copy is removed); an upload is cancelled and removed from the server.
   * The status is written first, then the running request is aborted.
   */
  async cancel(blobId: string): Promise<void> {
    const { db } = this.rt.ctx;
    const acc = this.rt.session.accountId;
    const row = await db.transaction('rw', db.blobs, async () => {
      const r = await db.blobs.get([acc, blobId]);
      if (!r) return undefined;
      if (r.direction === 'down') {
        if (r.status === 'done') return undefined;
        await db.blobs.update([acc, blobId], { status: 'none', partsDone: 0, bytesDone: 0, error: null });
      } else {
        await db.blobs.update([acc, blobId], { status: 'cancelled' });
      }
      return r;
    });
    if (!row) return;
    this.#aborts.get(blobId)?.abort();
    if (row.storage) await (await this.files.of(row.storage)).delete(fileKey(acc, blobId)).catch(() => undefined);
    if (row.direction === 'up') await this.#removeFromServer(blobId);
  }

  /** Re-queues failed uploads of a message (manual retry). */
  async retryUploads(msgId: string): Promise<void> {
    const { db, clock } = this.rt.ctx;
    const acc = this.rt.session.accountId;
    const rows = await db.blobs.where('[accountId+msgId]').equals([acc, msgId]).toArray();
    for (const r of rows) {
      if (r.direction === 'up' && r.status === 'failed') {
        await this.#set(r, ['failed'], { status: 'queued', attempts: 0, nextAttemptAt: clock.now(), error: null });
      }
    }
    this.kick();
  }

  /** Marks a received voice message as listened to (the "не прослушано" mark goes away). */
  async markHeard(blobId: string): Promise<void> {
    const { db } = this.rt.ctx;
    const acc = this.rt.session.accountId;
    await db.transaction('rw', db.blobs, async () => {
      const row = await db.blobs.get([acc, blobId]);
      if (row && !row.heard) await db.blobs.update([acc, blobId], { heard: true });
    });
  }

  /** The plaintext of a stored attachment as a Blob (backed by the storage). */
  async blob(blobId: string): Promise<Blob> {
    const acc = this.rt.session.accountId;
    const row = await this.rt.ctx.db.blobs.get([acc, blobId]);
    if (!row) throw new CoreError('invalid-input', 'no such attachment');
    if (row.status === 'gone') throw new CoreError('gone');
    if (row.status !== 'done' && !(row.direction === 'up' && row.status !== 'cancelled')) {
      throw new CoreError('invalid-input', 'the attachment is not downloaded');
    }
    if (!row.storage) throw new CoreError('invalid-input', 'the attachment is not downloaded');
    const store = await this.files.of(row.storage);
    return store.blob(fileKey(acc, blobId), row.size, row.mime);
  }
}

function code(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  if (typeof c === 'string') return c;
  const r = (e as { reason?: unknown } | null)?.reason;
  return typeof r === 'string' ? `network` : 'error';
}
