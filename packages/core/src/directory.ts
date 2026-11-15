// Family members of one account with verified identities and profiles,
// direct-chat ids and keys.
//
// Every identity from the server is verified (docs/PROTOCOL.md 4.2). The
// userId binds the signing key, but not the box key; if a known userId shows
// up with different keys, the change is recorded and reported, and the stored
// keys stay in use until the person accepts the change.

import {
  deriveDmKeys,
  dmChatId,
  fingerprint,
  verifyIdentityEnvelope,
  verifyProfileEnvelope,
  verifyRevocationEnvelope,
  type DmKeys,
  type Identity,
} from '@family-chat/protocol';
import type { UserEntry } from './api/types.ts';
import type { CoreContext } from './context.ts';
import { describeError } from './db/diagnostics.ts';
import type { UserRow } from './db/schema.ts';
import { CoreError } from './errors.ts';
import type { Session } from './session.ts';

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function identityOf(row: UserRow): Identity {
  return { userId: row.userId, signPub: row.signPub, boxPub: row.boxPub, created: row.created, envelope: row.identity };
}

export class Directory {
  readonly #keys = new Map<string, DmKeys>();
  #chatIndex: Map<string, string> | undefined;
  #refreshing: Promise<void> | undefined;

  constructor(
    private readonly ctx: CoreContext,
    private readonly session: Session,
  ) {}

  get accountId(): string {
    return this.session.accountId;
  }

  /** Fetches `GET /v1/users` and stores verified identities and profiles. Single-flight. */
  refresh(): Promise<void> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<void> {
    const entries = await this.session.call((t) => this.session.transport.users(t));
    await this.ingest(entries);
  }

  /** Verifies and stores user entries (also used for the own entry after join). */
  async ingest(entries: readonly UserEntry[]): Promise<void> {
    const { db, diag } = this.ctx;
    const acc = this.accountId;
    const verified: { entry: UserEntry; identity: Identity }[] = [];
    for (const entry of entries) {
      try {
        const identity = verifyIdentityEnvelope(entry.identity);
        if (identity.userId !== entry.userId) throw new CoreError('unknown-user', 'identity belongs to another user');
        verified.push({ entry, identity });
      } catch (e) {
        void diag.warn('directory', `identity of ${entry.userId} rejected: ${describeError(e)}`, acc);
      }
    }
    const reports: string[] = [];
    await db.transaction('rw', db.users, async () => {
      for (const { entry, identity } of verified) {
        const old = await db.users.get([acc, entry.userId]);
        let row: UserRow;
        if (!old) {
          row = {
            accountId: acc,
            userId: entry.userId,
            identity: identity.envelope,
            signPub: identity.signPub,
            boxPub: identity.boxPub,
            created: identity.created,
            profile: null,
            name: null,
            rev: -1,
            admin: entry.admin,
            removed: entry.removed,
            keyChange: null,
            avatar: null,
            revoked: null,
            verifiedFingerprint: null,
          };
        } else {
          row = { ...old, admin: entry.admin, removed: entry.removed };
          const sameKeys = sameBytes(old.signPub, identity.signPub) && sameBytes(old.boxPub, identity.boxPub);
          if (!sameKeys) {
            if (!old.keyChange || old.keyChange.identity.payload !== identity.envelope.payload) {
              row.keyChange = { identity: identity.envelope, detectedAt: this.ctx.clock.now() };
              reports.push(`keys of ${entry.userId} changed on the server; the stored keys stay in use`);
            }
          } else if (old.keyChange) {
            // The server went back to the known keys.
            row.keyChange = null;
          }
        }
        if (entry.profile) {
          try {
            const profile = verifyProfileEnvelope(entry.profile, identityOf(row));
            if (profile.rev > row.rev) {
              row.profile = profile.envelope;
              row.name = profile.name;
              row.rev = profile.rev;
              row.avatar = profile.avatar;
              row.gender = profile.gender;
            }
          } catch (e) {
            reports.push(`profile of ${entry.userId} rejected: ${describeError(e)}`);
          }
        }
        if (entry.revoked && !row.revoked) {
          try {
            const r = verifyRevocationEnvelope(entry.revoked, identityOf(row));
            row.revoked = { revokedAt: r.revokedAt, envelope: r.envelope, detectedAt: this.ctx.clock.now() };
            reports.push(`identity of ${entry.userId} was revoked`);
          } catch (e) {
            reports.push(`revocation of ${entry.userId} rejected: ${describeError(e)}`);
          }
        }
        await db.users.put(row);
      }
    });
    for (const r of reports) void diag.warn('directory', r, acc);
    this.#chatIndex = undefined;
  }

