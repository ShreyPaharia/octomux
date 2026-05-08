import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveEnvVars } from './resolve-env.js';

describe('resolveEnvVars', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, TEST_TOKEN: 'secret123', BASE_URL: 'https://example.com' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('replaces a bare ${env:VAR} placeholder in a string', () => {
    expect(resolveEnvVars('${env:TEST_TOKEN}')).toBe('secret123');
  });

  it('replaces placeholder embedded in a larger string', () => {
    expect(resolveEnvVars('Bearer ${env:TEST_TOKEN}')).toBe('Bearer secret123');
  });

  it('replaces multiple placeholders in the same string', () => {
    expect(resolveEnvVars('${env:BASE_URL}/path?token=${env:TEST_TOKEN}')).toBe(
      'https://example.com/path?token=secret123',
    );
  });

  it('replaces unset variable with empty string', () => {
    expect(resolveEnvVars('${env:UNSET_VAR}')).toBe('');
  });

  it('recurses into object values', () => {
    const result = resolveEnvVars({ api_key: '${env:TEST_TOKEN}', url: '${env:BASE_URL}' });
    expect(result).toEqual({ api_key: 'secret123', url: 'https://example.com' });
  });

  it('recurses into nested objects', () => {
    const result = resolveEnvVars({ outer: { inner: '${env:TEST_TOKEN}' } });
    expect(result).toEqual({ outer: { inner: 'secret123' } });
  });

  it('recurses into array values', () => {
    const result = resolveEnvVars(['${env:TEST_TOKEN}', 'literal']);
    expect(result).toEqual(['secret123', 'literal']);
  });

  it('passes through numbers, booleans, and null unchanged', () => {
    expect(resolveEnvVars(42)).toBe(42);
    expect(resolveEnvVars(true)).toBe(true);
    expect(resolveEnvVars(null)).toBeNull();
  });

  it('leaves strings without placeholders unchanged', () => {
    expect(resolveEnvVars('no-placeholder')).toBe('no-placeholder');
  });
});
