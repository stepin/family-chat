// Typed client of every fcd endpoint (docs/API.md). Stateless: endpoints that
// need a device token take it as the first argument; re-login lives in Session.
//
// No cookies (`credentials: 'omit'`), no caching. `fetch` and the clock are
// injectable for tests. The optional `onExchange` hook reports method, path
// template, status and duration for diagnostics: never tokens or bodies.

import { base64urlDecode, base64urlEncode, type SignedEnvelope } from '@family-chat/protocol';
import { systemClock, type Clock } from '../util/clock.ts';
import { ApiError, isServerErrorCode, NetworkError } from './errors.ts';
import type {
  AdminUser,
  CheckLastPush,
  CheckPushResult,
  CheckWaitResult,
  AvatarUpload,
  BlobInfo,
  BlobPartResult,
  ChangeGroupRequest,
  Challenge,
  ChatEntry,
  CreatedFamily,
  CreateGroupRequest,
  InviteCheck,
  KeysPage,
  NoticeBody,
  ServerNotice,
  EventsPage,
  EventsQuery,
  Hello,
  HistoryQuery,
  InviteInfo,
  IssuedToken,
  JoinRequest,
  MeEntry,
  NewInvite,
  PackEntry,
  PostEventInput,
  PostEventResult,
  PushSubscriptionInput,
  ServerEvent,
  ServerStats,
  TelegramSet,
  UserEntry,
} from './types.ts';

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface ExchangeInfo {
  readonly method: string;
  /** Path template, for example `/v1/chats/{chatId}/events` (no ids, no query). */
  readonly path: string;
  /** HTTP status, or 0 when there was no answer. */
  readonly status: number;
  readonly durationMs: number;
  /** ApiError code or NetworkError reason. */
  readonly error?: string;
  /** Number of events in an events page. */
  readonly events?: number;
}

export interface TransportOptions {
  /** Server address, for example `https://chat.example.org` (see normalizeServerUrl). */
  readonly baseUrl: string;
  readonly fetch?: FetchFn;
  readonly clock?: Clock;
  /** Timeout of ordinary requests, ms (default 20 s). Long polls get `wait` + this. */
  readonly timeoutMs?: number;
  readonly onExchange?: (info: ExchangeInfo) => void;
}

/** Timeout of the Telegram routes: the server answers within 40 s. */
export const TELEGRAM_TIMEOUT_MS = 45_000;

/** Longest `wait` the server accepts, seconds. */
export const MAX_WAIT_SECONDS = 30;

/**
 * Normalises a server address typed by a person: trims, adds `https://` when
 * no scheme is given, drops the trailing slash, query and fragment.
 * Throws TypeError for something that is not an http(s) URL.
 */
export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new TypeError('server address must be http(s)');
  if (u.username || u.password) throw new TypeError('server address must not contain credentials');
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

interface RequestSpec {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Concrete path (with ids). */
  readonly path: string;
  /** Path template for diagnostics. */
  readonly template: string;
  readonly token?: string;
  readonly json?: unknown;
  readonly bytes?: Uint8Array;
  readonly headers?: Record<string, string>;
  readonly query?: Record<string, number | undefined>;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
}

export class Transport {
  readonly baseUrl: string;
  readonly #fetch: FetchFn;
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  readonly #onExchange: ((info: ExchangeInfo) => void) | undefined;

  constructor(options: TransportOptions) {
    this.baseUrl = normalizeServerUrl(options.baseUrl);
    if (!options.fetch && typeof globalThis.fetch !== 'function') throw new TypeError('fetch is not available');
    // Late-bound so that a fetch patched after construction (service worker, tests) is used.
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#clock = options.clock ?? systemClock;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#onExchange = options.onExchange;
  }

  // ---- server ----

