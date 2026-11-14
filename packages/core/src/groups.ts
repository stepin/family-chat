// Groups of one account (docs/API.md 6-7, docs/PROTOCOL.md 14-15).
//
// The signed state is the source of truth; the server's member list is only
// for delivery. Every state is verified with the protocol package against the
// previous accepted one (or, for the first state seen, against its embedded
// ownership chain and the hash in my sealed key). Epoch secrets are kept per
// (chat, epoch); sealed keys are kept as received.
//
// Receiving: notices (group_created, group_state, member_left, member_removed,
// member_revoked) are stored and turned into work: fetch new keys
// (GET /v1/keys), read the states up to the announced version, store them,
// derive service entries. On start the whole picture is reconciled with
// GET /v1/chats, because a notice can be missing after a server crash.
//
// Changing (owner only): the change is built and signed locally, written to
// `groupPending` together with the new epoch secret, and only then sent. A
// repeat after a crash or a lost answer is recognised by comparing the stored
// state blob with the server's (409 chat_exists / stale_version). The owner's
// client removes members who left, were removed from the family or revoked
// their identity, once: a second device of the owner loses the version race,
// re-reads and finds nothing left to do.

import {
  acceptGroupKey,
  addGroupMembers,
  createGroup,
  deriveGroupKeys,
  groupStateActions,
  isProtocolError,
  openGroupKey,
  parseSealedGroupKey,
  openGroupState,
  readGroupStateHeader,
  removeGroupMembers,
  renameGroup,
  serializeEnvelope,
  transferGroupOwnership,
  verifyGroupKey,
  verifyGroupState,
  type ChatKeys,
  type GroupChange,
  type GroupMemberInput,
  type GroupState,
  type Identity,
} from '@family-chat/protocol';
import { isApiError, isTransient } from './api/errors.ts';
import type { ChatEntry, ServerNotice } from './api/types.ts';
import type { CoreContext } from './context.ts';
import { describeError } from './db/diagnostics.ts';
import type {
  GroupOp,
  GroupPendingRow,
  GroupRow,
  MessageRow,
  NoticeRow,
  ServiceEntry,
} from './db/schema.ts';
import type { Directory } from './directory.ts';
import { CoreError } from './errors.ts';
import type { Session } from './session.ts';
import { Waker } from './util/clock.ts';
import { backoffDelay } from './util/backoff.ts';

export interface GroupHost {
  readonly ctx: CoreContext;
  readonly session: Session;
  readonly directory: Directory;
  /** Re-tries events that waited for a key or a state (apply.ts). */
  retryPending(chatIds: ReadonlySet<string> | null): Promise<void>;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Sender id of service entries in the messages table. */
export const SERVICE_SENDER = '';

const MAX_CHANGE_ATTEMPTS = 4;

export class Groups {
  readonly #host: GroupHost;
  readonly #waker: Waker;
  #running = false;
  #loop: Promise<void> | undefined;
  #mutex: Promise<unknown> = Promise.resolve();
  #fullDone = false;
  #needFull = true;
  #needDuties = true;
  #failures = 0;

  constructor(host: GroupHost) {
    this.#host = host;
    this.#waker = new Waker(host.ctx.clock);
  }

