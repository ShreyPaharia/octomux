import { describe, it, expect, afterEach, vi } from 'vitest';
import { getBindHost, isRemoteMode, isLoopbackAddress } from './remote-auth.js';

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
