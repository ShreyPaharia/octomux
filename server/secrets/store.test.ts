import { describe, it, expect, beforeEach, afterEach } from '../bun-test.js';
import crypto from 'crypto';
import { createTestDb } from '../test-helpers.js';
import { resetSecretKey } from './crypto.js';
import { resetRedaction, redactSecretValues } from './redact.js';
import {
  listSecrets,
  putSecret,
  deleteSecret,
  secretExists,
  getSecretValue,
  resolveSecrets,
  hasSecretRef,
  SECRET_NAME_RE,
} from './store.js';

describe('secrets/store', () => {
  const originalKey = process.env.OCTOMUX_SECRET_KEY;

  beforeEach(() => {
    createTestDb();
    resetSecretKey();
    resetRedaction();
    process.env.OCTOMUX_SECRET_KEY = crypto.randomBytes(32).toString('base64');
  });

  afterEach(() => {
    resetSecretKey();
    if (originalKey === undefined) delete process.env.OCTOMUX_SECRET_KEY;
    else process.env.OCTOMUX_SECRET_KEY = originalKey;
  });

  describe('SECRET_NAME_RE', () => {
    it('accepts a typical name', () => {
      expect(SECRET_NAME_RE.test('STRIPE_KEY')).toBe(true);
      expect(SECRET_NAME_RE.test('my.secret-name_1')).toBe(true);
    });

    it('rejects a name starting with a digit or containing spaces', () => {
      expect(SECRET_NAME_RE.test('1abc')).toBe(false);
      expect(SECRET_NAME_RE.test('has space')).toBe(false);
    });
  });

  describe('putSecret', () => {
    it('creates a new secret, returning metadata only', () => {
      const meta = putSecret('API_KEY', 'sekrit-value-123', 'a test key');
      expect(meta.name).toBe('API_KEY');
      expect(meta.description).toBe('a test key');
      expect(meta.created_at).toBeTruthy();
      expect(meta.updated_at).toBeTruthy();
      expect((meta as unknown as Record<string, unknown>).value).toBeUndefined();
      expect((meta as unknown as Record<string, unknown>).value_enc).toBeUndefined();
    });

    it('upserts on a second write: value replaced, created_at preserved, updated_at moves', async () => {
      const first = putSecret('API_KEY', 'first-value-123');
      await new Promise((r) => setTimeout(r, 1100));
      const second = putSecret('API_KEY', 'second-value-456', 'updated desc');

      expect(second.created_at).toBe(first.created_at);
      expect(second.updated_at).not.toBe(first.updated_at);
      expect(second.description).toBe('updated desc');
      expect(getSecretValue('API_KEY')).toBe('second-value-456');
      expect(listSecrets()).toHaveLength(1);
    });

    it('rejects a bad name', () => {
      expect(() => putSecret('1-bad-name', 'some-value-123')).toThrow();
      expect(() => putSecret('has space', 'some-value-123')).toThrow();
    });

    it('rejects an empty value', () => {
      expect(() => putSecret('API_KEY', '')).toThrow();
    });
  });

  describe('listSecrets', () => {
    it('never includes a value or value_enc field', () => {
      putSecret('API_KEY', 'super-secret-value-123', 'desc');
      const secrets = listSecrets();
      expect(secrets).toHaveLength(1);
      for (const s of secrets) {
        expect(Object.keys(s).sort()).toEqual(
          ['created_at', 'description', 'name', 'updated_at'].sort(),
        );
        expect('value' in s).toBe(false);
        expect('value_enc' in s).toBe(false);
      }
    });
  });

  describe('deleteSecret / secretExists', () => {
    it('deletes an existing secret and reports false for a missing one', () => {
      putSecret('API_KEY', 'some-value-123');
      expect(secretExists('API_KEY')).toBe(true);
      expect(deleteSecret('API_KEY')).toBe(true);
      expect(secretExists('API_KEY')).toBe(false);
      expect(deleteSecret('API_KEY')).toBe(false);
    });
  });

  describe('getSecretValue', () => {
    it('returns undefined for an unknown name', () => {
      expect(getSecretValue('NOPE')).toBeUndefined();
    });

    it('decrypts the stored value', () => {
      putSecret('API_KEY', 'the-real-value-123');
      expect(getSecretValue('API_KEY')).toBe('the-real-value-123');
    });
  });

  describe('resolveSecrets', () => {
    it('substitutes a placeholder in nested objects and arrays', () => {
      putSecret('TOKEN', 'resolved-token-value');
      const input = {
        headers: { Authorization: 'Bearer ${secret:TOKEN}' },
        list: ['${secret:TOKEN}', 'plain'],
        count: 3,
      };
      const resolved = resolveSecrets(input);
      expect(resolved.headers.Authorization).toBe('Bearer resolved-token-value');
      expect(resolved.list).toEqual(['resolved-token-value', 'plain']);
      expect(resolved.count).toBe(3);
    });

    it('leaves non-string leaves alone', () => {
      const input = { count: 5, enabled: true, nothing: null };
      expect(resolveSecrets(input)).toEqual(input);
    });

    it('throws on an unknown secret name', () => {
      expect(() => resolveSecrets('${secret:MISSING}')).toThrow(/secret not found: MISSING/);
    });
  });

  describe('hasSecretRef', () => {
    it('is true for a string containing a placeholder, nested in objects/arrays', () => {
      expect(hasSecretRef('${secret:TOKEN}')).toBe(true);
      expect(hasSecretRef({ a: { b: '${secret:TOKEN}' } })).toBe(true);
      expect(hasSecretRef(['x', '${secret:TOKEN}'])).toBe(true);
    });

    it('is false when there is no placeholder', () => {
      expect(hasSecretRef('plain string')).toBe(false);
      expect(hasSecretRef({ a: 1, b: 'plain' })).toBe(false);
      expect(hasSecretRef(null)).toBe(false);
    });
  });

  describe('redaction integration', () => {
    it('redacts a value written via putSecret with no explicit rememberSecretValue call', () => {
      putSecret('API_KEY', 'written-value-not-remembered');
      expect(redactSecretValues('leak: written-value-not-remembered')).toBe('leak: ••••');
    });

    it('redacts a value only surfaced via getSecretValue (decrypt path)', () => {
      // Simulate a fresh process: forget everything remembered so far.
      resetRedaction();
      putSecret('API_KEY', 'decrypted-later-value');
      resetRedaction();
      getSecretValue('API_KEY');
      expect(redactSecretValues('leak: decrypted-later-value')).toBe('leak: ••••');
    });
  });
});
