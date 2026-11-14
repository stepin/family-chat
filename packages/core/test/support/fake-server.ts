// An in-memory imitation of fcd's M1 API (docs/API.md) exposed as a `fetch`
// function, for unit tests. Envelopes are verified with the protocol package,
// the long poll is real (with a scaled clock), and failures can be injected.

import {
  base32Encode,
  base64urlEncode,
  dmChatId,
  randomBytes,
  verifyAuthEnvelope,
  verifyIdentityEnvelope,
  verifyProfileEnvelope,
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
}

export interface FakeServerOptions {
  serverId?: string;
  familyName?: string;
  /** Milliseconds per "second" of `wait` (default 20, so wait=25 lasts 0.5 s). */
  msPerSecond?: number;
  push?: boolean;
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
  readonly chats = new Map<string, { members: [string, string]; createdAt: number }>();
  readonly log: Ev[] = [];
  readonly nonces = new Set<string>();
  readonly idem = new Map<string, Ev>();
  oldestGseq = 1;
  nextGseq = 1;
  now = 1_800_000_000_000;
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
    this.#wake();
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
      if (peer) this.chats.set(e.chatId, { members: [e.senderId, peer].sort() as [string, string], createdAt: ev.time });
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
      if (id !== me && dmChatId(this.serverId, me, id) === chatId) return id;
    }
    return undefined;
  }

  #userJson(id: string, u: User) {
    return { userId: id, identity: u.identity.envelope, profile: u.profile, admin: u.admin, removed: u.removed };
  }

  #myEvents(userId: string, after: number, limit: number) {
    const mine = this.log.filter((e) => e.gseq > after && this.chats.get(e.chatId)?.members.includes(userId));
    const page = mine.slice(0, limit);
    const more = mine.length > limit;
    const cursor = more ? page[page.length - 1]!.gseq : this.nextGseq - 1;
    return { page, more, cursor };
  }

  #evJson(e: Ev) {
    return { ...e, body: base64urlEncode(e.body) };
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
          adminCodeActive: this.adminCodeActive,
          m0: false,
        },
      };
    }
    if (m === 'POST' && p === '/v1/join') return this.#join(req);
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
      a.user.profile = env;
      a.user.rev = prof.rev;
      a.user.name = prof.name;
      return { status: 200, body: { profile: env } };
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
      const chats = [...this.chats]
        .filter(([, c]) => c.members.includes(a.userId))
        .map(([chatId, c]) => {
          const last = [...this.log].reverse().find((e) => e.chatId === chatId);
          return { chatId, kind: 'dm', members: c.members, epoch: 0, createdAt: c.createdAt, lastGseq: last?.gseq ?? null, lastTime: last?.time ?? null };
        });
      return { status: 200, body: { chats } };
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
        const all = this.log.filter((e) => e.chatId === chatId && e.gseq < before);
        const page = all.slice(Math.max(0, all.length - limit));
        const cursor = page[0]?.gseq ?? Math.min(before, this.nextGseq);
        return { status: 200, body: { events: page.map((e) => this.#evJson(e)), cursor, more: all.length > page.length, oldestGseq: this.oldestGseq } };
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
          return { status: 200, body: { events: r.page.map((e) => this.#evJson(e)), cursor: r.cursor, more: r.more, oldestGseq: this.oldestGseq } };
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
          body: { version: '0.1.0', dataBytes: 1, freeBytes: null, totalBytes: null, events: this.log.length, oldestGseq: this.oldestGseq, lastGseq: this.nextGseq - 1, users: this.users.size, removedUsers: 0, chats: this.chats.size, retentionDays: 90, push: this.push },
        };
      }
    }
    return err(404, 'not_found');
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
      chat = { members: [userId, peer].sort() as [string, string], createdAt: this.now };
      this.chats.set(chatId, chat);
    }
    const peer = chat.members.find((x) => x !== userId)!;
    if (this.users.get(peer)?.removed) return err(403, 'peer_removed');
    if (epoch !== '0') return err(409, 'epoch_mismatch', { epoch: 0 });
    const ev: Ev = { gseq: this.nextGseq++, time: this.now++, chatId, senderId: userId, devId: dev, epoch: 0, msgId, body: req.body.slice() };
    this.log.push(ev);
    this.idem.set(key, ev);
    this.#wake();
    return { status: 200, body: { gseq: ev.gseq, time: ev.time, duplicate: false } };
  }
}

function toResponse(res: Res): Response {
  if (res.status === 204 || res.body === undefined) {
    return new Response(null, { status: res.status, headers: res.headers ?? {} });
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(res.headers ?? {}) };
  return new Response(JSON.stringify(res.body), { status: res.status, headers });
}
