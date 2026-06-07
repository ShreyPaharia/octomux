import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import { getBindHost, isRemoteMode, isLoopbackAddress } from './remote-auth.js';
import { ensureToken, tokenFilePath } from './remote-auth.js';
import { sessionCookieValue, parseCookies, validSessionCookie, COOKIE_NAME } from './remote-auth.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const mocked = {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
  };
  return { ...mocked, default: mocked };
});

describe('remote-auth config', () => {
  afterEach(() => {
    delete process.env.OCTOMUX_BIND;
    vi.unstubAllEnvs();
  });

  it('getBindHost defaults to 127.0.0.1', () => {
    expect(getBindHost()).toBe('127.0.0.1');
  });

  it('getBindHost honors OCTOMUX_BIND', () => {
    process.env.OCTOMUX_BIND = '0.0.0.0';
    expect(getBindHost()).toBe('0.0.0.0');
  });

  it.each([
    [undefined, false],
    ['127.0.0.1', false],
    ['localhost', false],
    ['::1', false],
    ['0.0.0.0', true],
    ['100.64.1.2', true],
  ])('isRemoteMode with OCTOMUX_BIND=%s → %s', (bind, expected) => {
    if (bind === undefined) delete process.env.OCTOMUX_BIND;
    else process.env.OCTOMUX_BIND = bind;
    expect(isRemoteMode()).toBe(expected);
  });

  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['100.64.1.2', false],
    ['192.168.1.5', false],
    [undefined, false],
  ])('isLoopbackAddress(%s) → %s', (addr, expected) => {
    expect(isLoopbackAddress(addr)).toBe(expected);
  });
});

describe('remote-auth token', () => {
  afterEach(() => {
    delete process.env.OCTOMUX_REMOTE_TOKEN;
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.mkdirSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
  });

  it('returns OCTOMUX_REMOTE_TOKEN when set, without touching fs', () => {
    process.env.OCTOMUX_REMOTE_TOKEN = 'env-token-123';
    expect(ensureToken()).toBe('env-token-123');
    expect(vi.mocked(fs.readFileSync)).not.toHaveBeenCalled();
  });

  it('reads an existing token file', () => {
    delete process.env.OCTOMUX_REMOTE_TOKEN;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('file-token-abc');
    expect(ensureToken()).toBe('file-token-abc');
  });

  it('generates and persists a token (mode 0600) when none exists', () => {
    delete process.env.OCTOMUX_REMOTE_TOKEN;
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as unknown as string);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    const token = ensureToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(tokenFilePath(), token, {
      mode: 0o600,
    });
  });
});

describe('remote-auth cookies', () => {
  it('sessionCookieValue is a stable 64-char hex HMAC of the token', () => {
    const v = sessionCookieValue('tok');
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionCookieValue('tok')).toBe(v); // deterministic
    expect(sessionCookieValue('other')).not.toBe(v); // keyed by token
  });

  it('parseCookies extracts name/value pairs', () => {
    expect(parseCookies(`a=1; ${COOKIE_NAME}=xyz; b=2`)[COOKIE_NAME]).toBe('xyz');
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });

  it('validSessionCookie accepts the matching signed value only', () => {
    const good = sessionCookieValue('tok');
    expect(validSessionCookie(good, 'tok')).toBe(true);
    expect(validSessionCookie('deadbeef', 'tok')).toBe(false);
    expect(validSessionCookie('', 'tok')).toBe(false);
    expect(validSessionCookie(undefined, 'tok')).toBe(false);
  });
});
