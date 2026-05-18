import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { hookBaseUrl } from './hook-base-url.js';

describe('hookBaseUrl', () => {
  const original = { ...process.env };
  beforeEach(() => {
    delete process.env.OCTOMUX_PORT;
    delete process.env.PORT;
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it('defaults to 127.0.0.1:7777', () => {
    expect(hookBaseUrl()).toBe('http://127.0.0.1:7777');
  });

  it('honors OCTOMUX_PORT', () => {
    process.env.OCTOMUX_PORT = '9999';
    expect(hookBaseUrl()).toBe('http://127.0.0.1:9999');
  });

  it('honors PORT when OCTOMUX_PORT is absent', () => {
    process.env.PORT = '8080';
    expect(hookBaseUrl()).toBe('http://127.0.0.1:8080');
  });

  it('OCTOMUX_PORT wins over PORT', () => {
    process.env.OCTOMUX_PORT = '9999';
    process.env.PORT = '8080';
    expect(hookBaseUrl()).toBe('http://127.0.0.1:9999');
  });
});