  /** Uses the new identity reported for a userId (after the person compared fingerprints). */
  async acceptKeyChange(userId: string): Promise<void> {
    const { db } = this.ctx;
    const acc = this.accountId;
    await db.transaction('rw', db.users, async () => {
      const row = await db.users.get([acc, userId]);
      if (!row?.keyChange) return;
      const identity = verifyIdentityEnvelope(row.keyChange.identity);
      await db.users.put({
        ...row,
        identity: identity.envelope,
        signPub: identity.signPub,
        boxPub: identity.boxPub,
        created: identity.created,
        keyChange: null,
        // The old profile was signed by the old key; wait for a fresh one.
        profile: null,
        name: null,
        rev: -1,
        avatar: null,
      });
    });
    this.#keys.delete(userId);
    this.#chatIndex = undefined;
    void this.ctx.diag.info('directory', `accepted new keys of ${userId}`, acc);
  }

  async user(userId: string): Promise<UserRow | undefined> {
    return this.ctx.db.users.get([this.accountId, userId]);
  }

  /** Verified identity (stored keys), or undefined. */
  async identity(userId: string): Promise<Identity | undefined> {
    const row = await this.user(userId);
    return row ? identityOf(row) : undefined;
  }

  /** Direct chat id with `peerId`; with my own userId it is the chat with myself ("Избранное"). */
  chatIdFor(peerId: string): string {
    return dmChatId(this.session.serverId, this.session.userId, peerId);
  }

  /** The chat with myself. */
  selfChatId(): string {
    return this.chatIdFor(this.session.userId);
  }

  /** Marks (or unmarks) a member's current keys as verified by comparing fingerprints. */
  async setVerified(userId: string, verified: boolean): Promise<void> {
    const { db } = this.ctx;
    await db.transaction('rw', db.users, async () => {
      const row = await db.users.get([this.accountId, userId]);
      if (!row) throw new CoreError('unknown-user');
      await db.users.put({ ...row, verifiedFingerprint: verified ? fingerprint(row) : null });
    });
  }

  /** The other member of a direct chat, found among known users (as the server does). */
  async peerForChat(chatId: string): Promise<string | undefined> {
    const chat = await this.ctx.db.chats.get([this.accountId, chatId]);
    if (chat) return chat.kind === 'group' ? undefined : chat.peerId;
    if (!this.#chatIndex) {
      const index = new Map<string, string>();
      const users = await this.ctx.db.users.where('accountId').equals(this.accountId).toArray();
      for (const u of users) index.set(this.chatIdFor(u.userId), u.userId);
      index.set(this.selfChatId(), this.session.userId);
      this.#chatIndex = index;
    }
    return this.#chatIndex.get(chatId);
  }

  /** Keys of the direct chat with `peerId` (cached in memory). */
  async chatKeys(peerId: string): Promise<DmKeys> {
    const cached = this.#keys.get(peerId);
    if (cached) return cached;
    const peer = await this.identity(peerId);
    if (!peer) throw new CoreError('unknown-user');
    const me = await this.ctx.keys(this.session.userId);
    const keys = deriveDmKeys(me, peer, this.session.serverId);
    this.#keys.set(peerId, keys);
    return keys;
  }

  /** My own identity from the local seed (the most trustworthy copy). */
  async myIdentity(): Promise<Identity> {
    const keys = await this.ctx.keys(this.session.userId);
    const row = await this.user(this.session.userId);
    return {
      userId: keys.userId,
      signPub: keys.signPub,
      boxPub: keys.boxPub,
      created: row?.created ?? 0,
      envelope: row?.identity ?? { payload: '', sig: '' },
    };
  }
}
