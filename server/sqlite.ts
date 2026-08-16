/**
 * The SQLite driver, `bun:sqlite`.
 *
 * Replaces better-sqlite3, which can't be used here at all: its addon fails to
 * dlopen under the Bun runtime (`ERR_DLOPEN_FAILED`) and `bindings` can't locate
 * a module root inside a `bun build --compile` binary. `bun:sqlite` is built into
 * the runtime, so it needs no addon and survives compilation.
 *
 * Two compatibility gaps are papered over below (`get()` nullishness and
 * `pragma()`). Everything else octomux uses — prepare/all/run/exec/transaction/
 * close and positional `?` params — is identical between the two drivers.
 */

import { Database as BunDatabase, type Statement, type SQLQueryBindings } from 'bun:sqlite';

/**
 * Value type accepted as a statement parameter. `bun:sqlite` types bindings
 * strictly where better-sqlite3 accepted `unknown` — use this for arrays of
 * parameters built up dynamically.
 */
export type { SQLQueryBindings };

export class Database extends BunDatabase {
  /**
   * `bun:sqlite` returns `null` from `.get()` when no row matches; better-sqlite3
   * returned `undefined`. The repository layer leans on the `undefined` shape
   * throughout (`Task | undefined` return types, `toBeUndefined()` in tests), and
   * `null` satisfies none of it. Normalise once here instead of auditing every
   * read site.
   *
   * The signature mirrors the base method exactly (`any[]` included) so the
   * override stays assignable; only the runtime value changes.
   */
  prepare<ReturnType, ParamsType extends SQLQueryBindings | SQLQueryBindings[]>(
    sql: string,
    params?: ParamsType,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors bun:sqlite's own signature
  ): Statement<ReturnType, ParamsType extends any[] ? ParamsType : [ParamsType]> {
    // eslint-disable-next-line no-restricted-syntax -- this IS the driver; the repository-layer rule targets callers
    const stmt = super.prepare<ReturnType, ParamsType>(sql, params);
    const get = stmt.get.bind(stmt);
    stmt.get = ((...args: Parameters<typeof get>) => get(...args) ?? undefined) as typeof stmt.get;
    return stmt;
  }

  /**
   * better-sqlite3-compatible `pragma()`: always returns the result rows.
   * `pragma('journal_mode = WAL')` → `[{ journal_mode: 'wal' }]`,
   * `pragma('table_info(tasks)')` → one row per column,
   * `pragma('foreign_keys = ON')` → `[]`.
   *
   * Deliberately not routed through `query()` — pragmas mutate connection state
   * and shouldn't share a cached prepared statement.
   */
  pragma(source: string): unknown[] {
    // eslint-disable-next-line no-restricted-syntax -- this IS the driver
    return this.prepare(`PRAGMA ${source}`).all();
  }
}

export default Database;
