// An in-memory imitation of fcd's API (docs/API.md) exposed as a `fetch`
// function, for unit tests. Envelopes are verified with the protocol package,
// the long poll is real (with a scaled clock), and failures can be injected.

import {
  base32Encode,
  base64urlDecode,
  base64urlEncode,
  dmChatId,
  randomBytes,
  verifyAuthEnvelope,
  verifyIdentityEnvelope,
  verifyProfileEnvelope,
  verifyRevocationEnvelope,
  type Identity,
  type SignedEnvelope,
} from '@family-chat/protocol';
import type { FetchFn } from '../../src/api/transport.ts';

interface User {
  identity: Identity;
  profile: SignedEnvelope;
  rev: number;
  name: string;
  admin: boolean;
  removed: boolean;
  removedAt: number | null;
  devices: Map<string, { token: string; createdAt: number; push: unknown | null }>;
  revoked?: SignedEnvelope | null;
  avatars?: Map<string, { type: string; bytes: Uint8Array }>;
  keys?: { n: number; chatId: string; epoch: number; version: number; time: number; key: string }[];
}

export interface FakeChat {
  members: string[];
  createdAt: number;
  kind?: 'dm' | 'group';
  owner?: string;
  version?: number;
  epoch?: number;
  states?: Map<number, Uint8Array>;
}

interface Ev {
  gseq: number;
  time: number;
  chatId: string;
  senderId: string;
  devId: string;
  epoch: number;
  msgId: string;
  body: Uint8Array;
  /** Server notice (kind "notice") instead of a member event, with its recipients. */
  notice?: Record<string, unknown>;
  to?: string[];
  /** Deleted for everyone: served with an empty body and `deleted: true`. */
  deleted?: boolean;
}

export interface FakeServerOptions {
  serverId?: string;
  familyName?: string;
  /** Milliseconds per "second" of `wait` (default 20, so wait=25 lasts 0.5 s). */
  msPerSecond?: number;
  push?: boolean;
  /** maxBlobBytes in /v1/hello (default: as fcd for 200 MB). */
  maxBlobBytes?: number;
}

type Handler = (req: Req) => Promise<Res> | Res;
interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: Uint8Array;
  signal: AbortSignal | undefined;
  json(): unknown;
}
interface Res {
  status: number;
  body?: unknown;
  /** Raw bytes (application/octet-stream unless headers say otherwise). */
  raw?: Uint8Array;
  headers?: Record<string, string>;
}

function err(status: number, error: string, extra: Record<string, unknown> = {}): Res {
  return { status, body: { error, message: error, ...extra } };
}

export class FakeServer {
  readonly serverId: string;
  readonly familyName: string;
  adminCode = 'ABCD-EFGH-JKMN-PQRS';
  adminCodeActive = true;
  readonly users = new Map<string, User>();
  readonly tokens = new Map<string, { user: string; dev: string }>();
  readonly invites = new Map<string, { id: string; createdAt: number; expiresAt: number; createdBy: string; usedAt: number | null; usedBy: string | null; expired?: boolean }>();
  readonly chats = new Map<string, FakeChat>();
  readonly blobs = new Map<string, { owner: string; createdAt: number; parts: Map<number, Uint8Array> }>();
  readonly maxBlobBytes: number;
  readonly log: Ev[] = [];
  /** DELETE /v1/chats/<id>/events/<gseq> requests that passed the checks. */
  readonly deleteRequests: { chatId: string; gseq: number; by: string }[] = [];
  readonly nonces = new Set<string>();
  readonly idem = new Map<string, Ev>();
  oldestGseq = 1;
  nextGseq = 1;
  now = 1_800_000_000_000;
  /** `/v1/hello` offerSetup (`fcd --offer-setup`). */
  offerSetup = false;
  /** Test notifications sent by `/v1/check/push`: device and delay. */
  readonly checkPushes: { dev: string; delaySeconds: number }[] = [];
  readonly msPerSecond: number;
  readonly push: boolean;

  /** All requests seen: "METHOD path". */
  readonly requests: string[] = [];
  /** When true, fetch rejects as if the network were down. */
  offline = false;
  /** Responses to inject before normal handling, matched by "METHOD /path" prefix. */
  readonly inject: { match: string; res: Res | 'network'; times: number }[] = [];
  /** Hold POST events until resolved (to simulate slow sends). */
  postGate: Promise<void> | undefined;

  readonly #waiters = new Set<() => void>();

