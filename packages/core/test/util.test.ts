import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { Dexie } from 'dexie';
import { ApiError, NetworkError } from '../src/api/errors.ts';
import { describeError, Diagnostics, MAX_DIAGNOSTICS, scrub } from '../src/db/diagnostics.ts';
import { CoreDb, DbVersionError, openDb } from '../src/db/schema.ts';
import { CoreError, isCoreError } from '../src/errors.ts';
import { inviteLink, parseInviteFragment } from '../src/invite.ts';
import { ProtocolError } from '@family-chat/protocol';
import { backoffDelay, DEFAULT_BACKOFF } from '../src/util/backoff.ts';
import { sleep, systemClock, Waker } from '../src/util/clock.ts';
import { LeaseLocks, webLocks } from '../src/util/locks.ts';
import { readonly, until, writable } from '../src/util/readable.ts';
import { memDb } from './support/helpers.ts';

describe('readable', () => {
  it('notifies subscribers and starts lazily', () => {
    let started = 0;
    let stopped = 0;
    const s = writable(1, () => {
      started++;
      return () => stopped++;
    });
    const seen: number[] = [];
    const u1 = s.subscribe((v) => seen.push(v));
    const u2 = s.subscribe(() => {});
    expect(started).toBe(1);
    s.set(2);
    s.update((v) => v + 1);
    expect(seen).toEqual([1, 2, 3]);
    expect(s.get()).toBe(3);
    u1();
    u1(); // twice is harmless
    expect(stopped).toBe(0);
    u2();
    expect(stopped).toBe(1);
    const r = readonly(s);
    expect(r.get()).toBe(3);
    const got: number[] = [];
    r.subscribe((v) => got.push(v))();
    expect(got).toEqual([3]);
  });

  it('start may set a value', () => {
    const s = writable(0, (set) => set(5));
    const seen: number[] = [];
    s.subscribe((v) => seen.push(v));
    expect(seen).toEqual([5]);
  });

  it('until resolves on the first matching value', async () => {
    const s = writable(0);
    const p = until(s, (v) => v > 1);
    s.set(1);
    s.set(2);
    expect(await p).toBe(2);
    expect(await until(s, (v) => v === 2)).toBe(2);
  });
});

