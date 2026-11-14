import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createCore, type CoreOptions, type FamilyChatCore } from '../../src/core.ts';
import { CoreContext } from '../../src/context.ts';
import { CoreDb } from '../../src/db/schema.ts';
import type { FakeServer } from './fake-server.ts';

let n = 0;

/** A fresh, isolated IndexedDB (fake-indexeddb). */
export function memDb(name = `t${++n}`, factory: IDBFactory = new IDBFactory()): CoreDb {
  return new CoreDb(name, { indexedDB: factory, IDBKeyRange });
}

export const FAST = {
  backoff: { baseMs: 5, maxMs: 40 },
  random: () => 0.5,
  waitSeconds: 25,
} as const;

export function makeCore(server: FakeServer, options: Partial<CoreOptions> = {}): FamilyChatCore {
  return createCore({ db: memDb(), fetch: server.fetch, ...FAST, ...options });
}

export function makeCtx(server: FakeServer, db: CoreDb = memDb()): CoreContext {
  return new CoreContext({ db, fetch: server.fetch, ...FAST });
}

/** Polls `fn` until it returns a truthy value (or throws after `timeoutMs`). */
export async function eventually<T>(fn: () => T | Promise<T>, timeoutMs = 4000, what = 'condition'): Promise<NonNullable<T>> {
  const start = Date.now();
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      last = e;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Admin joins with the admin code, creates an invite, a second member joins. */
export async function family(server: FakeServer, options: Partial<CoreOptions> = {}) {
  const a = makeCore(server, options);
  const b = makeCore(server, options);
  await a.start();
  await b.start();
  const accA = await a.join({ serverUrl: 'https://fc.test', code: { adminCode: server.adminCode }, name: 'Мама' });
  const inv = await a.admin.createInvite(accA.id);
  const accB = await b.join({ serverUrl: 'https://fc.test', code: { invite: inv.code }, name: 'Папа' });
  await a.refreshMembers(accA.id);
  return { a, b, accA, accB, invite: inv };
}
