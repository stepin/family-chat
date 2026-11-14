// Session of one account: supplies the device token, logs in again by
// signature on 401 (docs/API.md 3.3), retries once on `bad_nonce`, and
// switches to the "removed" state on 403 `removed`.
//
// Re-login is serialised across tabs with a lock and skipped when another
// context already replaced the token, so two tabs never knock each other's
// token out in a loop.

import { createAuthEnvelope, type IdentityKeys } from '@family-chat/protocol';
import { ApiError, isApiError, isTransient } from './api/errors.ts';
import type { Transport } from './api/transport.ts';
import type { IssuedToken } from './api/types.ts';
import type { CoreContext } from './context.ts';
import { describeError } from './db/diagnostics.ts';
import type { AccountRow, AccountStatus } from './db/schema.ts';
import { CoreError } from './errors.ts';
import { writable, type Readable, type Writable } from './util/readable.ts';

/**
 * `auth/challenge` + `auth/device` for this identity and device id. Retries
 * once with a fresh challenge on 401 `bad_nonce` (the nonce may expire or be
 * evicted between the two requests). Errors propagate as ApiError / NetworkError.
 */
export async function authenticateDevice(
  transport: Transport,
  keys: IdentityKeys,
  serverId: string,
  devId: string,
): Promise<IssuedToken> {
  for (let attempt = 0; ; attempt++) {
    const ch = await transport.authChallenge();
    const env = createAuthEnvelope(keys, { serverId, nonce: ch.nonce, devId });
    try {
      const issued = await transport.authDevice(env);
      if (issued.userId !== keys.userId || issued.devId !== devId) {
        throw new ApiError(200, 'unexpected_response', 'POST /v1/auth/device');
      }
      return issued;
    } catch (e) {
      if (isApiError(e, 'bad_nonce') && attempt === 0) continue;
      throw e;
    }
  }
}

export class Session {
  readonly accountId: string;
  readonly serverUrl: string;
  readonly serverId: string;
  readonly userId: string;
  readonly devId: string;
  readonly transport: Transport;
  readonly #status: Writable<AccountStatus>;
  #relogin: Promise<string> | undefined;

  constructor(
    private readonly ctx: CoreContext,
    account: AccountRow,
  ) {
    this.accountId = account.id;
    this.serverUrl = account.serverUrl;
    this.serverId = account.serverId;
    this.userId = account.userId;
    this.devId = account.devId;
    this.transport = ctx.transport(account.serverUrl, account.id);
    this.#status = writable(account.status);
  }

  get status(): Readable<AccountStatus> {
    return this.#status;
  }

  /**
   * Runs an authenticated request. On 401 logs in again and repeats it once.
   * Throws CoreError `removed` / `login-invalid` when the account is in that state.
   */
  async call<T>(fn: (token: string) => Promise<T>): Promise<T> {
    this.#ensureUsable();
    const token = await this.#token();
    try {
      return await fn(token);
    } catch (e) {
      if (isApiError(e, 'removed')) throw await this.#markRemoved();
      if (!isApiError(e, 'unauthorized')) throw e;
    }
    const fresh = await this.#reloginShared(token);
    try {
      return await fn(fresh);
    } catch (e) {
      if (isApiError(e, 'removed')) throw await this.#markRemoved();
      throw e;
    }
  }

  /**
   * Log in again now (the "log in again" button after "login invalid"). Clears
   * the login-invalid state first; a removed account stays removed.
   */
  async relogin(): Promise<void> {
    if (this.#status.get() === 'removed') throw new CoreError('removed');
    if (this.#status.get() === 'login-invalid') await this.#setStatus('active');
    const token = await this.#token();
    await this.#reloginShared(token, true);
  }

  #ensureUsable(): void {
    const s = this.#status.get();
    if (s === 'removed') throw new CoreError('removed');
    if (s === 'login-invalid') throw new CoreError('login-invalid');
  }

  async #token(): Promise<string> {
    const row = await this.ctx.db.accounts.get(this.accountId);
    if (!row) throw new CoreError('no-account');
    if (row.status !== this.#status.get()) this.#status.set(row.status);
    this.#ensureUsable();
    return row.token;
  }

  #reloginShared(failedToken: string, force = false): Promise<string> {
    if (!this.#relogin) {
      this.#relogin = this.ctx.locks
        .request(`fc-auth-${this.accountId}`, async () => {
          const row = await this.ctx.db.accounts.get(this.accountId);
          if (!row) throw new CoreError('no-account');
          // Another tab or worker already logged in again: use its token.
          if (!force && row.token !== failedToken && row.status === 'active') return row.token;
          return this.#login();
        })
        .finally(() => {
          this.#relogin = undefined;
        });
    }
    return this.#relogin;
  }

  async #login(): Promise<string> {
    const keys = await this.ctx.keys(this.userId);
    try {
      const issued = await authenticateDevice(this.transport, keys, this.serverId, this.devId);
      await this.ctx.db.accounts.update(this.accountId, { token: issued.token, admin: issued.admin, status: 'active' });
      this.#status.set('active');
      void this.ctx.diag.info('auth', 'logged in again by signature', this.accountId);
      return issued.token;
    } catch (e) {
      if (isApiError(e, 'removed')) throw await this.#markRemoved();
      if (isTransient(e) || !(e instanceof ApiError)) throw e;
      void this.ctx.diag.error('auth', `re-login failed: ${describeError(e)}`, this.accountId);
      await this.#setStatus('login-invalid');
      throw new CoreError('login-invalid', `re-login failed: ${e.code}`);
    }
  }

  async #markRemoved(): Promise<CoreError> {
    if (this.#status.get() !== 'removed') {
      void this.ctx.diag.warn('auth', 'removed from the family (403 removed)', this.accountId);
    }
    await this.#setStatus('removed');
    return new CoreError('removed');
  }

  async #setStatus(status: AccountStatus): Promise<void> {
    this.#status.set(status);
    await this.ctx.db.accounts.update(this.accountId, { status });
  }
}