  async hello(signal?: AbortSignal): Promise<Hello> {
    const o = obj(await this.#json({ method: 'GET', path: '/v1/hello', template: '/v1/hello', signal }), 'hello');
    return {
      protocol: num(o, 'protocol'),
      server: str(o, 'server'),
      version: str(o, 'version'),
      commit: typeof o.commit === 'string' && /^[0-9a-f]{1,40}$/.test(o.commit) ? o.commit : null,
      serverId: str(o, 'serverId'),
      familyName: str(o, 'familyName'),
      retentionDays: num(o, 'retentionDays'),
      maxFileMb: num(o, 'maxFileMb'),
      push: bool(o, 'push'),
      vapidPublicKey: nullableStr(o, 'vapidPublicKey'),
      time: num(o, 'time'),
      maxEventBytes: num(o, 'maxEventBytes'),
      adminCodeActive: bool(o, 'adminCodeActive'),
      ...(typeof o.rootSetUp === 'boolean' ? { rootSetUp: o.rootSetUp } : {}),
      telegramStickers: o.telegramStickers === true,
      maxPartBytes: num(o, 'maxPartBytes'),
      maxBlobBytes: num(o, 'maxBlobBytes'),
      maxAvatarBytes: num(o, 'maxAvatarBytes'),
      maxStateBytes: num(o, 'maxStateBytes'),
      maxSealedKeyBytes: num(o, 'maxSealedKeyBytes'),
      maxGroupMembers: num(o, 'maxGroupMembers'),
    };
  }

  // ---- families ----

  /**
   * `POST /v1/families` at the root address with the server admin code: the
   * root family's setup code on a fresh server, otherwise a new family.
   */
  async createFamily(req: { adminCode: string; familyName?: string }, idempotencyKey: string, signal?: AbortSignal): Promise<CreatedFamily> {
    const o = obj(
      await this.#json({
        method: 'POST',
        path: '/v1/families',
        template: '/v1/families',
        json: req,
        headers: { 'Idempotency-Key': idempotencyKey },
        signal,
      }),
      'family',
    );
    const path = str(o, 'path');
    if (path !== '' && !/^\/f\/[a-z2-7]{16}$/.test(path)) throw unexpected('family path');
    return { familyId: nullableStr(o, 'familyId'), path, setupCode: str(o, 'setupCode') };
  }

  // ---- joining and devices ----

  async join(req: JoinRequest, signal?: AbortSignal): Promise<IssuedToken> {
    return issued(await this.#json({ method: 'POST', path: '/v1/join', template: '/v1/join', json: req, signal }));
  }

  async authChallenge(signal?: AbortSignal): Promise<Challenge> {
    const o = obj(
      await this.#json({ method: 'POST', path: '/v1/auth/challenge', template: '/v1/auth/challenge', signal }),
      'challenge',
    );
    return { nonce: str(o, 'nonce'), expiresAt: num(o, 'expiresAt') };
  }

  async authDevice(auth: SignedEnvelope, signal?: AbortSignal): Promise<IssuedToken> {
    return issued(
      await this.#json({
        method: 'POST',
        path: '/v1/auth/device',
        template: '/v1/auth/device',
        json: { payload: auth.payload, sig: auth.sig },
        signal,
      }),
    );
  }

  // ---- members and profile ----

  async users(token: string, signal?: AbortSignal): Promise<UserEntry[]> {
    const o = obj(await this.#json({ method: 'GET', path: '/v1/users', template: '/v1/users', token, signal }), 'users');
    return arr(o, 'users').map((u) => userEntry(u));
  }

  async me(token: string, signal?: AbortSignal): Promise<MeEntry> {
    const o = obj(await this.#json({ method: 'GET', path: '/v1/me', template: '/v1/me', token, signal }), 'me');
    return { ...userEntry(o), devId: str(o, 'devId'), push: bool(o, 'push') };
  }

  async putProfile(token: string, profile: SignedEnvelope, signal?: AbortSignal): Promise<SignedEnvelope> {
    const o = obj(
      await this.#json({
        method: 'PUT',
        path: '/v1/me/profile',
        template: '/v1/me/profile',
        token,
        json: { payload: profile.payload, sig: profile.sig },
        signal,
      }),
      'profile',
    );
    return envelope(o.profile, 'profile');
  }

  async putPush(token: string, sub: PushSubscriptionInput, signal?: AbortSignal): Promise<void> {
    const body: Record<string, unknown> = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
    if (sub.expirationTime !== undefined) body.expirationTime = sub.expirationTime;
    await this.#json({ method: 'PUT', path: '/v1/me/push', template: '/v1/me/push', token, json: body, signal });
  }

  async deletePush(token: string, signal?: AbortSignal): Promise<void> {
    await this.#json({ method: 'DELETE', path: '/v1/me/push', template: '/v1/me/push', token, signal });
  }

  // ---- chats and events ----

  async chats(token: string, signal?: AbortSignal): Promise<ChatEntry[]> {
    const o = obj(await this.#json({ method: 'GET', path: '/v1/chats', template: '/v1/chats', token, signal }), 'chats');
    return arr(o, 'chats').map((c) => {
      const x = obj(c, 'chat');
      return chatEntry(x);
    });
  }

  async postEvent(token: string, input: PostEventInput, signal?: AbortSignal): Promise<PostEventResult> {
    const o = obj(
      await this.#json({
        method: 'POST',
        path: `/v1/chats/${encodeURIComponent(input.chatId)}/events`,
        template: '/v1/chats/{chatId}/events',
        token,
        bytes: input.body,
        // `X-FC-Push: none`: an edit, a deletion or a reaction is not worth a notification.
        headers: { 'Idempotency-Key': input.msgId, 'X-FC-Epoch': String(input.epoch), ...(input.silent ? { 'X-FC-Push': 'none' } : {}) },
        signal,
      }),
      'post event',
    );
    return { gseq: num(o, 'gseq'), time: num(o, 'time'), duplicate: bool(o, 'duplicate') };
  }

  /** `DELETE /v1/chats/<id>/events/<gseq>`: delete for everyone; repeating it succeeds too. */
  async deleteEvent(token: string, chatId: string, gseq: number, signal?: AbortSignal): Promise<void> {
    await this.#json({
      method: 'DELETE',
      path: `/v1/chats/${encodeURIComponent(chatId)}/events/${gseq}`,
      template: '/v1/chats/{chatId}/events/{gseq}',
      token,
      signal,
    });
  }

  /** `GET /v1/events`: long poll when `wait` > 0. */
  async events(token: string, q: EventsQuery = {}, signal?: AbortSignal): Promise<EventsPage> {
    const wait = Math.min(Math.max(0, Math.floor(q.wait ?? 0)), MAX_WAIT_SECONDS);
    const data = await this.#json({
      method: 'GET',
      path: '/v1/events',
      template: '/v1/events',
      token,
      query: { after: q.after, limit: q.limit, wait: wait || undefined },
      signal,
      timeoutMs: this.#timeoutMs + wait * 1000,
    });
    return page(data);
  }

  /** `GET /v1/chats/<chatId>/events`: history backwards. */
  async chatEvents(token: string, chatId: string, q: HistoryQuery = {}, signal?: AbortSignal): Promise<EventsPage> {
    const data = await this.#json({
      method: 'GET',
      path: `/v1/chats/${encodeURIComponent(chatId)}/events`,
      template: '/v1/chats/{chatId}/events',
      token,
      query: { before: q.before, limit: q.limit },
      signal,
    });
    return page(data);
  }

  // ---- invitations, avatars, revocation ----

  /** `POST /v1/invites/check`: who invites and into which family, before joining. No token. */
  async inviteCheck(code: string, signal?: AbortSignal): Promise<InviteCheck> {
    const o = obj(
      await this.#json({ method: 'POST', path: '/v1/invites/check', template: '/v1/invites/check', json: { invite: code }, signal }),
      'invite check',
    );
    const status = str(o, 'status');
    if (status !== 'valid' && status !== 'used' && status !== 'expired') throw unexpected('invite status');
    const by = obj(o.createdBy, 'createdBy');
    return {
      status,
      familyName: str(o, 'familyName'),
      // Servers before it send no gender.
      createdBy: { userId: str(by, 'userId'), name: nullableStr(by, 'name'), gender: by.gender === 'f' ? 'f' : 'm' },
      createdAt: num(o, 'createdAt'),
      expiresAt: num(o, 'expiresAt'),
    };
  }

  /** `POST /v1/revoke`: revokes an identity by its own signature. No token. */
  async revoke(env: SignedEnvelope, signal?: AbortSignal): Promise<void> {
    await this.#json({
      method: 'POST',
      path: '/v1/revoke',
      template: '/v1/revoke',
      json: { payload: env.payload, sig: env.sig },
      signal,
    });
  }

  async putAvatar(token: string, image: Uint8Array, signal?: AbortSignal): Promise<AvatarUpload> {
    const o = obj(
      await this.#json({ method: 'PUT', path: '/v1/me/avatar', template: '/v1/me/avatar', token, bytes: image, signal }),
      'avatar',
    );
    const type = str(o, 'type');
    if (type !== 'image/jpeg' && type !== 'image/webp') throw unexpected('avatar type');
    return { sha256: str(o, 'sha256'), type };
  }

  async getAvatar(token: string, userId: string, sha256: string, signal?: AbortSignal): Promise<Uint8Array> {
    return this.#bytes({
      method: 'GET',
      path: `/v1/users/${encodeURIComponent(userId)}/avatar/${encodeURIComponent(sha256)}`,
      template: '/v1/users/{userId}/avatar/{sha256}',
      token,
      signal,
    });
  }

  // ---- groups ----

  async createGroup(token: string, req: CreateGroupRequest, signal?: AbortSignal): Promise<ChatEntry> {
    return chatEntry(
      obj(
        await this.#json({
          method: 'POST',
          path: '/v1/chats',
          template: '/v1/chats',
          token,
          json: { chatId: req.chatId, state: base64urlEncode(req.state), members: req.members, epoch: req.epoch, keys: req.keys },
          signal,
        }),
        'chat',
      ),
    );
  }

  async changeGroup(token: string, chatId: string, req: ChangeGroupRequest, signal?: AbortSignal): Promise<ChatEntry> {
    return chatEntry(
      obj(
        await this.#json({
          method: 'PUT',
          path: `/v1/chats/${encodeURIComponent(chatId)}/state`,
          template: '/v1/chats/{chatId}/state',
          token,
          json: {
            baseVersion: req.baseVersion,
            state: base64urlEncode(req.state),
            members: req.members,
            owner: req.owner,
            epoch: req.epoch,
            keys: req.keys,
          },
          signal,
        }),
        'chat',
      ),
    );
  }

  async groupState(token: string, chatId: string, version: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.#bytes({
      method: 'GET',
      path: `/v1/chats/${encodeURIComponent(chatId)}/state/${version}`,
      template: '/v1/chats/{chatId}/state/{version}',
      token,
      signal,
    });
  }

  async leaveGroup(token: string, chatId: string, signal?: AbortSignal): Promise<void> {
    await this.#json({
      method: 'POST',
      path: `/v1/chats/${encodeURIComponent(chatId)}/leave`,
      template: '/v1/chats/{chatId}/leave',
      token,
      signal,
    });
  }

  async keys(token: string, q: { after?: number; limit?: number } = {}, signal?: AbortSignal): Promise<KeysPage> {
    const o = obj(
      await this.#json({ method: 'GET', path: '/v1/keys', template: '/v1/keys', token, query: { after: q.after, limit: q.limit }, signal }),
      'keys',
    );
    return {
      keys: arr(o, 'keys').map((k) => {
        const x = obj(k, 'key');
        return {
          n: num(x, 'n'),
          chatId: str(x, 'chatId'),
          epoch: num(x, 'epoch'),
          version: num(x, 'version'),
          time: num(x, 'time'),
          key: str(x, 'key'),
        };
      }),
      cursor: num(o, 'cursor'),
      more: bool(o, 'more'),
    };
  }

  // ---- attachments ----

  async putBlobPart(token: string, blobId: string, part: number, bytes: Uint8Array, signal?: AbortSignal): Promise<BlobPartResult> {
    const o = obj(
      await this.#json({
        method: 'PUT',
        path: `/v1/blobs/${encodeURIComponent(blobId)}/${part}`,
        template: '/v1/blobs/{blobId}/{part}',
        token,
        bytes,
        signal,
        timeoutMs: this.#timeoutMs * 6,
      }),
      'blob part',
    );
    return { blobId: str(o, 'blobId'), part: num(o, 'part'), size: num(o, 'size'), total: num(o, 'total') };
  }

  async getBlobPart(token: string, blobId: string, part: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.#bytes({
      method: 'GET',
      path: `/v1/blobs/${encodeURIComponent(blobId)}/${part}`,
      template: '/v1/blobs/{blobId}/{part}',
      token,
      signal,
      timeoutMs: this.#timeoutMs * 6,
    });
  }

  async blobInfo(token: string, blobId: string, signal?: AbortSignal): Promise<BlobInfo> {
    const o = obj(
      await this.#json({ method: 'GET', path: `/v1/blobs/${encodeURIComponent(blobId)}`, template: '/v1/blobs/{blobId}', token, signal }),
      'blob',
    );
    return {
      blobId: str(o, 'blobId'),
      owner: str(o, 'owner'),
      createdAt: num(o, 'createdAt'),
      parts: arr(o, 'parts').map((p) => {
        const x = obj(p, 'part');
        return { part: num(x, 'part'), size: num(x, 'size') };
      }),
      total: num(o, 'total'),
      maxBytes: num(o, 'maxBytes'),
    };
  }

  async deleteBlob(token: string, blobId: string, signal?: AbortSignal): Promise<void> {
    await this.#json({ method: 'DELETE', path: `/v1/blobs/${encodeURIComponent(blobId)}`, template: '/v1/blobs/{blobId}', token, signal });
  }

  // ---- sticker packs ----

  /** `GET /v1/packs`: published packs of the family (manifests not verified here). */
  async packs(token: string, signal?: AbortSignal): Promise<PackEntry[]> {
    const o = obj(await this.#json({ method: 'GET', path: '/v1/packs', template: '/v1/packs', token, signal }), 'packs');
    return arr(o, 'packs').map((p) => {
      const x = obj(p, 'pack');
      return {
        packId: str(x, 'packId'),
        owner: str(x, 'owner'),
        manifest: envelope(x.manifest, 'manifest'),
        publishedAt: nullableNum(x, 'publishedAt'),
        bytes: num(x, 'bytes'),
      };
    });
  }

  /** `PUT /v1/packs/<packId>/files/<hash>`: one file of a draft. */
  async putPackFile(token: string, packId: string, hash: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.#json({
      method: 'PUT',
      path: `/v1/packs/${encodeURIComponent(packId)}/files/${encodeURIComponent(hash)}`,
      template: '/v1/packs/{packId}/files/{hash}',
      token,
      bytes,
      signal,
    });
  }

  /** `PUT /v1/packs/<packId>`: publishes the draft with its signed manifest. */
  async publishPack(token: string, packId: string, manifest: SignedEnvelope, signal?: AbortSignal): Promise<void> {
    await this.#json({
      method: 'PUT',
      path: `/v1/packs/${encodeURIComponent(packId)}`,
      template: '/v1/packs/{packId}',
      token,
      json: { payload: manifest.payload, sig: manifest.sig },
      signal,
    });
  }

  async packFile(token: string, packId: string, hash: string, signal?: AbortSignal): Promise<Uint8Array> {
    return this.#bytes({
      method: 'GET',
      path: `/v1/packs/${encodeURIComponent(packId)}/files/${encodeURIComponent(hash)}`,
      template: '/v1/packs/{packId}/files/{hash}',
      token,
      signal,
    });
  }

  async deletePack(token: string, packId: string, signal?: AbortSignal): Promise<void> {
    await this.#json({ method: 'DELETE', path: `/v1/packs/${encodeURIComponent(packId)}`, template: '/v1/packs/{packId}', token, signal });
  }

  // ---- administration ----

  async createInvite(token: string, signal?: AbortSignal): Promise<NewInvite> {
    const o = obj(
      await this.#json({ method: 'POST', path: '/v1/admin/invites', template: '/v1/admin/invites', token, signal }),
      'invite',
    );
    return { id: str(o, 'id'), code: str(o, 'code'), createdAt: num(o, 'createdAt'), expiresAt: num(o, 'expiresAt') };
  }

  async listInvites(token: string, signal?: AbortSignal): Promise<InviteInfo[]> {
    const o = obj(
      await this.#json({ method: 'GET', path: '/v1/admin/invites', template: '/v1/admin/invites', token, signal }),
      'invites',
    );
    return arr(o, 'invites').map((i) => {
      const x = obj(i, 'invite');
      return {
        id: str(x, 'id'),
        createdAt: num(x, 'createdAt'),
        expiresAt: num(x, 'expiresAt'),
        createdBy: str(x, 'createdBy'),
        usedAt: nullableNum(x, 'usedAt'),
        usedBy: nullableStr(x, 'usedBy'),
      };
    });
  }

  async revokeInvite(token: string, id: string, signal?: AbortSignal): Promise<void> {
    await this.#json({
      method: 'DELETE',
      path: `/v1/admin/invites/${encodeURIComponent(id)}`,
      template: '/v1/admin/invites/{id}',
      token,
      signal,
    });
  }

  async adminUsers(token: string, signal?: AbortSignal): Promise<AdminUser[]> {
    const o = obj(
      await this.#json({ method: 'GET', path: '/v1/admin/users', template: '/v1/admin/users', token, signal }),
      'admin users',
    );
    return arr(o, 'users').map((u) => {
      const x = obj(u, 'admin user');
      return {
        userId: str(x, 'userId'),
        name: nullableStr(x, 'name'),
        admin: bool(x, 'admin'),
        removed: bool(x, 'removed'),
        removedAt: nullableNum(x, 'removedAt'),
        revoked: x.revoked === true,
        revokedAt: nullableNum(x, 'revokedAt'),
        devices: arr(x, 'devices').map((d) => {
          const y = obj(d, 'device');
          return { devId: str(y, 'devId'), createdAt: num(y, 'createdAt'), push: bool(y, 'push') };
        }),
      };
    });
  }

  async removeUser(token: string, userId: string, signal?: AbortSignal): Promise<void> {
    await this.#json({
      method: 'DELETE',
      path: `/v1/admin/users/${encodeURIComponent(userId)}`,
      template: '/v1/admin/users/{userId}',
      token,
      signal,
    });
  }

  async stats(token: string, signal?: AbortSignal): Promise<ServerStats> {
    const o = obj(
      await this.#json({ method: 'GET', path: '/v1/admin/stats', template: '/v1/admin/stats', token, signal }),
      'stats',
    );
    return {
      version: str(o, 'version'),
      dataBytes: num(o, 'dataBytes'),
      freeBytes: nullableNum(o, 'freeBytes'),
      totalBytes: nullableNum(o, 'totalBytes'),
      events: num(o, 'events'),
      oldestGseq: num(o, 'oldestGseq'),
      lastGseq: num(o, 'lastGseq'),
      users: num(o, 'users'),
      removedUsers: num(o, 'removedUsers'),
      chats: num(o, 'chats'),
      groups: num(o, 'groups'),
      retentionDays: num(o, 'retentionDays'),
      push: bool(o, 'push'),
      telegram: telegramState(o.telegram),
    };
  }

  // ---- server checks ----

  /**
   * Long request: the server answers after `seconds`. The timeout is the
   * duration plus 10 s, so a healthy server never looks like a cut proxy.
   */
  async checkWait(token: string, seconds: number, signal?: AbortSignal): Promise<CheckWaitResult> {
    const o = obj(
      await this.#json({
        method: 'GET',
        path: '/v1/check/wait',
        template: '/v1/check/wait',
        token,
        query: { seconds },
        signal,
        timeoutMs: seconds * 1000 + 10_000,
      }),
      'check wait',
    );
    return { seconds: num(o, 'seconds'), startedAt: num(o, 'startedAt'), finishedAt: num(o, 'finishedAt') };
  }

  /** Test notification to this device's stored subscription, now or after `delaySeconds`. */
  async checkPush(token: string, delaySeconds: number, signal?: AbortSignal): Promise<CheckPushResult> {
    const o = obj(
      await this.#json({
        method: 'POST',
        path: '/v1/check/push',
        template: '/v1/check/push',
        token,
        json: { delaySeconds, from: 'app' },
        signal,
        timeoutMs: this.#timeoutMs * 2,
      }),
      'check push',
    );
    return { sent: o.sent === true, scheduled: o.scheduled === true, sendAt: typeof o.sendAt === 'number' ? o.sendAt : null };
  }

  /** The last test notification of this device, or null. */
  async checkLastPush(token: string, signal?: AbortSignal): Promise<CheckLastPush | null> {
    const o = obj(
      await this.#json({ method: 'GET', path: '/v1/check/push', template: '/v1/check/push', token, signal }),
      'check last push',
    );
    if (!isObject(o.last)) return null;
    return { at: num(o.last, 'at'), result: str(o.last, 'result') };
  }

  // ---- Telegram sticker sets ----

  /** The list of a Telegram sticker set (the server asks Telegram; 45 s timeout). */
  async telegramSet(token: string, name: string, signal?: AbortSignal): Promise<TelegramSet> {
    const o = obj(
      await this.#json({
        method: 'GET',
        path: `/v1/telegram/sets/${encodeURIComponent(name)}`,
        template: '/v1/telegram/sets/{name}',
        token,
        signal,
        timeoutMs: TELEGRAM_TIMEOUT_MS,
      }),
      'telegram set',
    );
    const skipped = isObject(o.skipped) ? o.skipped : {};
    return {
      name: str(o, 'name'),
      title: str(o, 'title'),
      stickers: arr(o, 'stickers').map((v) => {
        const s = obj(v, 'telegram sticker');
        const type = s.type === 'tgs' ? 'tgs' : s.type === 'webp' ? 'webp' : null;
        if (!type) throw unexpected('telegram sticker');
        return { id: str(s, 'id'), emoji: nullableStr(s, 'emoji'), type };
      }),
      skipped: {
        video: typeof skipped.video === 'number' ? skipped.video : 0,
        other: typeof skipped.other === 'number' ? skipped.other : 0,
      },
    };
  }

  /** One file of a Telegram sticker set, by its id from the list. */
  async telegramFile(token: string, name: string, id: string, signal?: AbortSignal): Promise<Uint8Array> {
    return this.#bytes({
      method: 'GET',
      path: `/v1/telegram/sets/${encodeURIComponent(name)}/files/${encodeURIComponent(id)}`,
      template: '/v1/telegram/sets/{name}/files/{id}',
      token,
      signal,
      timeoutMs: TELEGRAM_TIMEOUT_MS,
    });
  }

  // ---- plumbing ----

  /** Performs a request; returns parsed JSON (or undefined for an empty 2xx body). */
  async #json(spec: RequestSpec): Promise<unknown> {
    return (await this.#exchange(spec, false)) as unknown;
  }

  /** Performs a request whose successful answer is raw bytes (errors are still JSON). */
  async #bytes(spec: RequestSpec): Promise<Uint8Array> {
    return (await this.#exchange(spec, true)) as Uint8Array;
  }

  async #exchange(spec: RequestSpec, raw: boolean): Promise<unknown> {
    const where = `${spec.method} ${spec.template}`;
    const started = this.#clock.now();
    const report = (status: number, error?: string, events?: number) => {
      if (!this.#onExchange) return;
      const info: { -readonly [K in keyof ExchangeInfo]: ExchangeInfo[K] } = {
        method: spec.method,
        path: spec.template,
        status,
        durationMs: Math.max(0, this.#clock.now() - started),
      };
      if (error !== undefined) info.error = error;
      if (events !== undefined) info.events = events;
      try {
        this.#onExchange(info);
      } catch {
        // Diagnostics must never break a request.
      }
    };

    let url = this.baseUrl + spec.path;
    if (spec.query) {
      const qs = Object.entries(spec.query)
        .filter((e): e is [string, number] => e[1] !== undefined)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('&');
      if (qs) url += `?${qs}`;
    }
    const headers: Record<string, string> = { Accept: raw ? '*/*' : 'application/json', ...spec.headers };
    if (spec.token !== undefined) headers.Authorization = `Bearer ${spec.token}`;
    let body: BodyInit | undefined;
    if (spec.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(spec.json);
    } else if (spec.bytes !== undefined) {
      headers['Content-Type'] = 'application/octet-stream';
      body = spec.bytes as Uint8Array<ArrayBuffer>;
    }

    const ctl = new AbortController();
    let timedOut = false;
    const timer = this.#clock.setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, spec.timeoutMs ?? this.#timeoutMs);
    const onAbort = () => ctl.abort();
    if (spec.signal?.aborted) ctl.abort();
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    const failReason = () => (timedOut ? 'timeout' : spec.signal?.aborted ? 'aborted' : 'offline');

    try {
      let res: Response;
      try {
        // Aborted before it started (a cancel between two parts): no request at all.
        if (ctl.signal.aborted) throw new DOMException('aborted', 'AbortError');
        res = await this.#fetch(url, {
          method: spec.method,
          headers,
          body,
          credentials: 'omit',
          cache: 'no-store',
          signal: ctl.signal,
        });
      } catch {
        const reason = failReason();
        report(0, reason);
        throw new NetworkError(reason, where);
      }

      const isJson = (res.headers.get('content-type') ?? '').toLowerCase().includes('application/json');
      if (raw && res.ok) {
        if (isJson) {
          report(res.status, 'unexpected_response');
          throw new ApiError(res.status, 'unexpected_response', where);
        }
        let buf: ArrayBuffer;
        try {
          buf = await res.arrayBuffer();
        } catch {
          const reason = failReason();
          report(res.status, reason);
          throw new NetworkError(reason, where);
        }
        report(res.status);
        return new Uint8Array(buf);
      }

      let text: string;
      try {
        text = await res.text();
      } catch {
        const reason = failReason();
        report(res.status, reason);
        throw new NetworkError(reason, where);
      }

      let data: unknown;
      if (text.length > 0) {
        if (!isJson) {
          report(res.status, 'unexpected_response');
          throw new ApiError(res.status, 'unexpected_response', where);
        }
        try {
          data = JSON.parse(text);
        } catch {
          report(res.status, 'unexpected_response');
          throw new ApiError(res.status, 'unexpected_response', where);
        }
      }

      if (!res.ok) {
        const o = isObject(data) ? data : {};
        const code = isServerErrorCode(o.error) ? o.error : 'unexpected_response';
        const details: Record<string, number> = {};
        for (const k of ['epoch', 'limit', 'rev', 'version']) {
          const v = o[k];
          if (typeof v === 'number' && Number.isFinite(v)) details[k] = v;
        }
        const ra = Number(res.headers.get('retry-after'));
        const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined;
        const reason = typeof o.reason === 'string' && /^[a-z_]{1,32}$/.test(o.reason) ? o.reason : undefined;
        report(res.status, code);
        throw new ApiError(res.status, code, where, { retryAfterMs, details, reason });
      }

      const events = isObject(data) && Array.isArray(data.events) ? data.events.length : undefined;
      report(res.status, undefined, events);
      return data;
    } finally {
      this.#clock.clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
    }
  }
}

