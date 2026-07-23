import { describe, it, expect, afterEach } from 'vitest';
import { startGatewayIfConfigured } from './boot.js';

afterEach(() => {
  delete process.env.OCTOMUX_GATEWAY_TELEGRAM_TOKEN;
});

describe('startGatewayIfConfigured', () => {
  it('is a silent no-op when no token is configured', async () => {
    delete process.env.OCTOMUX_GATEWAY_TELEGRAM_TOKEN;
    await expect(startGatewayIfConfigured()).resolves.toBeUndefined();
  });
});
