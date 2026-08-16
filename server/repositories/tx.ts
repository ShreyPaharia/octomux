import { getDb } from '../db.js';

/** Run fn inside a single SQLite transaction (rolls back on throw). */
export function inTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}
