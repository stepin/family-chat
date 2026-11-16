// Sticker packs of one account: the list
// from the server with every manifest verified against its uploader's
// identity, publishing (files first, then the signed manifest), deleting
// one's own pack, and files fetched on demand and checked against their name
// (hash) and the manifest's size before they are stored or shown.

import {
  createStickerPackEnvelope,
  newMessageId,
  readStickerPackHeader,
  stickerFileMatches,
  verifyStickerPackEnvelope,
  type PackSticker,
} from '@family-chat/protocol';
import { isApiError } from '../api/errors.ts';
import type { AccountRuntimeLike } from '../apply.ts';
import { describeError } from '../db/diagnostics.ts';
import type { StickerPackRow } from '../db/schema.ts';
import { CoreError } from '../errors.ts';
import { StickerError } from './errors.ts';
import type { ImportedSticker } from './import.ts';
import type { SanitizedLottie } from './tgs.ts';
import { webpInfo } from './webp.ts';

/** A new pack id: base32 of 16 random bytes (the same shape as a message id). */
function newPackId(): string {
  return newMessageId();
}

export class StickerPacks {
  #refreshing: Promise<void> | undefined;
  readonly #fetching = new Map<string, Promise<Uint8Array>>();

  constructor(private readonly rt: AccountRuntimeLike) {}

  /** Reads the pack list from the server (once at a time). Packs that failed verification are left out. */
  refresh(): Promise<void> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<void> {
    const { ctx, session, directory } = this.rt;
    const { db } = ctx;
    const acc = session.accountId;
    const list = await session.call((t) => session.transport.packs(t));
    const now = ctx.clock.now();
    const rows: StickerPackRow[] = [];
    for (const p of list) {
      try {
        const head = readStickerPackHeader(p.manifest);
        if (head.packId !== p.packId || head.author !== p.owner) throw new StickerError('hash-mismatch');
        let identity = await directory.identity(head.author);
        if (!identity) {
          await directory.refresh();
          identity = await directory.identity(head.author);
        }
        if (!identity) throw new CoreError('unknown-user');
        const m = verifyStickerPackEnvelope(p.manifest, identity, { serverId: session.serverId, packId: p.packId });
        rows.push({
          accountId: acc,
          packId: m.packId,
          author: m.author,
          name: m.name,
          created: m.created,
          stickers: [...m.stickers],
          manifest: m.envelope,
          publishedAt: p.publishedAt,
          seenAt: now,
        });
      } catch (e) {
        void ctx.diag.warn('stickers', `pack ${p.packId} refused: ${describeError(e)}`, acc);
      }
    }
    const keep = new Set(rows.map((r) => r.packId));
    await db.transaction('rw', db.stickerPacks, db.stickerFiles, async () => {
      const old = await db.stickerPacks.where('accountId').equals(acc).toArray();
      for (const o of old) {
        if (keep.has(o.packId)) continue;
        // Deleted by its uploader: the pack and its cached files go everywhere.
        await db.stickerPacks.delete([acc, o.packId]);
        await db.stickerFiles.where('[accountId+packId]').equals([acc, o.packId]).delete();
      }
      await db.stickerPacks.bulkPut(rows);
    });
  }

  /**
   * Publishes an imported pack: every file, then the manifest signed by my
   * identity. Repeating after a failure re-sends what is missing (the server
   * accepts the same file again). Returns the pack id.
   */
  async publish(name: string, stickers: readonly ImportedSticker[], packId: string = newPackId()): Promise<string> {
    const { ctx, session } = this.rt;
    const keys = await ctx.keys(session.userId);
    const list: PackSticker[] = stickers.map((s) => ({ file: s.file, type: s.type, size: s.size, emoji: s.emoji, w: s.w, h: s.h }));
    // Signing checks every field (name, limits) before anything is uploaded.
    const manifest = createStickerPackEnvelope(keys, { packId, serverId: session.serverId, name, created: ctx.clock.now(), stickers: list });
    for (const s of stickers) {
      if (!stickerFileMatches(s.bytes, s)) throw new StickerError('hash-mismatch', s.name);
      await session.call((t) => session.transport.putPackFile(t, packId, s.file, s.bytes));
    }
    await session.call((t) => session.transport.publishPack(t, packId, manifest));
    // My own files are known good: keep them, so the picker does not download them again.
    const now = ctx.clock.now();
    await ctx.db.stickerFiles.bulkPut(
      stickers.map((s) => ({ accountId: session.accountId, file: s.file, packId, type: s.type, bytes: s.bytes, fetchedAt: now })),
    );
    void ctx.diag.info('stickers', `pack ${packId} published (${stickers.length} stickers)`, session.accountId);
    await this.refresh().catch(() => undefined);
    return packId;
  }

