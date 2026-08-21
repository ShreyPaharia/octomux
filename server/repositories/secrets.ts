/**
 * Repository layer for the `secrets` table (SHR-277).
 *
 * Rows only — no crypto, no redaction, no `${secret:NAME}` resolution. Those
 * live in `server/secrets/store.ts`, which is the only module that calls
 * `getSecretValueEnc()` and the only one that ever decrypts.
 *
 * `listSecretRows()` deliberately does NOT select `value_enc`: the metadata
 * path must not be able to leak a ciphertext, not even through a future
 * careless spread of the row.
 */
import { getDb } from '../db.js';

/** Metadata for one secret. There is no shape here that carries a value. */
export interface SecretRow {
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

const META_COLUMNS = 'name, description, created_at, updated_at';

export function listSecretRows(): SecretRow[] {
  return getDb()
    .prepare(`SELECT ${META_COLUMNS} FROM secrets ORDER BY name ASC`)
    .all() as SecretRow[];
}

export function getSecretRow(name: string): SecretRow | undefined {
  return getDb().prepare(`SELECT ${META_COLUMNS} FROM secrets WHERE name = ?`).get(name) as
    | SecretRow
    | undefined;
}

/** Upsert. Manual replace is the whole v1 rotation story. */
export function upsertSecretRow(
  name: string,
  valueEnc: string,
  description: string | null,
): SecretRow {
  getDb()
    .prepare(
      `INSERT INTO secrets (name, value_enc, description, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(name) DO UPDATE SET
         value_enc = excluded.value_enc,
         description = excluded.description,
         updated_at = datetime('now')`,
    )
    .run(name, valueEnc, description);
  return getSecretRow(name)!;
}

export function deleteSecretRow(name: string): boolean {
  return getDb().prepare('DELETE FROM secrets WHERE name = ?').run(name).changes > 0;
}

export function secretRowExists(name: string): boolean {
  return getDb().prepare('SELECT 1 FROM secrets WHERE name = ?').get(name) !== undefined;
}

/** The ciphertext. `server/secrets/store.ts` is the only caller — everything
 *  else goes through `getSecretValue()` there, which owns the decrypt. */
export function getSecretValueEnc(name: string): string | undefined {
  const row = getDb().prepare('SELECT value_enc FROM secrets WHERE name = ?').get(name) as
    | { value_enc: string }
    | undefined;
  return row?.value_enc;
}
