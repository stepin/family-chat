// Dexie's liveQuery only emits when a global `indexedDB` exists (as in every
// browser context), even if the database itself uses an injected factory.
import 'fake-indexeddb/auto';