  /** Deletes my pack on the server (for everyone) and here. */
  async delete(packId: string): Promise<void> {
    const { ctx, session } = this.rt;
    const acc = session.accountId;
    const row = await ctx.db.stickerPacks.get([acc, packId]);
    if (row && row.author !== session.userId) throw new CoreError('not-allowed', 'only the uploader can delete a pack');
    try {
      await session.call((t) => session.transport.deletePack(t, packId));
    } catch (e) {
      if (!isApiError(e, 'pack_not_found')) throw e;
    }
    await ctx.db.transaction('rw', ctx.db.stickerPacks, ctx.db.stickerFiles, async () => {
      await ctx.db.stickerPacks.delete([acc, packId]);
      await ctx.db.stickerFiles.where('[accountId+packId]').equals([acc, packId]).delete();
    });
  }

  /**
   * The bytes of a sticker: from the local cache, or fetched and checked
   * (hash and size from the verified manifest, and the format). Throws
   * CoreError `gone` when the pack or file is not on the server (deleted).
   */
  async file(packId: string, file: string): Promise<{ readonly bytes: Uint8Array; readonly type: 'webp' | 'tgs' }> {
    const { ctx, session } = this.rt;
    const acc = session.accountId;
    const cached = await ctx.db.stickerFiles.get([acc, file]);
    if (cached) return { bytes: cached.bytes, type: cached.type };
    let pack = await ctx.db.stickerPacks.get([acc, packId]);
    if (!pack) {
      await this.refresh().catch(() => undefined);
      pack = await ctx.db.stickerPacks.get([acc, packId]);
      if (!pack) throw new CoreError('gone', 'no such sticker pack');
    }
    const entry = pack.stickers.find((s) => s.file === file);
    if (!entry) throw new CoreError('gone', 'no such sticker in the pack');
    const key = `${packId}/${file}`;
    let p = this.#fetching.get(key);
    if (!p) {
      p = this.#fetch(packId, entry).finally(() => this.#fetching.delete(key));
      this.#fetching.set(key, p);
    }
    return { bytes: await p, type: entry.type };
  }

  async #fetch(packId: string, entry: PackSticker): Promise<Uint8Array> {
    const { ctx, session } = this.rt;
    let bytes: Uint8Array;
    try {
      bytes = await session.call((t) => session.transport.packFile(t, packId, entry.file));
    } catch (e) {
      if (isApiError(e, 'file_not_found') || isApiError(e, 'pack_not_found')) throw new CoreError('gone', 'sticker file not on the server');
      throw e;
    }
    if (!stickerFileMatches(bytes, entry)) throw new StickerError('hash-mismatch', entry.file);
    if (entry.type === 'webp' && !webpInfo(bytes)) throw new StickerError('bad-webp', entry.file);
    if (entry.type === 'tgs') await (await import('./tgs.ts')).readTgs(bytes);
    await ctx.db.stickerFiles.put({ accountId: session.accountId, file: entry.file, packId, type: entry.type, bytes, fetchedAt: ctx.clock.now() });
    return bytes;
  }

  /** The sanitised animation of a `.tgs` sticker (for the light Lottie renderer). */
  async animation(packId: string, file: string): Promise<SanitizedLottie> {
    const f = await this.file(packId, file);
    if (f.type !== 'tgs') throw new CoreError('invalid-input', 'not an animated .tgs sticker');
    return (await import('./tgs.ts')).readTgs(f.bytes);
  }
}
