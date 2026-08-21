import { describe, it, expect, beforeEach, afterEach } from '../bun-test.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { encryptSecret, decryptSecret, resetSecretKey, secretKeyPath } from './crypto.js';

function randomKeyB64(): string {
  return crypto.randomBytes(32).toString('base64');
}

describe('secrets/crypto', () => {
  const originalKey = process.env.OCTOMUX_SECRET_KEY;
  const originalDataDir = process.env.OCTOMUX_DATA_DIR;

  beforeEach(() => {
    resetSecretKey();
    process.env.OCTOMUX_SECRET_KEY = randomKeyB64();
  });

  afterEach(() => {
    resetSecretKey();
    if (originalKey === undefined) delete process.env.OCTOMUX_SECRET_KEY;
    else process.env.OCTOMUX_SECRET_KEY = originalKey;
    if (originalDataDir === undefined) delete process.env.OCTOMUX_DATA_DIR;
    else process.env.OCTOMUX_DATA_DIR = originalDataDir;
  });

  it('round-trips plaintext through encrypt/decrypt', () => {
    const blob = encryptSecret('hunter2-super-secret');
    expect(decryptSecret(blob)).toBe('hunter2-super-secret');
  });

  it('produces the v1:<iv>:<tag>:<ciphertext> blob shape', () => {
    const blob = encryptSecret('some-value');
    const parts = blob.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
  });

  it('throws on a tampered ciphertext (GCM auth tag mismatch)', () => {
    const blob = encryptSecret('hunter2-super-secret');
    const [version, iv, tag, ciphertext] = blob.split(':');
    const tamperedBytes = Buffer.from(ciphertext, 'base64');
    tamperedBytes[0] ^= 0xff;
    const tampered = `${version}:${iv}:${tag}:${tamperedBytes.toString('base64')}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('throws on an unknown version prefix', () => {
    expect(() => decryptSecret('v2:aaaa:bbbb:cccc')).toThrow(/version/);
  });

  it("honours OCTOMUX_SECRET_KEY: different keys cannot decrypt each other's blobs", () => {
    const blob = encryptSecret('cross-key-value');

    resetSecretKey();
    process.env.OCTOMUX_SECRET_KEY = randomKeyB64();

    expect(() => decryptSecret(blob)).toThrow();
  });

  it('honours OCTOMUX_SECRET_KEY: the same key decrypts across resets', () => {
    const key = process.env.OCTOMUX_SECRET_KEY!;
    const blob = encryptSecret('stable-key-value');

    resetSecretKey();
    process.env.OCTOMUX_SECRET_KEY = key;

    expect(decryptSecret(blob)).toBe('stable-key-value');
  });

  it('rejects an OCTOMUX_SECRET_KEY that does not decode to 32 bytes', () => {
    resetSecretKey();
    process.env.OCTOMUX_SECRET_KEY = Buffer.from('too-short').toString('base64');
    expect(() => encryptSecret('x')).toThrow(/32 bytes/);
  });

  it('falls back to a key file under OCTOMUX_DATA_DIR when no env key is set', () => {
    delete process.env.OCTOMUX_SECRET_KEY;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-secret-key-'));
    process.env.OCTOMUX_DATA_DIR = tmpDir;
    resetSecretKey();

    const keyPath = secretKeyPath();
    expect(keyPath).toBe(path.join(tmpDir, 'secret.key'));
    expect(fs.existsSync(keyPath)).toBe(false);

    const blob = encryptSecret('file-backed-value');
    expect(fs.existsSync(keyPath)).toBe(true);
    const mode = fs.statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);

    // A second resolution reuses the same persisted key.
    resetSecretKey();
    expect(decryptSecret(blob)).toBe('file-backed-value');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
