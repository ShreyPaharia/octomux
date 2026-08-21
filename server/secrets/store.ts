/**
 * Named secret store (SHR-277) — AES-256-GCM values at rest, referenced from
 * config by `${secret:NAME}`, resolved only server-side at the point of
 * egress. There is no read API that returns a value: `listSecrets()` is
 * metadata only, and `getSecretValue()` is internal — not exported over HTTP,
 * not on `ctx`.
 *
 * Rows live in `server/repositories/secrets.ts`. This module owns the crypto,
 * the redaction bookkeeping, and the placeholder walk.
 */
import { childLogger } from '../logger.js';
import {
  listSecretRows,
  getSecretRow,
  upsertSecretRow,
  deleteSecretRow,
  secretRowExists,
  getSecretValueEnc,
  type SecretRow,
} from '../repositories/secrets.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { rememberSecretValue } from './redact.js';

const logger = childLogger('secrets/store');

export type SecretMeta = SecretRow;

/** `^[A-Za-z_][A-Za-z0-9_.-]{0,63}$` */
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

/** Matches `${secret:NAME}`, capturing NAME. Same shape as `SECRET_NAME_RE`. */
const SECRET_REF_RE = /\$\{secret:([A-Za-z_][A-Za-z0-9_.-]{0,63})\}/g;

/** Metadata only. There is no API anywhere that returns a value. */
export function listSecrets(): SecretMeta[] {
  return listSecretRows();
}

/** Upsert. Manual replace is the v1 rotation story. Rejects a bad name or an
 *  empty value. Remembers the value for redaction. */
export function putSecret(name: string, value: string, description?: string | null): SecretMeta {
  if (!SECRET_NAME_RE.test(name)) {
    throw new Error(`invalid secret name: ${name}`);
  }
  if (!value) {
    throw new Error('secret value must not be empty');
  }
  const row = upsertSecretRow(name, encryptSecret(value), description ?? null);
  rememberSecretValue(value);
  logger.info({ name }, 'secret written');
  return row;
}

export function deleteSecret(name: string): boolean {
  const deleted = deleteSecretRow(name);
  if (deleted) logger.info({ name }, 'secret deleted');
  return deleted;
}

export function secretExists(name: string): boolean {
  return secretRowExists(name);
}

/** Metadata for one secret, or undefined. Still no value — see the module doc. */
export function getSecretMeta(name: string): SecretMeta | undefined {
  return getSecretRow(name);
}

/** INTERNAL. The only decrypt path. Not exported over HTTP, not on `ctx`.
 *  Remembers the value for redaction. */
export function getSecretValue(name: string): string | undefined {
  const valueEnc = getSecretValueEnc(name);
  if (valueEnc === undefined) return undefined;
  const value = decryptSecret(valueEnc);
  rememberSecretValue(value);
  return value;
}

/** Replaces `${secret:NAME}` in every string leaf, recursively (arrays + plain
 *  objects, same walk as resolveEnvVars). THROWS `secret not found: NAME` on an
 *  unknown name — unlike `${env:}`, degrading to '' here just sends an empty
 *  credential and gets a confusing 401 three layers away. */
export function resolveSecrets<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(SECRET_REF_RE, (_match, name: string) => {
      const secret = getSecretValue(name);
      if (secret === undefined) {
        throw new Error(`secret not found: ${name}`);
      }
      return secret;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveSecrets(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolveSecrets(v);
    }
    return result as unknown as T;
  }
  return value;
}

/** True if any string leaf contains a `${secret:...}` placeholder. */
export function hasSecretRef(value: unknown): boolean {
  if (typeof value === 'string') {
    SECRET_REF_RE.lastIndex = 0;
    return SECRET_REF_RE.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(hasSecretRef);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasSecretRef);
  }
  return false;
}