// ---- response validation (shape only) ----

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unexpected(what: string): ApiError {
  return new ApiError(200, 'unexpected_response', what);
}

function obj(v: unknown, what: string): Obj {
  if (!isObject(v)) throw unexpected(what);
  return v;
}

function num(o: Obj, k: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw unexpected(k);
  return v;
}

function nullableNum(o: Obj, k: string): number | null {
  return o[k] === null || o[k] === undefined ? null : num(o, k);
}

function str(o: Obj, k: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw unexpected(k);
  return v;
}

function nullableStr(o: Obj, k: string): string | null {
  return o[k] === null || o[k] === undefined ? null : str(o, k);
}

function bool(o: Obj, k: string): boolean {
  const v = o[k];
  if (typeof v !== 'boolean') throw unexpected(k);
  return v;
}

function arr(o: Obj, k: string): unknown[] {
  const v = o[k];
  if (!Array.isArray(v)) throw unexpected(k);
  return v;
}

function envelope(v: unknown, what: string): SignedEnvelope {
  const o = obj(v, what);
  return { payload: str(o, 'payload'), sig: str(o, 'sig') };
}

function telegramState(v: unknown): ServerStats['telegram'] {
  if (!isObject(v)) return null;
  const status = v.status === 'ok' || v.status === 'token_rejected' || v.status === 'unavailable' ? v.status : 'unknown';
  return { status, bot: typeof v.bot === 'string' && v.bot ? v.bot : null };
}

