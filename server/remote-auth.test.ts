import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import {
  getBindHost,
  isRemoteMode,
  isLoopbackAddress,
  ensureToken,
  tokenFilePath,
  sessionCookieValue,
  sessionCookieValue as sig,
  parseCookies,
  validSessionCookie,
  validToken,
  COOKIE_NAME,
  authorizeRequest,
  authorizeUpgrade,
  isUpgradeAuthorized,
} from './remote-auth.js';
import type { IncomingMessage } from 'http';

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

describe('validToken', () => {
  it.each([
    ['correct-token', 'correct-token', true],
    ['wrong-token', 'correct-token', false],
    ['', 'correct-token', false],
  ])('validToken(%s, %s) → %s', (provided, token, expected) => {
    expect(validToken(provided, token)).toBe(expected);
  });
});

describe('authorizeRequest (pure)', () => {
  const token = 'tok';
  const cookie = `${COOKIE_NAME}=${sig(token)}`;

  it('allows everything when remote mode is off', () => {
    expect(
      authorizeRequest({
        remoteMode: false,
        isLoopback: false,
        path: '/api/tasks',
        cookieHeader: undefined,
        token,
      }),
    ).toBe('allow');
  });

  it('allows loopback requests without a cookie', () => {
    expect(
      authorizeRequest({
        remoteMode: true,
        isLoopback: true,
        path: '/api/tasks',
        cookieHeader: undefined,
        token,
      }),
    ).toBe('allow');
  });

  it.each(['/login', '/logout'])('exempts %s from auth in remote mode', (p) => {
    expect(
      authorizeRequest({
        remoteMode: true,
        isLoopback: false,
        path: p,
        cookieHeader: undefined,
        token,
      }),
    ).toBe('allow');
  });

  it('rejects /api/hooks/install from non-loopback in remote mode (admin route now protected)', () => {
    expect(
      authorizeRequest({
        remoteMode: true,
        isLoopback: false,
        path: '/api/hooks/install',
        cookieHeader: undefined,
        token,
      }),
    ).toBe('unauthorized');
  });

  it('allows /api/hooks/permission-request from loopback in remote mode (real harness callback)', () => {
    expect(
      authorizeRequest({
        remoteMode: true,
        isLoopback: true,
        path: '/api/hooks/permission-request',
        cookieHeader: undefined,
        token,
      }),
    ).toBe('allow');
  });

  it('allows a remote request with a valid cookie', () => {
    expect(
      authorizeRequest({
        remoteMode: true,
        isLoopback: false,
        path: '/api/tasks',
        cookieHeader: cookie,
        token,
      }),
    ).toBe('allow');
  });

  it('returns "unauthorized" for an API path without a cookie', () => {
    expect(
      authorizeRequest({
        remoteMode: true,
        isLoopback: false,
        path: '/api/tasks',
        cookieHeader: undefined,
        token,
      }),
    ).toBe('unauthorized');
  });

  it('returns "redirect" for a non-API path without a cookie', () => {
    expect(
      authorizeRequest({
        remoteMode: true,
        isLoopback: false,
        path: '/tasks/abc',
        cookieHeader: undefined,
        token,
      }),
    ).toBe('redirect');
  });
});

describe('authorizeUpgrade (pure)', () => {
  const token = 'tok';
  it.each([
    [{ remoteMode: false, isLoopback: false, cookieHeader: undefined }, true],
    [{ remoteMode: true, isLoopback: true, cookieHeader: undefined }, true],
    [{ remoteMode: true, isLoopback: false, cookieHeader: undefined }, false],
    [{ remoteMode: true, isLoopback: false, cookieHeader: `${COOKIE_NAME}=${sig('tok')}` }, true],
    [{ remoteMode: true, isLoopback: false, cookieHeader: `${COOKIE_NAME}=bad` }, false],
  ])('%o → %s', (input, expected) => {
    expect(authorizeUpgrade({ ...input, token } as Parameters<typeof authorizeUpgrade>[0])).toBe(
      expected,
    );
  });
});

describe('isUpgradeAuthorized wrapper', () => {
  afterEach(() => {
    delete process.env.OCTOMUX_BIND;
    delete process.env.OCTOMUX_REMOTE_TOKEN;
  });

  it('allows when remote mode is off regardless of address', () => {
    const req = {
      socket: { remoteAddress: '100.64.1.2' },
      headers: {},
    } as unknown as IncomingMessage;
    expect(isUpgradeAuthorized(req)).toBe(true);
  });

  it('rejects a remote upgrade without a valid cookie', () => {
    process.env.OCTOMUX_BIND = '0.0.0.0';
    process.env.OCTOMUX_REMOTE_TOKEN = 'tok';
    const req = {
      socket: { remoteAddress: '100.64.1.2' },
      headers: {},
    } as unknown as IncomingMessage;
    expect(isUpgradeAuthorized(req)).toBe(false);
  });

  it('allows a loopback upgrade in remote mode', () => {
    process.env.OCTOMUX_BIND = '0.0.0.0';
    process.env.OCTOMUX_REMOTE_TOKEN = 'tok';
    const req = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: {},
    } as unknown as IncomingMessage;
    expect(isUpgradeAuthorized(req)).toBe(true);
  });
});
