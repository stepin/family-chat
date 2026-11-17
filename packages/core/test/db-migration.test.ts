// The database migration of 1.0.0: `accounts.pushWanted` (the person's
// choice) is added next to `pushRegistered`; existing accounts keep what
// they had (wanted = registered).

import { Dexie } from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { CoreDb, openDb } from '../src/db/schema.ts';

describe('database version 6', () => {
  it('sets pushWanted from pushRegistered on accounts of version 5', async () => {
    const factory = new IDBFactory();
    // A version-5 database as the 0.1.0 app left it.
    const old = new Dexie('fc-migrate', { indexedDB: factory, IDBKeyRange });
    old.version(5).stores({ accounts: 'id, serverId', settings: 'key' });
    await old.open();
    await old.table('accounts').bulkAdd([
      { id: 'a', serverId: 's1', pushRegistered: true },
      { id: 'b', serverId: 's2', pushRegistered: false },
    ]);
    old.close();

    const db = await openDb(new CoreDb('fc-migrate', { indexedDB: factory, IDBKeyRange }));
    const rows = await db.accounts.toArray();
    expect(rows.map((r) => [r.id, r.pushRegistered, r.pushWanted])).toEqual([
      ['a', true, true],
      ['b', false, false],
    ]);
    expect(db.verno).toBe(6);
    db.close();
  });
});
