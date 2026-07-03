import { getDb } from '../db.js';

/** Run fn inside a single better-sqlite3 transaction (rolls back on throw). */
export function inTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}