function issued(v: unknown): IssuedToken {
  const o = obj(v, 'token');
  return { token: str(o, 'token'), userId: str(o, 'userId'), devId: str(o, 'devId'), admin: bool(o, 'admin') };
}

function userEntry(v: unknown): UserEntry {
  const o = obj(v, 'user');
  return {
    userId: str(o, 'userId'),
    identity: envelope(o.identity, 'identity'),
    profile: o.profile === null || o.profile === undefined ? null : envelope(o.profile, 'profile'),
    admin: bool(o, 'admin'),
    removed: bool(o, 'removed'),
    revoked: o.revoked === null || o.revoked === undefined ? null : envelope(o.revoked, 'revoked'),
  };
}

function strList(o: Obj, k: string): string[] {
  return arr(o, k).map((m) => {
    if (typeof m !== 'string') throw unexpected(k);
    return m;
  });
}

function chatEntry(x: Obj): ChatEntry {
  const kind = str(x, 'kind');
  if (kind !== 'dm' && kind !== 'group') throw unexpected('chat kind');
  return {
    chatId: str(x, 'chatId'),
    kind,
    members: strList(x, 'members'),
    owner: nullableStr(x, 'owner'),
    version: nullableNum(x, 'version'),
    epoch: num(x, 'epoch'),
    createdAt: num(x, 'createdAt'),
    lastGseq: nullableNum(x, 'lastGseq'),
    lastTime: nullableNum(x, 'lastTime'),
  };
}