  constructor(options: FakeServerOptions = {}) {
    this.serverId = options.serverId ?? base64urlEncode(randomBytes(16));
    this.familyName = options.familyName ?? 'Семья';
    this.msPerSecond = options.msPerSecond ?? 20;
    this.push = options.push ?? true;
    this.maxBlobBytes = options.maxBlobBytes ?? 200 * 1048576 + 65536;
  }

  /** Appends a server notice for `to`. */
  appendNotice(chatId: string, notice: Record<string, unknown>, to: string[]): Ev {
    const ev: Ev = { gseq: this.nextGseq++, time: this.now++, chatId, senderId: '', devId: '', epoch: 0, msgId: '', body: new Uint8Array(), notice, to: [...to] };
    this.log.push(ev);
    this.#wake();
    return ev;
  }

  #groupsOf(userId: string): [string, FakeChat][] {
    return [...this.chats].filter(([, c]) => c.kind === 'group' && c.members.includes(userId));
  }

  #addKey(userId: string, chatId: string, epoch: number, version: number, key: string): void {
    const u = this.users.get(userId)!;
    u.keys ??= [];
    u.keys.push({ n: u.keys.length + 1, chatId, epoch, version, time: this.now, key });
  }

  #chatJson(chatId: string, c: FakeChat) {
    const last = [...this.log].reverse().find((e) => e.chatId === chatId && !e.notice);
    const group = c.kind === 'group';
    return {
      chatId,
      kind: group ? 'group' : 'dm',
      members: [...c.members].sort(),
      owner: group ? c.owner : null,
      version: group ? c.version : null,
      epoch: c.epoch ?? 0,
      createdAt: c.createdAt,
      lastGseq: last?.gseq ?? null,
      lastTime: last?.time ?? null,
    };
  }

  /** Requests handled normally whose answer is then lost (network error), matched by prefix. */
  readonly loseAnswer: { match: string; times: number }[] = [];

  /** Process the next `times` matching requests, then fail them as if the answer was lost. */
  failAfter(match: string, times = 1): void {
    this.loseAnswer.push({ match, times });
  }

  /** Inject a response for the next `times` matching requests. */
  failNext(match: string, res: Res | 'network', times = 1): void {
    this.inject.push({ match, res, times });
  }

  newInviteCode(): string {
    const code = base32Encode(randomBytes(16));
    this.invites.set(code, { id: code.padEnd(64, '0'), createdAt: this.now, expiresAt: this.now + 7 * 86400_000, createdBy: '', usedAt: null, usedBy: null });
    return code;
  }

  /** Invalidate every token of a user (as if devices re-logged elsewhere). */
  revokeTokens(userId: string): void {
    for (const [t, c] of this.tokens) if (c.user === userId) this.tokens.delete(t);
  }

  removeUser(userId: string): void {
    const u = this.users.get(userId);
    if (!u) return;
    u.removed = true;
    u.removedAt = this.now;
    u.admin = false;
    this.#memberEvent('member_removed', userId);
    this.#wake();
  }

  #memberEvent(type: string, userId: string): void {
    for (const [chatId, c] of this.#groupsOf(userId)) {
      const to = c.owner === userId ? c.members.filter((m) => m !== userId) : [c.owner!];
      this.appendNotice(chatId, { type, userId }, to);
    }
  }

  /** Drop events with gseq < n (retention). */
  expireBefore(n: number): void {
    this.oldestGseq = n;
    for (let i = this.log.length - 1; i >= 0; i--) if (this.log[i]!.gseq < n) this.log.splice(i, 1);
  }

  /** Insert a raw event as if a user's device sent it (bypassing checks). */
  appendRaw(e: Omit<Ev, 'gseq' | 'time'>): Ev {
    const ev = { ...e, gseq: this.nextGseq++, time: this.now++ };
    this.log.push(ev);
    if (!this.chats.has(e.chatId)) {
      const peer = this.#peerFor(e.senderId, e.chatId);
      if (peer) this.chats.set(e.chatId, { members: [e.senderId, peer].sort(), createdAt: ev.time });
    }
    this.#wake();
    return ev;
  }

  readonly fetch: FetchFn = async (input, init) => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const key = `${method} ${url.pathname}`;
    this.requests.push(key);
    if (init.credentials !== 'omit') throw new Error('fake server: credentials must be omit');
    if (this.offline) throw new TypeError('fetch failed');
    for (const inj of this.inject) {
      if (inj.times > 0 && key.startsWith(inj.match)) {
        inj.times--;
        if (inj.res === 'network') throw new TypeError('fetch failed');
        return toResponse(inj.res);
      }
    }
    const raw = init.body;
    const body =
      raw instanceof Uint8Array ? raw : typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array();
    const req: Req = {
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init.headers),
      body,
      signal: init.signal ?? undefined,
      json: () => JSON.parse(new TextDecoder().decode(body)),
    };
    if (req.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const res = await this.#route(req);
    if (req.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    for (const l of this.loseAnswer) {
      if (l.times > 0 && key.startsWith(l.match)) {
        l.times--;
        throw new TypeError('fetch failed after the server handled it');
      }
    }
    return toResponse(res);
  };

  #wake(): void {
    for (const w of [...this.#waiters]) w();
  }

  #auth(req: Req): { user: User; userId: string; dev: string } | Res {
    const h = req.headers.get('authorization') ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const c = this.tokens.get(token);
    if (!c) return err(401, 'unauthorized');
    const user = this.users.get(c.user)!;
    if (user.revoked) return err(403, 'revoked');
    if (user.removed) return err(403, 'removed');
    return { user, userId: c.user, dev: c.dev };
  }

  #issue(userId: string, devId: string): Res {
    const user = this.users.get(userId)!;
    const old = user.devices.get(devId);
    if (old) this.tokens.delete(old.token);
    const token = base64urlEncode(randomBytes(32));
    user.devices.set(devId, { token, createdAt: this.now, push: null });
    this.tokens.set(token, { user: userId, dev: devId });
    return { status: 200, body: { token, userId, devId, admin: user.admin } };
  }

  #peerFor(me: string, chatId: string): string | undefined {
    for (const id of this.users.keys()) {
      if (dmChatId(this.serverId, me, id) === chatId) return id;
    }
    return undefined;
  }

  #userJson(id: string, u: User) {
    return { userId: id, identity: u.identity.envelope, profile: u.profile, admin: u.admin, removed: u.removed, revoked: u.revoked ?? null };
  }

  #myEvents(userId: string, after: number, limit: number) {
    const mine = this.log.filter((e) =>
      e.gseq > after && (e.notice ? (e.to ?? []).includes(userId) : this.chats.get(e.chatId)?.members.includes(userId)),
    );
    const page = mine.slice(0, limit);
    const more = mine.length > limit;
    const cursor = more ? page[page.length - 1]!.gseq : this.nextGseq - 1;
    return { page, more, cursor };
  }

  #evJson(e: Ev) {
    if (e.notice) return { kind: 'notice', gseq: e.gseq, time: e.time, chatId: e.chatId, notice: e.notice };
    const { notice: _n, to: _t, deleted, ...rest } = e;
    if (deleted) return { kind: 'event', ...rest, body: '', deleted: true };
    return { kind: 'event', ...rest, body: base64urlEncode(e.body) };
  }

  async #route(req: Req): Promise<Res> {
    const p = req.path;
    const m = req.method;
    if (m === 'GET' && p === '/v1/hello') {
      return {
        status: 200,
        body: {
          protocol: 1,
          server: 'fcd',
          version: '0.1.0',
          serverId: this.serverId,
          familyName: this.familyName,
          retentionDays: 90,
          maxFileMb: 200,
          push: this.push,
          vapidPublicKey: this.push ? 'BOrfake' : null,
          time: this.now,
          maxEventBytes: 262144,
          maxPartBytes: 4194560,
          maxBlobBytes: this.maxBlobBytes,
          maxAvatarBytes: 262144,
          maxStateBytes: 262144,
          maxSealedKeyBytes: 8192,
          maxGroupMembers: 100,
          adminCodeActive: this.adminCodeActive,
          offerSetup: this.offerSetup,
        },
      };
    }
    if (m === 'POST' && p === '/v1/join') return this.#join(req);
    if (m === 'POST' && p === '/v1/invites/check') {
      const code = String((req.json() as { invite?: string }).invite ?? '').trim().toLowerCase();
      const inv = this.invites.get(code);
      if (!inv) return err(403, 'invalid_invite');
      const by = this.users.get(inv.createdBy);
      return {
        status: 200,
        body: {
          status: inv.usedAt !== null ? 'used' : inv.expired ? 'expired' : 'valid',
          familyName: this.familyName,
          createdBy: { userId: inv.createdBy, name: by?.name ?? null },
          createdAt: inv.createdAt,
          expiresAt: inv.expiresAt,
        },
      };
    }
    if (m === 'POST' && p === '/v1/revoke') {
      const env = req.json() as SignedEnvelope;
      let userId = '';
      try {
        userId = (JSON.parse(new TextDecoder().decode(base64urlDecode(env.payload))) as { userId: string }).userId;
      } catch {
        return err(400, 'bad_request');
      }
      const u = this.users.get(userId);
      if (!u) return err(404, 'unknown_user');
      try {
        verifyRevocationEnvelope(env, u.identity);
      } catch {
        return err(401, 'bad_signature');
      }
      if (!u.revoked) {
        u.revoked = env;
        u.admin = false;
        this.#memberEvent('member_revoked', userId);
        this.#wake();
      }
      return { status: 204 };
    }
    if (m === 'POST' && p === '/v1/auth/challenge') {
      const nonce = base64urlEncode(randomBytes(32));
      this.nonces.add(nonce);
      return { status: 200, body: { nonce, expiresAt: this.now + 120_000 } };
    }
    if (m === 'POST' && p === '/v1/auth/device') return this.#authDevice(req);

    const a = this.#auth(req);
    if ('status' in a) return a;

    if (m === 'GET' && p === '/v1/users') {
      return { status: 200, body: { users: [...this.users].sort(([x], [y]) => (x < y ? -1 : 1)).map(([id, u]) => this.#userJson(id, u)) } };
    }
    if (m === 'GET' && p === '/v1/me') {
      return { status: 200, body: { ...this.#userJson(a.userId, a.user), devId: a.dev, push: a.user.devices.get(a.dev)?.push != null } };
    }
    if (m === 'PUT' && p === '/v1/me/profile') {
      const env = req.json() as SignedEnvelope;
      let prof;
      try {
        prof = verifyProfileEnvelope(env, a.user.identity);
      } catch {
        return err(400, 'bad_request');
      }
      if (prof.rev <= a.user.rev) return err(409, 'stale_rev', { rev: a.user.rev });
      if (prof.avatar && a.user.avatars?.get(prof.avatar.sha256)?.type !== prof.avatar.type) return err(400, 'unknown_avatar');
      a.user.profile = env;
      a.user.rev = prof.rev;
      a.user.name = prof.name;
      return { status: 200, body: { profile: env } };
    }
    if (m === 'PUT' && p === '/v1/me/avatar') {
      const b = req.body;
      const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
      const webp = new TextDecoder().decode(b.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(b.subarray(8, 12)) === 'WEBP';
      if (!jpeg && !webp) return err(400, 'bad_image');
      if (b.length > 262144) return err(413, 'too_large', { limit: 262144 });
      const sha = base64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>)));
      a.user.avatars ??= new Map();
      a.user.avatars.set(sha, { type: jpeg ? 'image/jpeg' : 'image/webp', bytes: b.slice() });
      return { status: 200, body: { sha256: sha, type: jpeg ? 'image/jpeg' : 'image/webp' } };
    }
    const avatarGet = /^\/v1\/users\/([^/]+)\/avatar\/([^/]+)$/.exec(p);
    if (m === 'GET' && avatarGet) {
      const img = this.users.get(avatarGet[1]!)?.avatars?.get(decodeURIComponent(avatarGet[2]!));
      if (!img) return err(404, 'not_found');
      return { status: 200, raw: img.bytes, headers: { 'Content-Type': img.type } };
    }
    if (p === '/v1/chats' && m === 'POST') return this.#createGroup(req, a.userId);
    const stateRe = /^\/v1\/chats\/([^/]+)\/state(?:\/(\d+))?$/.exec(p);
    if (stateRe) {
      const chatId = decodeURIComponent(stateRe[1]!);
      const c = this.chats.get(chatId);
      if (!c) return err(404, 'chat_not_found');
      if (c.kind !== 'group') return err(400, 'bad_request');
      if (!c.members.includes(a.userId)) return err(403, 'not_member');
      if (m === 'GET' && stateRe[2]) {
        const blob = c.states!.get(Number(stateRe[2]));
        if (!blob) return err(404, 'not_found');
        return { status: 200, raw: blob };
      }
      if (m === 'PUT' && !stateRe[2]) return this.#changeGroup(req, a.userId, chatId, c);
    }
    const leaveRe = /^\/v1\/chats\/([^/]+)\/leave$/.exec(p);
    if (m === 'POST' && leaveRe) {
      const chatId = decodeURIComponent(leaveRe[1]!);
      const c = this.chats.get(chatId);
      if (!c) return err(404, 'chat_not_found');
      if (c.kind !== 'group') return err(400, 'bad_request');
      if (!c.members.includes(a.userId)) return err(403, 'not_member');
      if (c.owner === a.userId) return err(409, 'owner_cannot_leave');
      const to = [...c.members];
      c.members = c.members.filter((x) => x !== a.userId);
      this.appendNotice(chatId, { type: 'member_left', userId: a.userId, members: [...c.members].sort(), version: c.version, epoch: c.epoch }, to);
      return { status: 204 };
    }
    if (m === 'GET' && p === '/v1/keys') {
      const after = Number(req.query.get('after') ?? 0);
      const limit = Math.min(Number(req.query.get('limit') ?? 500), 500);
      const all = (a.user.keys ?? []).filter((k) => k.n > after);
      const page = all.slice(0, limit);
      return { status: 200, body: { keys: page, cursor: page[page.length - 1]?.n ?? after, more: all.length > page.length } };
    }
    const blobRe = /^\/v1\/blobs\/([a-z2-7]{26})(?:\/(\d+))?$/.exec(p);
    if (blobRe) {
      const id = blobRe[1]!;
      const blob = this.blobs.get(id);
      if (blobRe[2] !== undefined) {
        const part = Number(blobRe[2]);
        if (m === 'PUT') {
          if (req.body.length === 0) return err(400, 'bad_request');
          if (blob && blob.owner !== a.userId) return err(403, 'not_owner');
          const b = blob ?? { owner: a.userId, createdAt: this.now, parts: new Map() };
          const total = [...b.parts].reduce((n, [i, x]) => n + (i === part ? 0 : x.length), 0) + req.body.length;
          if (total > this.maxBlobBytes) return err(413, 'too_large', { limit: this.maxBlobBytes });
          b.parts.set(part, req.body.slice());
          this.blobs.set(id, b);
          return { status: 200, body: { blobId: id, part, size: req.body.length, total } };
        }
        if (m === 'GET') {
          const bytes = blob?.parts.get(part);
          if (!bytes) return err(404, 'blob_not_found');
          return { status: 200, raw: bytes };
        }
      } else {
        if (!blob) return err(404, 'blob_not_found');
        if (m === 'GET') {
          const parts = [...blob.parts].sort(([x], [y]) => x - y).map(([part, b]) => ({ part, size: b.length }));
          return { status: 200, body: { blobId: id, owner: blob.owner, createdAt: blob.createdAt, parts, total: parts.reduce((n, x) => n + x.size, 0), maxBytes: this.maxBlobBytes } };
        }
        if (m === 'DELETE') {
          if (blob.owner !== a.userId) return err(403, 'not_owner');
          this.blobs.delete(id);
          return { status: 204 };
        }
      }
    }
    if (p === '/v1/me/push') {
      if (m === 'PUT') {
        if (!this.push) return err(409, 'push_disabled');
        const sub = req.json() as { endpoint?: string };
        if (!sub.endpoint?.startsWith('https://')) return err(400, 'bad_request');
        a.user.devices.get(a.dev)!.push = sub;
        return { status: 204 };
      }
      if (m === 'DELETE') {
        a.user.devices.get(a.dev)!.push = null;
        return { status: 204 };
      }
    }
    if (m === 'GET' && p === '/v1/chats') {
      const chats = [...this.chats].filter(([, c]) => c.members.includes(a.userId)).map(([chatId, c]) => this.#chatJson(chatId, c));
      return { status: 200, body: { chats } };
    }
    const delEv = /^\/v1\/chats\/([^/]+)\/events\/(\d+)$/.exec(p);
    if (delEv && m === 'DELETE') {
      const chatId = decodeURIComponent(delEv[1]!);
      const gseq = Number(delEv[2]);
      const chat = this.chats.get(chatId);
      if (!chat) return err(404, 'chat_not_found');
      if (!chat.members.includes(a.userId)) return err(403, 'not_member');
      const e = this.log.find((x) => x.gseq === gseq && x.chatId === chatId && !x.notice);
      if (!e) return err(gseq < this.oldestGseq ? 410 : 404, gseq < this.oldestGseq ? 'expired' : 'event_not_found');
      if (e.senderId !== a.userId && !(chat.kind === 'group' && chat.owner === a.userId)) return err(403, 'not_author');
      this.deleteRequests.push({ chatId, gseq, by: a.userId });
      if (!e.deleted) {
        e.deleted = true;
        e.body = new Uint8Array(0);
        const to = [...new Set(chat.members)];
        this.appendNotice(chatId, { type: 'event_deleted', gseq, senderId: e.senderId, msgId: e.msgId, by: a.userId }, to);
        this.#wake();
      }
      return { status: 204 };
    }
    const chatEv = /^\/v1\/chats\/([^/]+)\/events$/.exec(p);
    if (chatEv) {
      const chatId = decodeURIComponent(chatEv[1]!);
      if (m === 'POST') return this.#post(req, a.userId, a.dev, chatId);
      if (m === 'GET') {
        const chat = this.chats.get(chatId);
        if (chat && !chat.members.includes(a.userId)) return err(403, 'not_member');
        if (!chat && !this.#peerFor(a.userId, chatId)) return err(404, 'chat_not_found');
        const before = Number(req.query.get('before') ?? Number.MAX_SAFE_INTEGER);
        const limit = Math.min(Number(req.query.get('limit') ?? 200), 500);
        const all = this.log.filter((e) => e.chatId === chatId && e.gseq < before && (!e.notice || (e.to ?? []).includes(a.userId)));
        const page = all.slice(Math.max(0, all.length - limit));
        const cursor = page[0]?.gseq ?? Math.min(before, this.nextGseq);
        return { status: 200, body: { events: page.map((e) => this.#evJson(e)), cursor, more: all.length > page.length, oldestGseq: this.oldestGseq, oldestTime: this.log[0]?.time ?? null } };
      }
    }
    if (m === 'GET' && p === '/v1/events') {
      const after = Number(req.query.get('after') ?? 0);
      const limit = Math.min(Number(req.query.get('limit') ?? 500), 500);
      const wait = Math.min(Number(req.query.get('wait') ?? 0), 30);
      const deadline = Date.now() + wait * this.msPerSecond;
      for (;;) {
        if (a.user.removed) return err(403, 'removed');
        const r = this.#myEvents(a.userId, after, limit);
        if (r.page.length > 0 || Date.now() >= deadline || req.signal?.aborted) {
          return { status: 200, body: { events: r.page.map((e) => this.#evJson(e)), cursor: r.cursor, more: r.more, oldestGseq: this.oldestGseq, oldestTime: this.log[0]?.time ?? null } };
        }
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(t);
            this.#waiters.delete(done);
            req.signal?.removeEventListener('abort', done);
            resolve();
          };
          const t = setTimeout(done, Math.max(0, deadline - Date.now()));
          this.#waiters.add(done);
          req.signal?.addEventListener('abort', done);
        });
      }
    }
    if (p === '/v1/check/wait' || p === '/v1/check/push') {
      if (!a.user.admin) return err(403, 'not_admin');
      if (m === 'GET' && p === '/v1/check/wait') {
        const seconds = Number(req.query.get('seconds') ?? 25);
        const startedAt = this.now;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, seconds * 1000);
          req.signal?.addEventListener('abort', () => (clearTimeout(t), resolve()));
        });
        return { status: 200, body: { seconds, startedAt, finishedAt: startedAt + seconds * 1000 } };
      }
      const sub = a.user.devices.get(a.dev)!.push;
      if (m === 'POST') {
        if (!this.push) return err(409, 'push_disabled');
        if (!sub) return err(409, 'no_subscription');
        const b = req.json() as { delaySeconds?: number; from?: string };
        const delaySeconds = b.delaySeconds ?? 0;
        this.checkPushes.push({ dev: a.dev, delaySeconds });
        return delaySeconds > 0
          ? { status: 202, body: { sent: false, scheduled: true, sendAt: this.now + delaySeconds * 1000 } }
          : { status: 200, body: { sent: true, outcome: { status: 201, service: 'push.example' } } };
      }
      if (m === 'GET') {
        const last = this.checkPushes.some((x) => x.dev === a.dev) ? { at: this.now, result: 'sent' } : null;
        return { status: 200, body: { last } };
      }
    }
    if (p.startsWith('/v1/admin/')) {
      if (!a.user.admin) return err(403, 'not_admin');
      if (m === 'POST' && p === '/v1/admin/invites') {
        const code = this.newInviteCode();
        const inv = this.invites.get(code)!;
        inv.createdBy = a.userId;
        return { status: 201, body: { id: inv.id, code, createdAt: inv.createdAt, expiresAt: inv.expiresAt } };
      }
      if (m === 'GET' && p === '/v1/admin/invites') {
        return { status: 200, body: { invites: [...this.invites.values()].map(({ expired: _e, ...i }) => i) } };
      }
      const invDel = /^\/v1\/admin\/invites\/([^/]+)$/.exec(p);
      if (m === 'DELETE' && invDel) {
        for (const [code, inv] of this.invites) {
          if (inv.id === invDel[1]) {
            this.invites.delete(code);
            return { status: 204 };
          }
        }
        return err(404, 'not_found');
      }
      if (m === 'GET' && p === '/v1/admin/users') {
        return {
          status: 200,
          body: {
            users: [...this.users].map(([id, u]) => ({
              userId: id,
              name: u.name,
              admin: u.admin,
              removed: u.removed,
              removedAt: u.removedAt,
              devices: [...u.devices].map(([devId, d]) => ({ devId, createdAt: d.createdAt, push: d.push !== null })),
            })),
          },
        };
      }
      const userDel = /^\/v1\/admin\/users\/([^/]+)$/.exec(p);
      if (m === 'DELETE' && userDel) {
        const id = userDel[1]!;
        if (id === a.userId) return err(409, 'cannot_remove_self');
        if (!this.users.has(id)) return err(404, 'unknown_user');
        this.removeUser(id);
        return { status: 204 };
      }
      if (m === 'GET' && p === '/v1/admin/stats') {
        return {
          status: 200,
          body: { version: '0.1.0', dataBytes: 1, freeBytes: null, totalBytes: null, events: this.log.length, oldestGseq: this.oldestGseq, lastGseq: this.nextGseq - 1, users: this.users.size, removedUsers: 0, chats: this.chats.size, groups: [...this.chats.values()].filter((c) => c.kind === 'group').length, retentionDays: 90, push: this.push },
        };
      }
    }
    return err(404, 'not_found');
  }

  #createGroup(req: Req, userId: string): Res {
    const b = req.json() as { chatId: string; state: string; members: string[]; epoch: number; keys: { userId: string; key: string }[] };
    const taken = this.chats.has(b.chatId) || [...this.users.keys()].some((x) => [...this.users.keys()].some((y) => dmChatId(this.serverId, x, y) === b.chatId));
    if (taken) return err(409, 'chat_exists');
    if (!b.members.includes(userId)) return err(400, 'bad_request');
    for (const id of b.members) {
      const u = this.users.get(id);
      if (!u || u.removed || u.revoked) return err(400, 'bad_member');
    }
    if (b.keys.length !== b.members.length || !b.members.every((id) => b.keys.some((k) => k.userId === id))) return err(400, 'bad_request');
    const c: FakeChat = { kind: 'group', members: [...b.members].sort(), owner: userId, version: 1, epoch: b.epoch, createdAt: this.now, states: new Map([[1, base64urlDecode(b.state)]]) };
    this.chats.set(b.chatId, c);
    for (const k of b.keys) this.#addKey(k.userId, b.chatId, b.epoch, 1, k.key);
    this.appendNotice(b.chatId, { type: 'group_created', by: userId, owner: userId, members: [...c.members], version: 1, epoch: b.epoch }, c.members);
    return { status: 201, body: this.#chatJson(b.chatId, c) };
  }

  #changeGroup(req: Req, userId: string, chatId: string, c: FakeChat): Res {
    const b = req.json() as { baseVersion: number; state: string; members: string[]; owner: string; epoch: number; keys: { userId: string; key: string }[] };
    if (c.owner !== userId) return err(403, 'not_owner');
    if (b.baseVersion !== c.version) return err(409, 'stale_version', { version: c.version });
    if (!b.members.includes(b.owner)) return err(400, 'bad_request');
    const removed = c.members.filter((x) => !b.members.includes(x));
    const added = b.members.filter((x) => !c.members.includes(x));
    for (const id of [...added, b.owner]) {
      const u = this.users.get(id);
      if (!u || u.removed || u.revoked) return err(400, 'bad_member');
    }
    if (b.epoch !== c.epoch && b.epoch !== c.epoch! + 1) return err(400, 'bad_request', { epoch: c.epoch });
    if (removed.length > 0 && b.epoch !== c.epoch! + 1) return err(400, 'bad_request', { epoch: c.epoch });
    const to = [...new Set([...c.members, ...b.members])].sort();
    const by = c.owner!;
    c.version = c.version! + 1;
    c.epoch = b.epoch;
    c.owner = b.owner;
    c.members = [...b.members].sort();
    c.states!.set(c.version, base64urlDecode(b.state));
    for (const k of b.keys) this.#addKey(k.userId, chatId, b.epoch, c.version, k.key);
    this.appendNotice(chatId, { type: 'group_state', by, owner: c.owner, members: [...c.members], version: c.version, epoch: c.epoch, added: added.sort(), removed: removed.sort() }, to);
    return { status: 200, body: this.#chatJson(chatId, c) };
  }

  #join(req: Req): Res {
    const b = req.json() as { invite?: string; adminCode?: string; identity: SignedEnvelope; profile: SignedEnvelope; devId: string };
    if ((b.invite === undefined) === (b.adminCode === undefined)) return err(400, 'bad_request');
    if (!/^[a-z2-7]{16}$/.test(b.devId)) return err(400, 'bad_request');
    let identity: Identity;
    try {
      identity = verifyIdentityEnvelope(b.identity);
    } catch {
      return err(401, 'bad_signature');
    }
    let prof;
    try {
      prof = verifyProfileEnvelope(b.profile, identity);
    } catch {
      return err(401, 'bad_signature');
    }
    let admin = false;
    if (b.adminCode !== undefined) {
      if (!this.adminCodeActive || b.adminCode.toUpperCase() !== this.adminCode) return err(403, 'invalid_code');
    } else {
      const inv = this.invites.get(b.invite!.trim().toLowerCase());
      if (!inv) return err(403, 'invalid_invite');
      if (inv.usedAt !== null) return err(410, 'invite_used');
      if (inv.expired) return err(410, 'invite_expired');
    }
    const existing = this.users.get(identity.userId);
    if (existing && !existing.removed) return err(409, 'already_member');
    if (b.adminCode !== undefined) {
      admin = true;
      this.adminCodeActive = false;
    } else {
      const inv = this.invites.get(b.invite!.trim().toLowerCase())!;
      inv.usedAt = this.now;
      inv.usedBy = identity.userId;
    }
    if (existing) {
      existing.removed = false;
      existing.removedAt = null;
      existing.devices.clear();
    } else {
      this.users.set(identity.userId, {
        identity,
        profile: b.profile,
        rev: prof.rev,
        name: prof.name,
        admin,
        removed: false,
        removedAt: null,
        devices: new Map(),
      });
    }
    return this.#issue(identity.userId, b.devId);
  }

  #authDevice(req: Req): Res {
    const env = req.json() as SignedEnvelope;
    let payload: { userId?: string; nonce?: string };
    try {
      payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(env.payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
    } catch {
      return err(400, 'bad_request');
    }
    const nonce = payload.nonce ?? '';
    const nonceOk = this.nonces.delete(nonce);
    const user = this.users.get(payload.userId ?? '');
    if (!user) return err(404, 'unknown_user');
    let req2;
    try {
      req2 = verifyAuthEnvelope(env, user.identity);
    } catch {
      return err(401, 'bad_signature');
    }
    if (req2.serverId !== this.serverId) return err(400, 'bad_request');
    if (!nonceOk) return err(401, 'bad_nonce');
    if (user.removed) return err(403, 'removed');
    return this.#issue(req2.userId, req2.devId);
  }

  async #post(req: Req, userId: string, dev: string, chatId: string): Promise<Res> {
    const msgId = req.headers.get('idempotency-key') ?? '';
    const epoch = req.headers.get('x-fc-epoch');
    if (!/^[a-z2-7]{26}$/.test(msgId) || epoch === null) return err(400, 'bad_request');
    if (req.body.length === 0) return err(400, 'bad_request');
    if (this.postGate) await this.postGate;
    const key = `${userId}/${msgId}`;
    const dup = this.idem.get(key);
    if (dup) {
      if (dup.chatId !== chatId) return err(409, 'idempotency_conflict');
      return { status: 200, body: { gseq: dup.gseq, time: dup.time, duplicate: true } };
    }
    let chat = this.chats.get(chatId);
    if (chat && !chat.members.includes(userId)) return err(403, 'not_member');
    if (!chat) {
      const peer = this.#peerFor(userId, chatId);
      if (!peer) return err(404, 'chat_not_found');
      chat = { members: [userId, peer].sort(), createdAt: this.now };
      this.chats.set(chatId, chat);
    }
    if (chat.kind === 'group') {
      if (Number(epoch) !== chat.epoch) return err(409, 'epoch_mismatch', { epoch: chat.epoch });
    } else {
      const peer = chat.members.find((x) => x !== userId) ?? userId;
      const pu = this.users.get(peer);
      if (pu?.removed || pu?.revoked) return err(403, 'peer_removed');
      if (epoch !== '0') return err(409, 'epoch_mismatch', { epoch: 0 });
    }
    const ev: Ev = { gseq: this.nextGseq++, time: this.now++, chatId, senderId: userId, devId: dev, epoch: Number(epoch), msgId, body: req.body.slice() };
    this.log.push(ev);
    this.idem.set(key, ev);
    this.#wake();
    return { status: 200, body: { gseq: ev.gseq, time: ev.time, duplicate: false } };
  }
}

function toResponse(res: Res): Response {
  if (res.raw) {
    return new Response(res.raw as Uint8Array<ArrayBuffer>, { status: res.status, headers: { 'Content-Type': 'application/octet-stream', ...(res.headers ?? {}) } });
  }
  if (res.status === 204 || res.body === undefined) {
    return new Response(null, { status: res.status, headers: res.headers ?? {} });
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(res.headers ?? {}) };
  return new Response(JSON.stringify(res.body), { status: res.status, headers });
}
