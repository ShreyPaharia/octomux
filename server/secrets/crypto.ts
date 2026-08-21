/**
 * AES-256-GCM at-rest encryption for the named secret store (SHR-277).
 *
 * Key material: `OCTOMUX_SECRET_KEY` (base64, must decode to exactly 32 bytes)
 * wins when set; otherwise a 32-byte key is generated on first use and
 * persisted at `secretKeyPath()`, mode 0600. Cached in-process after first
 * resolution — `resetSecretKey()` (test-only) drops the cache.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { octomuxRoot } from '../octomux-root.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = 'v1';

let cachedKey: Buffer | null = null;

/** `<octomuxRoot()>/secret.key` — 32 random bytes, base64, mode 0600, created on
 *  first use. `OCTOMUX_SECRET_KEY` (base64 32 bytes) overrides the file entirely. */
export function secretKeyPath(): string {
  return path.join(octomuxRoot(), 'secret.key');
}

function keyFromEnv(): Buffer | null {
  const raw = process.env.OCTOMUX_SECRET_KEY;
  if (!raw) return null;
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `OCTOMUX_SECRET_KEY must decode to exactly ${KEY_BYTES} bytes (got ${decoded.length})`,
    );
  }
  return decoded;
}

function loadOrCreateKeyFile(): Buffer {
  const keyPath = secretKeyPath();
  if (fs.existsSync(keyPath)) {
    const decoded = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
    if (decoded.length !== KEY_BYTES) {
      throw new Error(`${keyPath} does not contain a valid ${KEY_BYTES}-byte key`);
    }
    return decoded;
  }
  const key = crypto.randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
  return key;
}

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = keyFromEnv() ?? loadOrCreateKeyFile();
  return cachedKey;
}

/** `v1:<iv b64>:<tag b64>:<ciphertext b64>` — AES-256-GCM, random 12-byte iv. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Throws on a bad/tampered blob (GCM auth tag) or an unknown version prefix. */
export function decryptSecret(blob: string): string {
  const parts = blob.split(':');
  const [version, ivB64, tagB64, ciphertextB64] = parts;
  if (version !== VERSION || parts.length !== 4) {
    throw new Error(`unsupported secret blob version: ${version ?? '(none)'}`);
  }
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Test-only: drops the cached key so a changed OCTOMUX_SECRET_KEY takes effect. */
export function resetSecretKey(): void {
  cachedKey = null;
}
