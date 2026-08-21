import { describe, it, expect, vi, beforeEach, afterEach } from '../bun-test.js';
import crypto from 'crypto';
import { createTestDb } from '../test-helpers.js';
import { resetSecretKey } from '../secrets/crypto.js';
import { resetRedaction } from '../secrets/redact.js';
import { putSecret } from '../secrets/store.js';

const mockGetSettings = vi.fn();
vi.mock('../settings.js', () => ({ getSettings: mockGetSettings }));

const { computeConfigFor } = await import('./config.js');

describe('computeConfigFor', () => {
  const originalKey = process.env.OCTOMUX_SECRET_KEY;

  beforeEach(() => {
    createTestDb();
    resetSecretKey();
    resetRedaction();
    process.env.OCTOMUX_SECRET_KEY = crypto.randomBytes(32).toString('base64');
    mockGetSettings.mockReset();
  });

  afterEach(() => {
    resetSecretKey();
    if (originalKey === undefined) delete process.env.OCTOMUX_SECRET_KEY;
    else process.env.OCTOMUX_SECRET_KEY = originalKey;
  });

  it('resolves ${secret:NAME} inside settings.compute[kind].secrets', async () => {
    putSecret('SSH_KEY', 'the-real-ssh-key-value');
    mockGetSettings.mockResolvedValue({
      compute: {
        ssh: { host: 'example.com', secrets: { privateKey: '${secret:SSH_KEY}' } },
      },
    });

    const { config, secrets } = await computeConfigFor('ssh');

    expect(secrets.privateKey).toBe('the-real-ssh-key-value');
    expect(config).toEqual({ host: 'example.com' });
  });

  it('leaves a ${secret:NAME} placeholder in config unresolved (config is env-only)', async () => {
    putSecret('SSH_KEY', 'the-real-ssh-key-value');
    mockGetSettings.mockResolvedValue({
      compute: {
        ssh: { host: '${secret:SSH_KEY}', secrets: {} },
      },
    });

    const { config } = await computeConfigFor('ssh');

    expect(config).toEqual({ host: '${secret:SSH_KEY}' });
  });

  it('still resolves ${env:VAR} in both config and secrets (no regression)', async () => {
    const origEnv = process.env.OCTOMUX_COMPUTE_TEST_HOST;
    process.env.OCTOMUX_COMPUTE_TEST_HOST = 'env-resolved-host';
    try {
      mockGetSettings.mockResolvedValue({
        compute: {
          ssh: {
            host: '${env:OCTOMUX_COMPUTE_TEST_HOST}',
            secrets: { token: '${env:OCTOMUX_COMPUTE_TEST_HOST}' },
          },
        },
      });

      const { config, secrets } = await computeConfigFor('ssh');

      expect(config).toEqual({ host: 'env-resolved-host' });
      expect(secrets.token).toBe('env-resolved-host');
    } finally {
      if (origEnv === undefined) delete process.env.OCTOMUX_COMPUTE_TEST_HOST;
      else process.env.OCTOMUX_COMPUTE_TEST_HOST = origEnv;
    }
  });

  it('returns empty config/secrets when the kind has no configured block', async () => {
    mockGetSettings.mockResolvedValue({ compute: {} });

    const { config, secrets } = await computeConfigFor('unconfigured');

    expect(config).toEqual({});
    expect(secrets).toEqual({});
  });
});