describe('clock and backoff', () => {
  it('backoff grows, caps and jitters', () => {
    const o = { baseMs: 100, maxMs: 1000 };
    expect(backoffDelay(1, o, () => 0.5)).toBe(100);
    expect(backoffDelay(2, o, () => 0.5)).toBe(200);
    expect(backoffDelay(10, o, () => 0.5)).toBe(1000);
    expect(backoffDelay(1, o, () => 0)).toBe(50);
    expect(backoffDelay(1, o, () => 0.999)).toBe(150);
    expect(backoffDelay(0, o, () => 0.5)).toBe(100);
    expect(backoffDelay(500, DEFAULT_BACKOFF, () => 0.5)).toBe(60_000);
  });

  it('sleep resolves after the delay or on abort', async () => {
    const t = Date.now();
    await sleep(systemClock, 20);
    expect(Date.now() - t).toBeGreaterThanOrEqual(15);
    const ctl = new AbortController();
    const p = sleep(systemClock, 10_000, ctl.signal);
    ctl.abort();
    await p;
    await sleep(systemClock, 10_000, ctl.signal); // already aborted
  });

  it('waker: kick wakes a waiter, early kicks are remembered', async () => {
    const w = new Waker(systemClock);
    const t = Date.now();
    const p = w.wait(10_000);
    w.kick();
    await p;
    w.kick();
    await w.wait(10_000);
    await w.wait(5);
    const inf = w.wait(Infinity);
    w.kick();
    await inf;
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe('locks', () => {
  it('web locks are used when present', async () => {
    const l = webLocks();
    expect(l).toBeDefined();
    const order: string[] = [];
    await Promise.all([
      l!.request('x', async () => {
        order.push('a1');
        await sleep(systemClock, 20);
        order.push('a2');
      }),
      l!.request('x', async () => {
        order.push('b');
      }),
    ]);
    expect(order).toEqual(['a1', 'a2', 'b']);
  });

  it('lease fallback excludes another context and survives a crashed holder', async () => {
    const factory = new IDBFactory();
    const db1 = new CoreDb('lease', { indexedDB: factory, IDBKeyRange });
    const db2 = new CoreDb('lease', { indexedDB: factory, IDBKeyRange });
    const l1 = new LeaseLocks(db1, systemClock, { ttlMs: 60, pollMs: 5, owner: 'one' });
    const l2 = new LeaseLocks(db2, systemClock, { ttlMs: 60, pollMs: 5, owner: 'two' });
    const order: string[] = [];
    await Promise.all([
      l1.request('q', async () => {
        order.push('1-in');
        await sleep(systemClock, 80); // longer than the ttl: renewal keeps it
        order.push('1-out');
      }),
      (async () => {
        await sleep(systemClock, 5);
        await l2.request('q', async () => {
          order.push('2');
        });
      })(),
    ]);
    expect(order).toEqual(['1-in', '1-out', '2']);
    expect(await db1.leases.count()).toBe(0);

    // In-process queue: same context, same name, strictly one after another.
    const seq: number[] = [];
    await Promise.all([1, 2, 3].map((i) => l1.request('r', async () => void seq.push(i))));
    expect(seq).toEqual([1, 2, 3]);
    // A failing holder releases the lock.
    await expect(l1.request('r', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await l1.request('r', async () => 7)).toBe(7);

    // A stale lease from a crashed context expires.
    await db1.leases.put({ name: 's', owner: 'dead', expiresAt: Date.now() + 30 });
    const t = Date.now();
    await l2.request('s', async () => {});
    expect(Date.now() - t).toBeGreaterThanOrEqual(20);
    db1.close();
    db2.close();
  });
});

describe('diagnostics', () => {
  it('scrubs token-like strings and keeps ids', () => {
    const token = 'Ab3_' + 'x'.repeat(39);
    expect(scrub(`token ${token} chat lo2a5ewrojycetbvska5utmpxe`)).toBe('token [redacted] chat lo2a5ewrojycetbvska5utmpxe');
    expect(scrub('y'.repeat(1000)).length).toBeLessThanOrEqual(300);
  });

  it('describes errors without payloads', () => {
    expect(describeError(new ApiError(403, 'removed', 'x'))).toBe('403 removed');
    expect(describeError(new NetworkError('timeout', 'x'))).toBe('network timeout');
    expect(describeError(new ProtocolError('bad-signature', 'm'))).toBe('protocol bad-signature');
    expect(describeError(new CoreError('no-account'))).toBe('CoreError no-account');
    expect(describeError(new TypeError('boom'))).toBe('TypeError: boom');
    expect(describeError('str')).toBe('unknown error');
  });

  it('keeps the last 500 entries and writes a report', async () => {
    const db = memDb();
    const d = new Diagnostics(db, systemClock);
    for (let i = 0; i < MAX_DIAGNOSTICS + 20; i++) void d.info('test', `entry ${i}`, i % 2 ? 'acc' : null);
    await d.warn('test', 'last');
    await d.error('test', 'really last');
    expect(await db.diagnostics.count()).toBe(MAX_DIAGNOSTICS);
    const rows = await db.diagnostics.orderBy('id').toArray();
    expect(rows[rows.length - 1]!.message).toBe('really last');
    expect(rows[0]!.message).toBe('entry 22');
    const report = await d.report();
    expect(report.split('\n')).toHaveLength(MAX_DIAGNOSTICS);
    expect(report).toContain('error test really last');
    expect(report).toContain('[acc]');
    await d.clear();
    expect(await db.diagnostics.count()).toBe(0);
    db.close();
    // Writes after close do not throw.
    await d.info('test', 'after close');
  });
});

describe('database', () => {
  it('opens, and refuses a database created by a newer client', async () => {
    const factory = new IDBFactory();
    const db = await openDb(new CoreDb('v', { indexedDB: factory, IDBKeyRange }));
    expect(db.tables.map((t) => t.name).sort()).toContain('outbox');
    db.close();
    const newer = new Dexie('v', { indexedDB: factory, IDBKeyRange });
    newer.version(5).stores({ extra: 'id' });
    await newer.open();
    newer.close();
    await expect(openDb(new CoreDb('v', { indexedDB: factory, IDBKeyRange }))).rejects.toBeInstanceOf(DbVersionError);
  });

  it('other open errors propagate', async () => {
    const db = new CoreDb('broken', { indexedDB: {} as IDBFactory, IDBKeyRange });
    await expect(openDb(db)).rejects.toBeDefined();
  });
});

describe('invite links and core errors', () => {
  it('builds and parses links', () => {
    const code = 'abcdefghijklmnopqrstuvwxyz';
    expect(inviteLink('https://x.org/', code)).toBe(`https://x.org/#invite=${code}`);
    expect(parseInviteFragment(`#invite=${code}`)).toBe(code);
    expect(parseInviteFragment(`a=1&invite=${code.toUpperCase()}`)).toBe(code);
    expect(parseInviteFragment('#invite=short')).toBeUndefined();
    expect(parseInviteFragment('#other=1')).toBeUndefined();
  });

  it('isCoreError', () => {
    expect(isCoreError(new CoreError('removed'), 'removed')).toBe(true);
    expect(isCoreError(new CoreError('removed'), 'closed')).toBe(false);
    expect(isCoreError(new Error('x'))).toBe(false);
    expect(new CoreError('closed').message).toBe('closed');
  });
});