  get #ctx(): CoreContext {
    return this.#host.ctx;
  }
  get #acc(): string {
    return this.#host.session.accountId;
  }
  get #me(): string {
    return this.#host.session.userId;
  }

  // ---- background work ----

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#waker.kick();
    await this.#loop;
    this.#loop = undefined;
  }

  /** Run the background pass now (connection back, notices about members). */
  kick(options: { full?: boolean; duties?: boolean } = {}): void {
    if (options.full) this.#needFull = true;
    if (options.duties) this.#needDuties = true;
    this.#waker.kick();
  }

  /** True after the first full reconciliation of this runtime finished. */
  get reconciled(): boolean {
    return this.#fullDone;
  }

  async #run(): Promise<void> {
    const { ctx, session } = this.#host;
    while (this.#running) {
      let delay = Infinity;
      if (session.status.get() === 'active') {
        try {
          await this.flushPending();
          if (this.#needFull) {
            this.#needFull = false;
            await this.reconcile({ full: true });
            this.#fullDone = true;
            this.#needDuties = true;
          }
          if (this.#needDuties) {
            this.#needDuties = false;
            await this.ownerDuties();
          }
          this.#failures = 0;
        } catch (e) {
          if (!this.#running) break;
          this.#failures++;
          this.#needFull = !this.#fullDone || this.#needFull;
          this.#needDuties = true;
          if (!isTransient(e)) void ctx.diag.warn('group', `group pass failed: ${describeError(e)}`, this.#acc);
          delay = backoffDelay(this.#failures, ctx.backoff, ctx.random);
        }
      }
      if (!this.#running) break;
      await this.#waker.wait(delay);
    }
  }

  /** Serialises reconciliation and changes inside this context. */
  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#mutex.then(fn, fn);
    this.#mutex = run.catch(() => undefined);
    return run;
  }

  // ---- notices ----

  /**
   * Stores notices (deduplicated by gseq), updates delivery data and
   * membership, writes the service entries that come from notices, and
   * returns the versions to read: chatId → announced version.
   */
  async handleNotices(notices: readonly ServerNotice[]): Promise<Map<string, number>> {
    const { db } = this.#ctx;
    const acc = this.#acc;
    const me = this.#me;
    const targets = new Map<string, number>();
    if (notices.length === 0) return targets;
    let refreshDirectory = false;
    await db.transaction('rw', [db.notices, db.groups, db.chats, db.messages], async () => {
      for (const n of notices) {
        const row: NoticeRow = { accountId: acc, gseq: n.gseq, time: n.time, chatId: n.chatId, notice: n.notice };
        await db.notices.put(row);
        const b = n.notice;
        // Delete for everyone: kept for the record; the signed `delete` payload does the work (apply.ts).
        if (b.type === 'event_deleted') continue;
        if (b.type === 'member_removed' || b.type === 'member_revoked') {
          refreshDirectory = true;
          continue;
        }
        const g = await this.#ensureGroup(n.chatId);
        if ('members' in b && (!g.server || b.version >= g.server.version)) {
          g.server = {
            version: b.version,
            epoch: b.epoch,
            owner: 'owner' in b ? b.owner : (g.server?.owner ?? null),
            members: [...b.members],
          };
        }
        if (b.type === 'group_created' || b.type === 'group_state') {
          if (b.members.includes(me)) {
            targets.set(n.chatId, Math.max(targets.get(n.chatId) ?? 0, b.version));
            g.member = true;
            g.left = null;
          } else if (b.type === 'group_state' && b.removed.includes(me)) {
            g.member = false;
            g.left = { reason: 'removed', at: n.time };
            await this.#putService(n.chatId, `n:${n.gseq}`, { type: 'you-removed' }, n.gseq, n.time);
            await this.#dropGone(n.chatId);
          }
        } else if (b.type === 'member_left') {
          if (b.userId === me) {
            g.member = false;
            g.left = { reason: 'left', at: n.time };
            await this.#putService(n.chatId, `n:${n.gseq}`, { type: 'you-left' }, n.gseq, n.time);
            await this.#dropGone(n.chatId);
          } else {
            await this.#putService(n.chatId, `n:${n.gseq}`, { type: 'left', userId: b.userId }, n.gseq, n.time);
          }
        }
        await db.groups.put(g);
        // A service entry for a state already accepted gets the notice's place in the feed.
        if ('version' in b) await this.#moveStateEntries(n.chatId, b.version, n.gseq, n.time);
      }
    });
    if (refreshDirectory) {
      try {
        await this.#host.directory.refresh();
      } catch (e) {
        void this.#ctx.diag.info('group', `member list refresh after a notice failed: ${describeError(e)}`, acc);
      }
    }
    // Members left or were removed: the owner's client may have work.
    this.kick({ duties: true });
    return targets;
  }

  /** Must run inside a transaction over groups and chats. */
  async #ensureGroup(chatId: string): Promise<GroupRow> {
    const { db, clock } = this.#ctx;
    const acc = this.#acc;
    const existing = await db.groups.get([acc, chatId]);
    if (existing) return existing;
    const now = clock.now();
    const row: GroupRow = {
      accountId: acc,
      chatId,
      state: null,
      server: null,
      member: true,
      left: null,
      needKey: false,
      broken: null,
      createdAt: now,
    };
    await db.groups.put(row);
    if (!(await db.chats.get([acc, chatId]))) {
      await db.chats.put({ accountId: acc, chatId, kind: 'group', peerId: '', createdAt: now, last: null, readGseq: 0, unread: 0 });
    }
    return row;
  }

  /** Inside a transaction over messages. */
  async #putService(chatId: string, id: string, service: ServiceEntry, gseq: number, time: number): Promise<void> {
    const row: MessageRow = {
      accountId: this.#acc,
      chatId,
      senderId: SERVICE_SENDER,
      msgId: id,
      devId: '',
      seq: null,
      gseq,
      time,
      kind: 'service',
      body: '',
      reply: null,
      service,
    };
    await this.#ctx.db.messages.put(row);
  }

  /** Removes "you are no longer a member" entries found by reconciliation (a notice replaces them). */
  async #dropGone(chatId: string): Promise<void> {
    const { db } = this.#ctx;
    const rows = await db.messages
      .where('[accountId+chatId+gseq]')
      .between([this.#acc, chatId, -Infinity], [this.#acc, chatId, Infinity])
      .filter((m) => m.senderId === SERVICE_SENDER && m.msgId.startsWith('gone:'))
      .primaryKeys();
    await db.messages.bulkDelete(rows);
  }

  async #moveStateEntries(chatId: string, version: number, gseq: number, time: number): Promise<void> {
    const { db } = this.#ctx;
    const prefix = `v:${version}:`;
    const rows = await db.messages
      .where('[accountId+chatId+gseq]')
      .between([this.#acc, chatId, -Infinity], [this.#acc, chatId, Infinity])
      .filter((m) => m.senderId === SERVICE_SENDER && m.msgId.startsWith(prefix))
      .toArray();
    for (const r of rows) if (r.gseq !== gseq) await db.messages.put({ ...r, gseq, time });
  }

  // ---- reconciliation ----

  /**
   * Brings local groups up to date. `targets`: chats with an announced
   * version (from notices); `full`: compare with GET /v1/chats first (start,
   * epoch mismatch, unknown group). Transient errors propagate.
   */
  reconcile(options: { targets?: ReadonlyMap<string, number>; full?: boolean } = {}): Promise<void> {
    return this.#exclusive(() => this.#reconcile(options));
  }

  async #reconcile(options: { targets?: ReadonlyMap<string, number>; full?: boolean }): Promise<void> {
    const { db } = this.#ctx;
    const acc = this.#acc;
    const targets = new Map(options.targets ?? []);
    if (options.full) {
      const { session } = this.#host;
      const entries = await session.call((t) => session.transport.chats(t));
      await this.#applyChatList(entries, targets);
    }
    await this.#fetchKeys();
    // Groups whose keys arrived without a notice (a restored device, a lost notice).
    const undone = await db.sealedKeys.where('[accountId+n]').between([acc, -Infinity], [acc, Infinity]).filter((k) => !k.done).toArray();
    for (const k of undone) if (!targets.has(k.chatId)) targets.set(k.chatId, k.version);
    const advanced = new Set<string>();
    for (const [chatId, version] of targets) {
      if (await this.#advance(chatId, version)) advanced.add(chatId);
    }
    await this.#processLeftoverKeys();
    if (advanced.size > 0 || undone.length > 0) await this.#host.retryPending(null);
    // New states may leave work for the owner (members who left meanwhile).
    if (advanced.size > 0) this.kick({ duties: true });
  }

  async #applyChatList(entries: readonly ChatEntry[], targets: Map<string, number>): Promise<void> {
    const { db, clock } = this.#ctx;
    const acc = this.#acc;
    const onServer = new Set<string>();
    const cursor = await this.#cursor();
    await db.transaction('rw', [db.groups, db.chats, db.messages, db.groupPending], async () => {
      for (const e of entries) {
        if (e.kind !== 'group' || e.version === null) continue;
        onServer.add(e.chatId);
        const g = await this.#ensureGroup(e.chatId);
        g.server = { version: e.version, epoch: e.epoch, owner: e.owner, members: [...e.members] };
        g.member = true;
        g.left = null;
        await db.groups.put(g);
        targets.set(e.chatId, Math.max(targets.get(e.chatId) ?? 0, e.version));
      }
      const local = await db.groups.where('accountId').equals(acc).toArray();
      for (const g of local) {
        if (!g.member || onServer.has(g.chatId)) continue;
        if (await db.groupPending.get([acc, g.chatId])) continue; // created here, not on the server yet
        if (!g.state && !g.server) continue;
        const now = clock.now();
        g.member = false;
        g.left = { reason: 'removed', at: now };
        await db.groups.put(g);
        await this.#putService(g.chatId, `gone:${g.state?.version ?? 0}`, { type: 'you-removed' }, cursor + 0.5, now);
        void this.#ctx.diag.info('group', `no longer a member of ${g.chatId}`, acc);
      }
    });
  }

  async #cursor(): Promise<number> {
    return (await this.#ctx.db.accounts.get(this.#acc))?.cursor ?? 0;
  }

  async #fetchKeys(): Promise<void> {
    const { db } = this.#ctx;
    const { session } = this.#host;
    const acc = this.#acc;
    for (let i = 0; i < 1000; i++) {
      const after = (await db.accounts.get(acc))?.keysCursor ?? 0;
      const page = await session.call((t) => session.transport.keys(t, { after }));
      await db.transaction('rw', [db.sealedKeys, db.accounts], async () => {
        for (const k of page.keys) {
          if (await db.sealedKeys.get([acc, k.n])) continue;
          await db.sealedKeys.put({ accountId: acc, n: k.n, chatId: k.chatId, epoch: k.epoch, version: k.version, time: k.time, key: k.key, done: false });
        }
        await db.accounts.update(acc, { keysCursor: page.cursor });
      });
      if (!page.more) return;
    }
  }

  /** Reads and verifies states up to `target`. Returns true when something new was accepted. */
  async #advance(chatId: string, target: number): Promise<boolean> {
    const { db, diag } = this.#ctx;
    const { session } = this.#host;
    const acc = this.#acc;
    const keys = await this.#ctx.keys(this.#me);
    let progressed = false;
    let refetched = false;
    for (let guard = 0; guard < 10_000; guard++) {
      const g = await db.groups.get([acc, chatId]);
      if (!g || g.broken) return progressed;
      let prev = g.state ?? undefined;
      if (prev && prev.version >= target) break;
      let v: number;
      if (prev) v = prev.version + 1;
      else {
        const first = (await this.#keysOf(chatId)).sort((a, b) => a.version - b.version || a.n - b.n)[0];
        if (!first) {
          await this.#setNeedKey(chatId, true);
          return progressed;
        }
        v = first.version;
      }
      let blob: Uint8Array;
      try {
        blob = await session.call((t) => session.transport.groupState(t, chatId, v));
      } catch (e) {
        if (isApiError(e, 'not_member') || isApiError(e, 'chat_not_found')) {
          await this.#markGone(chatId);
          return progressed;
        }
        if (isApiError(e, 'not_found')) return progressed;
        throw e;
      }
      let state: GroupState;
      let secret: Uint8Array | undefined;
      let keyN: number | undefined;
      try {
        const { epoch } = readGroupStateHeader(blob);
        const known = await db.epochKeys.get([acc, chatId, epoch]);
        if (known) {
          state = await openGroupState(blob, {
            serverId: session.serverId,
            chatId,
            keys: deriveGroupKeys(known.secret, epoch),
            ...(prev ? { prev } : {}),
          });
        } else {
          let sealed = (await this.#keysOf(chatId)).find((k) => k.version === v);
          if (!sealed && !refetched) {
            refetched = true;
            await this.#fetchKeys();
            sealed = (await this.#keysOf(chatId)).find((k) => k.version === v);
          }
          if (!sealed) {
            // A later key (re-added after a removal): start over from that state.
            const later = (await this.#keysOf(chatId)).filter((k) => k.version > v && !k.done).sort((a, b) => a.version - b.version)[0];
            if (!later) {
              await this.#setNeedKey(chatId, true);
              return progressed;
            }
            const laterBlob = await session.call((t) => session.transport.groupState(t, chatId, later.version));
            const r = await acceptGroupKey(parseSealedGroupKey(later.key), laterBlob, keys, { serverId: session.serverId });
            prev = g.state ?? undefined;
            await this.#commitState(chatId, prev, r.state, r.key.secret, later.n, true);
            progressed = true;
            continue;
          }
          const r = await acceptGroupKey(parseSealedGroupKey(sealed.key), blob, keys, {
            serverId: session.serverId,
            ...(prev ? { prev } : {}),
          });
          state = r.state;
          secret = r.key.secret;
          keyN = sealed.n;
        }
      } catch (e) {
        if (!isProtocolError(e)) throw e;
        const code = e.code;
        void diag.warn('verify', `group ${chatId} state ${v} rejected: ${describeError(e)}`, acc);
        await db.groups.update([acc, chatId], { broken: code });
        return progressed;
      }
      await this.#commitState(chatId, prev, state, secret, keyN, false);
      progressed = true;
    }
    return progressed;
  }

  async #keysOf(chatId: string) {
    return this.#ctx.db.sealedKeys.where('[accountId+chatId]').equals([this.#acc, chatId]).toArray();
  }

  async #setNeedKey(chatId: string, needKey: boolean): Promise<void> {
    await this.#ctx.db.groups.update([this.#acc, chatId], { needKey });
  }

  async #markGone(chatId: string): Promise<void> {
    const { db, clock } = this.#ctx;
    const acc = this.#acc;
    await db.transaction('rw', [db.groups, db.messages, db.accounts], async () => {
      const g = await db.groups.get([acc, chatId]);
      if (!g || !g.member) return;
      const now = clock.now();
      await db.groups.put({ ...g, member: false, left: { reason: 'removed', at: now } });
      await this.#putService(chatId, `gone:${g.state?.version ?? 0}`, { type: 'you-removed' }, (await this.#cursor()) + 0.5, now);
    });
  }

  /** Stores a verified state (and the epoch secret it came with) and its service entries. */
  async #commitState(
    chatId: string,
    prev: GroupState | undefined,
    state: GroupState,
    secret: Uint8Array | undefined,
    keyN: number | undefined,
    jumped: boolean,
  ): Promise<void> {
    const { db } = this.#ctx;
    const acc = this.#acc;
    const me = this.#me;
    await db.transaction(
      'rw',
      [db.groups, db.groupStates, db.epochKeys, db.sealedKeys, db.messages, db.chats, db.notices, db.accounts],
      async () => {
        await db.groupStates.put({ accountId: acc, chatId, version: state.version, epoch: state.epoch, state });
        if (secret && !(await db.epochKeys.get([acc, chatId, state.epoch]))) {
          await db.epochKeys.put({ accountId: acc, chatId, epoch: state.epoch, secret, stateVersion: state.version });
        }
        if (keyN !== undefined) await db.sealedKeys.update([acc, keyN], { done: true });
        const g = await this.#ensureGroup(chatId);
        const member = state.members.some((m) => m.userId === me);
        const cur = g.state;
        if (!cur || state.version >= cur.version) {
          g.state = state;
          g.member = member;
          if (g.member) g.left = null;
        }
        g.needKey = false;
        await db.groups.put(g);
        await this.#stateEntries(chatId, jumped ? undefined : prev, state);
      },
    );
  }

  /** Service entries for the step prev → next (inside a transaction). */
  async #stateEntries(chatId: string, prev: GroupState | undefined, next: GroupState): Promise<void> {
    const { db, clock } = this.#ctx;
    const acc = this.#acc;
    const notice = await db.notices
      .where('[accountId+chatId]')
      .equals([acc, chatId])
      .filter((n) => (n.notice.type === 'group_created' || n.notice.type === 'group_state') && n.notice.version === next.version)
      .first();
    const gseq = notice?.gseq ?? (await this.#cursor()) + 0.5;
    const time = notice?.time ?? clock.now();
    const id = (i: number) => `v:${next.version}:${i}`;
    const entries: ServiceEntry[] = [];
    if (!prev) {
      if (next.version === 1) {
        entries.push({ type: 'created', by: next.by, name: next.name, members: next.members.map((m) => m.userId).filter((u) => u !== next.by) });
      } else {
        entries.push({ type: 'joined', by: next.by });
      }
    } else {
      const a = groupStateActions(prev, next, this.#me);
      if (a.renamed) entries.push({ type: 'renamed', by: next.by, name: next.name });
      if (a.added.length > 0) entries.push({ type: 'added', by: next.by, userIds: a.added });
      if (a.removedMembers.length > 0) {
        const leftNotices = await db.notices
          .where('[accountId+chatId]')
          .equals([acc, chatId])
          .filter((n) => n.notice.type === 'member_left')
          .toArray();
        const left = new Set(leftNotices.map((n) => (n.notice.type === 'member_left' ? n.notice.userId : '')));
        // Members who left already have their "left" entry.
        const removed = a.removedMembers.filter((u) => !left.has(u));
        if (removed.length > 0) entries.push({ type: 'removed', by: next.by, userIds: removed });
      }
      if (a.ownerChanged) entries.push({ type: 'owner', by: next.by, userId: next.owner });
    }
    for (let i = 0; i < entries.length; i++) await this.#putService(chatId, id(i), entries[i]!, gseq, time);
  }

  /** Keys for states already accepted (same epoch re-sent, other devices' keys): verify and keep the secret. */
  async #processLeftoverKeys(): Promise<void> {
    const { db, diag } = this.#ctx;
    const acc = this.#acc;
    const { session } = this.#host;
    const keys = await this.#ctx.keys(this.#me);
    const undone = await db.sealedKeys.where('[accountId+n]').between([acc, -Infinity], [acc, Infinity]).filter((k) => !k.done).toArray();
    for (const k of undone) {
      const stateRow = await db.groupStates.get([acc, k.chatId, k.version]);
      if (!stateRow) continue;
      try {
        const opened = await openGroupKey(parseSealedGroupKey(k.key), keys, { serverId: session.serverId });
        verifyGroupKey(opened, stateRow.state);
        await db.transaction('rw', [db.epochKeys, db.sealedKeys], async () => {
          if (!(await db.epochKeys.get([acc, k.chatId, opened.epoch]))) {
            await db.epochKeys.put({ accountId: acc, chatId: k.chatId, epoch: opened.epoch, secret: opened.secret, stateVersion: k.version });
          }
          await db.sealedKeys.update([acc, k.n], { done: true });
        });
      } catch (e) {
        if (!isProtocolError(e)) throw e;
        void diag.warn('verify', `group key ${k.n} for ${k.chatId} rejected: ${describeError(e)}`, acc);
        await db.sealedKeys.update([acc, k.n], { done: true });
      }
    }
  }

  // ---- archive import ----

  /**
   * Imports a signed state from an archive: verified against the stored
   * previous version when there is one, else by its embedded chain. Returns
   * false when it is already known.
   */
  importState(chatId: string, envelope: unknown): Promise<boolean> {
    return this.#exclusive(async () => {
      const { db } = this.#ctx;
      const acc = this.#acc;
      const probe = verifyGroupState(envelope, { serverId: this.#host.session.serverId, chatId });
      if (await db.groupStates.get([acc, chatId, probe.version])) return false;
      const prev = (await db.groupStates.get([acc, chatId, probe.version - 1]))?.state;
      const state = prev ? verifyGroupState(envelope, { serverId: this.#host.session.serverId, chatId, prev }) : probe;
      await this.#commitState(chatId, prev, state, undefined, undefined, false);
      return true;
    });
  }

  // ---- keys for events ----

  /**
   * Keys and authors for decoding an event of `epoch` in a group, or
   * undefined when the secret or a state of that epoch is not known yet.
   * Authors are the members of the last accepted state of that epoch.
   */
  async decodeContext(chatId: string, epoch: number): Promise<{ chat: ChatKeys; lookup: (userId: string) => Identity | undefined } | undefined> {
    const { db } = this.#ctx;
    const acc = this.#acc;
    const secret = await db.epochKeys.get([acc, chatId, epoch]);
    if (!secret) return undefined;
    const states = await db.groupStates.where('[accountId+chatId]').equals([acc, chatId]).toArray();
    const state = states.filter((s) => s.epoch === epoch).sort((a, b) => b.version - a.version)[0]?.state;
    if (!state) return undefined;
    const members = new Map(state.members.map((m) => [m.userId, m]));
    return {
      chat: deriveGroupKeys(secret.secret, epoch),
      lookup: (userId) => {
        const m = members.get(userId);
        if (!m) return undefined;
        return { userId: m.userId, signPub: m.signPub, boxPub: m.boxPub, created: 0, envelope: { payload: '', sig: '' } };
      },
    };
  }

  /** Keys to send into a group now. Throws CoreError not-member / need-key / unknown-chat. */
  async sendKeys(chatId: string): Promise<ChatKeys> {
    const { db } = this.#ctx;
    const acc = this.#acc;
    let g = await db.groups.get([acc, chatId]);
    if (!g) throw new CoreError('unknown-chat');
    if (!g.member) throw new CoreError('not-member');
    if (!g.state || (g.server && g.server.epoch > g.state.epoch) || !(await db.epochKeys.get([acc, chatId, g.state.epoch]))) {
      await this.reconcile({ full: true });
      g = await db.groups.get([acc, chatId]);
      if (!g?.member) throw new CoreError('not-member');
    }
    if (!g.state) throw new CoreError('need-key');
    if (!g.state.members.some((m) => m.userId === this.#me)) throw new CoreError('not-member');
    const secret = await db.epochKeys.get([acc, chatId, g.state.epoch]);
    if (!secret) throw new CoreError('need-key');
    return deriveGroupKeys(secret.secret, g.state.epoch);
  }

  // ---- changes (owner) ----

  /**
   * Builds, stores and sends a group change. Returns the chat id. On a lost
   * version race the change is rebuilt on the new state (a few times).
   * Transient errors propagate; the stored change is re-sent later.
   */
  change(op: GroupOp, chatId?: string): Promise<string> {
    return this.#ctx.locks.request(`fc-groups-${this.#acc}`, () => this.#exclusive(() => this.#change(op, chatId)));
  }

  async #change(op: GroupOp, chatIdIn: string | undefined): Promise<string> {
    const { db } = this.#ctx;
    const acc = this.#acc;
    for (let attempt = 0; attempt < MAX_CHANGE_ATTEMPTS; attempt++) {
      if (chatIdIn) {
        // An older change of this group goes first.
        const pending = await db.groupPending.get([acc, chatIdIn]);
        if (pending) await this.#sendPending(pending);
      }
      const built = await this.#build(op, chatIdIn);
      if (!built) return chatIdIn ?? '';
      const { change, baseVersion } = built;
      const chatId = change.state.chatId;
      const row: GroupPendingRow = {
        accountId: acc,
        chatId,
        op,
        baseVersion,
        state: change.state,
        blob: change.blob,
        secret: change.secret,
        newEpoch: change.newEpoch,
        keys: change.sealedKeys.map((k) => ({ userId: k.recipient, key: serializeEnvelope(k.envelope) })),
        createdAt: this.#ctx.clock.now(),
        attempts: 0,
        error: null,
      };
      await db.transaction('rw', [db.groupPending, db.groups, db.chats], async () => {
        await db.groupPending.put(row);
        if (op.type === 'create') {
          await this.#ensureGroup(chatId);
        }
      });
      const r = await this.#sendPending(row);
      if (r === 'done') return chatId;
      chatIdIn = chatId;
    }
    throw new CoreError('busy', 'the group changed several times meanwhile; try again');
  }

  /** The next state for `op`, or undefined when there is nothing to do (an automatic removal already done). */
  async #build(op: GroupOp, chatId: string | undefined): Promise<{ change: GroupChange; baseVersion: number | null } | undefined> {
    const { db } = this.#ctx;
    const { session } = this.#host;
    const acc = this.#acc;
    const owner = await this.#ctx.keys(this.#me);
    if (op.type === 'create') {
      const members = await this.#memberInputs(op.members.filter((u) => u !== this.#me));
      return { change: await createGroup({ serverId: session.serverId, owner, name: op.name, members }), baseVersion: null };
    }
    if (!chatId) throw new CoreError('invalid-input', 'no chat');
    const g = await db.groups.get([acc, chatId]);
    if (!g) throw new CoreError('unknown-chat');
    if (!g.member || !g.state) throw new CoreError(g.member ? 'need-key' : 'not-member');
    const prev = g.state;
    if (prev.owner !== this.#me) throw new CoreError('not-owner');
    const secretRow = await db.epochKeys.get([acc, chatId, prev.epoch]);
    const secret = secretRow?.secret;
    const needSecret = () => {
      if (!secret) throw new CoreError('need-key');
      return secret;
    };
    switch (op.type) {
      case 'rename':
        return { change: await renameGroup({ prev, owner, secret: needSecret(), name: op.name }), baseVersion: prev.version };
      case 'add': {
        const ids = op.userIds.filter((u) => !prev.members.some((m) => m.userId === u));
        if (ids.length === 0) return undefined;
        const members = await this.#memberInputs(ids);
        return {
          change: await addGroupMembers({ prev, owner, secret: needSecret(), members, history: op.history }),
          baseVersion: prev.version,
        };
      }
      case 'remove': {
        const ids = op.userIds.filter((u) => u !== prev.owner && prev.members.some((m) => m.userId === u));
        if (ids.length === 0) {
          if (op.auto) return undefined;
          throw new CoreError('invalid-input', 'not a member of the group');
        }
        return { change: await removeGroupMembers({ prev, owner, userIds: ids }), baseVersion: prev.version };
      }
      case 'transfer':
        if (prev.owner === op.to) return undefined;
        return { change: await transferGroupOwnership({ prev, owner, secret: needSecret(), to: op.to }), baseVersion: prev.version };
    }
  }

  /** Verified keys of family members to put into a state; refuses removed and revoked ones. */
  async #memberInputs(userIds: readonly string[]): Promise<GroupMemberInput[]> {
    const { directory } = this.#host;
    const out: GroupMemberInput[] = [];
    for (const id of new Set(userIds)) {
      let row = await directory.user(id);
      if (!row) {
        await directory.refresh();
        row = await directory.user(id);
      }
      if (!row) throw new CoreError('unknown-user');
      if (row.removed) throw new CoreError('invalid-input', 'the member was removed from the family');
      if (row.revoked) throw new CoreError('peer-revoked');
      out.push({ userId: row.userId, signPub: row.signPub, boxPub: row.boxPub });
    }
    return out;
  }

  /**
   * Sends a stored change. 'done': the server has it (now or from an earlier
   * attempt) and it is committed locally; 'lost': another version won, the
   * change was dropped and the group re-read.
   */
  async #sendPending(row: GroupPendingRow): Promise<'done' | 'lost'> {
    const { db, diag } = this.#ctx;
    const { session } = this.#host;
    const acc = this.#acc;
    const chatId = row.chatId;
    const members = row.state.members.map((m) => m.userId);
    try {
      const entry =
        row.baseVersion === null
          ? await session.call((t) =>
              session.transport.createGroup(t, { chatId, state: row.blob, members, epoch: row.state.epoch, keys: row.keys }),
            )
          : await session.call((t) =>
              session.transport.changeGroup(t, chatId, {
                baseVersion: row.baseVersion as number,
                state: row.blob,
                members,
                owner: row.state.owner,
                epoch: row.state.epoch,
                keys: row.keys,
              }),
            );
      await this.#commitOwn(row, entry);
      return 'done';
    } catch (e) {
      if (row.baseVersion === null && isApiError(e, 'chat_exists')) {
        if (await this.#sameOnServer(chatId, 1, row.blob)) {
          await this.#commitOwn(row, null);
          return 'done';
        }
        await this.#dropPending(row);
        throw new CoreError('invalid-input', 'group id already taken');
      }
      if (isApiError(e, 'stale_version')) {
        const base = row.baseVersion as number;
        if ((e.details.version ?? base + 1) >= base + 1 && (await this.#sameOnServer(chatId, base + 1, row.blob))) {
          await this.#commitOwn(row, null);
          return 'done';
        }
        await this.#dropPending(row);
        void diag.info('group', `change of ${chatId} lost the version race at ${base}; re-reading`, acc);
        await this.#reconcile({ full: true });
        return 'lost';
      }
      if (isTransient(e)) {
        await db.groupPending.update([acc, chatId], { attempts: row.attempts + 1, error: errorCode(e) });
        throw e;
      }
      await this.#dropPending(row);
      if (isApiError(e, 'not_owner')) {
        await this.#reconcile({ full: true }).catch(() => undefined);
        throw new CoreError('not-owner');
      }
      if (isApiError(e, 'not_member')) throw new CoreError('not-member');
      throw e;
    }
  }

  async #sameOnServer(chatId: string, version: number, blob: Uint8Array): Promise<boolean> {
    const { session } = this.#host;
    try {
      const theirs = await session.call((t) => session.transport.groupState(t, chatId, version));
      return sameBytes(theirs, blob);
    } catch (e) {
      if (isApiError(e, 'not_found') || isApiError(e, 'not_member') || isApiError(e, 'chat_not_found')) return false;
      throw e;
    }
  }

  async #dropPending(row: GroupPendingRow): Promise<void> {
    const { db } = this.#ctx;
    await db.transaction('rw', [db.groupPending, db.groups, db.chats], async () => {
      await db.groupPending.delete([this.#acc, row.chatId]);
      if (row.baseVersion === null) {
        const g = await db.groups.get([this.#acc, row.chatId]);
        if (g && !g.state) {
          await db.groups.delete([this.#acc, row.chatId]);
          await db.chats.delete([this.#acc, row.chatId]);
        }
      }
    });
  }

  async #commitOwn(row: GroupPendingRow, entry: ChatEntry | null): Promise<void> {
    const { db } = this.#ctx;
    const acc = this.#acc;
    const me = this.#me;
    const state = row.state;
    await db.transaction(
      'rw',
      [db.groups, db.groupStates, db.epochKeys, db.groupPending, db.messages, db.chats, db.notices, db.accounts],
      async () => {
        const prev = row.baseVersion === null ? undefined : (await db.groupStates.get([acc, row.chatId, row.baseVersion]))?.state;
        await db.groupStates.put({ accountId: acc, chatId: row.chatId, version: state.version, epoch: state.epoch, state });
        if (!(await db.epochKeys.get([acc, row.chatId, state.epoch]))) {
          await db.epochKeys.put({ accountId: acc, chatId: row.chatId, epoch: state.epoch, secret: row.secret, stateVersion: state.version });
        }
        const g = await this.#ensureGroup(row.chatId);
        if (!g.state || state.version > g.state.version) g.state = state;
        if (entry) g.server = { version: entry.version ?? state.version, epoch: entry.epoch, owner: entry.owner, members: [...entry.members] };
        else if (!g.server || g.server.version < state.version) {
          g.server = { version: state.version, epoch: state.epoch, owner: state.owner, members: state.members.map((m) => m.userId) };
        }
        g.member = state.members.some((m) => m.userId === me);
        g.needKey = false;
        if (g.member) g.left = null;
        await db.groups.put(g);
        if (!(await db.messages.get([acc, SERVICE_SENDER, `v:${state.version}:0`]))) await this.#stateEntries(row.chatId, prev, state);
        await db.groupPending.delete([acc, row.chatId]);
      },
    );
    void this.#ctx.diag.info('group', `group ${row.chatId} is at version ${state.version} (${row.op.type})`, acc);
    await this.#host.retryPending(new Set([row.chatId]));
  }

  /** Re-sends changes stored before a crash or a lost answer. */
  async flushPending(): Promise<void> {
    const { db } = this.#ctx;
    const rows = await db.groupPending.where('accountId').equals(this.#acc).toArray();
    for (const row of rows) {
      await this.#ctx.locks.request(`fc-groups-${this.#acc}`, () =>
        this.#exclusive(async () => {
          const fresh = await db.groupPending.get([this.#acc, row.chatId]);
          if (!fresh) return;
          const r = await this.#sendPending(fresh);
          if (r === 'lost' && !(fresh.op.type === 'remove' && fresh.op.auto)) {
            // A user's change from before the crash: apply it to the new state once.
            await this.#change(fresh.op, fresh.chatId).catch((e: unknown) => {
              if (isTransient(e)) throw e;
              void this.#ctx.diag.warn('group', `stored change of ${fresh.chatId} dropped: ${describeError(e)}`, this.#acc);
            });
          }
        }),
      );
    }
  }

  /**
   * The owner's client removes members who left (missing from the server's
   * list), were removed from the family or revoked their identity: one new
   * state with a new epoch per group.
   */
  async ownerDuties(): Promise<void> {
    const { db } = this.#ctx;
    const { directory } = this.#host;
    const acc = this.#acc;
    const me = this.#me;
    const groups = await db.groups.where('accountId').equals(acc).toArray();
    for (const g of groups) {
      if (!g.member || !g.state || g.state.owner !== me || !g.server || g.broken) continue;
      if (g.server.version !== g.state.version) continue; // not up to date yet
      if (await db.groupPending.get([acc, g.chatId])) continue;
      const gone: string[] = [];
      for (const m of g.state.members) {
        if (m.userId === me) continue;
        const u = await directory.user(m.userId);
        if (!g.server.members.includes(m.userId) || u?.removed || u?.revoked) gone.push(m.userId);
      }
      if (gone.length === 0) continue;
      try {
        await this.change({ type: 'remove', userIds: gone, auto: true }, g.chatId);
      } catch (e) {
        if (isTransient(e)) throw e;
        void this.#ctx.diag.warn('group', `automatic removal in ${g.chatId} failed: ${describeError(e)}`, acc);
      }
    }
  }

  // ---- leaving ----

  /** Leaves a group. The owner passes `transferTo` (ownership goes first). */
  async leave(chatId: string, transferTo?: string): Promise<void> {
    const { db, clock } = this.#ctx;
    const { session } = this.#host;
    const acc = this.#acc;
    const g = await db.groups.get([acc, chatId]);
    if (!g) throw new CoreError('unknown-chat');
    if (!g.member) return;
    if (g.state?.owner === this.#me) {
      if (!transferTo) throw new CoreError('owner-cannot-leave');
      await this.change({ type: 'transfer', to: transferTo }, chatId);
    }
    try {
      await session.call((t) => session.transport.leaveGroup(t, chatId));
    } catch (e) {
      if (isApiError(e, 'owner_cannot_leave')) throw new CoreError('owner-cannot-leave');
      if (!isApiError(e, 'not_member')) throw e;
    }
    await db.groups.update([acc, chatId], { member: false, left: { reason: 'left', at: clock.now() } });
  }
}

function errorCode(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  if (typeof c === 'string') return c;
  const r = (e as { reason?: unknown } | null)?.reason;
  return typeof r === 'string' ? `network ${r}` : 'error';
}