/** Parses a notice body of a known type; undefined for unknown or malformed ones (skipped). */
function noticeBody(v: unknown): NoticeBody | undefined {
  if (!isObject(v)) return undefined;
  try {
    switch (v.type) {
      case 'group_created':
        return {
          type: 'group_created',
          by: str(v, 'by'),
          owner: str(v, 'owner'),
          members: strList(v, 'members'),
          version: num(v, 'version'),
          epoch: num(v, 'epoch'),
        };
      case 'group_state':
        return {
          type: 'group_state',
          by: str(v, 'by'),
          owner: str(v, 'owner'),
          members: strList(v, 'members'),
          version: num(v, 'version'),
          epoch: num(v, 'epoch'),
          added: strList(v, 'added'),
          removed: strList(v, 'removed'),
        };
      case 'member_left':
        return {
          type: 'member_left',
          userId: str(v, 'userId'),
          members: strList(v, 'members'),
          version: num(v, 'version'),
          epoch: num(v, 'epoch'),
        };
      case 'member_removed':
      case 'member_revoked':
        return { type: v.type, userId: str(v, 'userId') };
      case 'event_deleted':
        return { type: 'event_deleted', gseq: num(v, 'gseq'), senderId: str(v, 'senderId'), msgId: str(v, 'msgId'), by: str(v, 'by') };
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function serverEvent(v: unknown): ServerEvent {
  const o = obj(v, 'event');
  const deleted = o.deleted === true;
  let body: Uint8Array;
  try {
    body = deleted ? new Uint8Array(0) : base64urlDecode(str(o, 'body'));
  } catch {
    throw unexpected('event body');
  }
  return {
    gseq: num(o, 'gseq'),
    time: num(o, 'time'),
    chatId: str(o, 'chatId'),
    senderId: str(o, 'senderId'),
    devId: str(o, 'devId'),
    epoch: num(o, 'epoch'),
    msgId: str(o, 'msgId'),
    body,
    ...(deleted ? { deleted: true as const } : {}),
  };
}

function page(v: unknown): EventsPage {
  const o = obj(v, 'events page');
  const events: ServerEvent[] = [];
  const notices: ServerNotice[] = [];
  for (const item of arr(o, 'events')) {
    const x = obj(item, 'event');
    const kind = x.kind;
    if (kind === 'event') events.push(serverEvent(x));
    else if (kind === 'notice') {
      const notice = noticeBody(x.notice);
      if (notice) notices.push({ gseq: num(x, 'gseq'), time: num(x, 'time'), chatId: str(x, 'chatId'), notice });
    }
    // Unknown kinds are skipped (docs/API.md 5.4).
  }
  return {
    events,
    notices,
    cursor: num(o, 'cursor'),
    more: bool(o, 'more'),
    oldestGseq: num(o, 'oldestGseq'),
    oldestTime: nullableNum(o, 'oldestTime'),
  };
}
