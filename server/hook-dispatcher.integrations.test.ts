import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HookEnvelope } from './hook-types.js';
import type { IntegrationProvider, Integration } from './integrations/types.js';

// ─── Mock child_process & fs so fireHook shell-script path doesn't interfere ──

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    accessSync: vi.fn(),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(),
    constants: { X_OK: 1 },
  },
}));

// ─── Integration store mock ───────────────────────────────────────────────────

const mockListIntegrations = vi.fn<() => Integration[]>();
const mockGetProvider = vi.fn<(kind: string) => IntegrationProvider | undefined>();

vi.mock('./integrations/store.js', () => ({ listIntegrations: mockListIntegrations }));
vi.mock('./integrations/registry.js', () => ({ getProvider: mockGetProvider }));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeIntegration(overrides: Partial<Integration> = {}): Integration {
  return {
    id: 'int-abc123',
    kind: 'jira',
    name: 'My Jira',
    config: {
      base_url: 'https://x.atlassian.net',
      email: 'a@b.com',
      api_token: 'tok',
      status_map: {},
    },
    enabled: true,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

function makeProvider(overrides: Partial<IntegrationProvider> = {}): IntegrationProvider {
  return {
    kind: 'jira',
    displayName: 'Jira',
    configSchema: {},
    events: ['workflow_status_changed'],
    validate: vi.fn(() => ({ ok: true })),
    handler: vi.fn(async () => {}),
    ...overrides,
  };
}

const ENVELOPE: HookEnvelope = {
  event: 'workflow_status_changed',
  task: { id: 'task-abc' } as any,
  data: { from: 'in_progress', to: 'done' },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('fireHook — integration providers', () => {
  let fireHook: typeof import('./hook-dispatcher.js').fireHook;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ fireHook } = await import('./hook-dispatcher.js'));
  });

  it('calls the provider handler for matching enabled integration', async () => {
    const provider = makeProvider();
    const integration = makeIntegration();

    mockListIntegrations.mockReturnValue([integration]);
    mockGetProvider.mockReturnValue(provider);

    await fireHook('workflow_status_changed', ENVELOPE);

    expect(provider.handler).toHaveBeenCalledOnce();
    expect(provider.handler).toHaveBeenCalledWith(ENVELOPE, integration.config);
  });

  it('skips disabled integrations', async () => {
    const provider = makeProvider();
    const integration = makeIntegration({ enabled: false });

    mockListIntegrations.mockReturnValue([integration]);
    mockGetProvider.mockReturnValue(provider);

    await fireHook('workflow_status_changed', ENVELOPE);

    expect(provider.handler).not.toHaveBeenCalled();
  });

  it('skips integrations whose provider does not handle the event', async () => {
    const provider = makeProvider({ events: ['note_added'] }); // only note_added
    const integration = makeIntegration();

    mockListIntegrations.mockReturnValue([integration]);
    mockGetProvider.mockReturnValue(provider);

    await fireHook('workflow_status_changed', ENVELOPE);

    expect(provider.handler).not.toHaveBeenCalled();
  });

  it('skips integrations with no registered provider', async () => {
    const integration = makeIntegration({ kind: 'unknown' });

    mockListIntegrations.mockReturnValue([integration]);
    mockGetProvider.mockReturnValue(undefined);

    // Should not throw
    await expect(fireHook('workflow_status_changed', ENVELOPE)).resolves.toBeUndefined();
  });

  it('isolates provider failure and continues to next provider', async () => {
    const failingHandler = vi.fn(async () => {
      throw new Error('provider exploded');
    });
    const successHandler = vi.fn(async () => {});

    const failingProvider = makeProvider({ handler: failingHandler });
    const successProvider = makeProvider({ kind: 'success', handler: successHandler });

    const int1 = makeIntegration({ id: 'int-1', kind: 'jira' });
    const int2 = makeIntegration({ id: 'int-2', kind: 'success' });

    mockListIntegrations.mockReturnValue([int1, int2]);
    mockGetProvider.mockImplementation((kind) => {
      if (kind === 'jira') return failingProvider;
      if (kind === 'success') return successProvider;
      return undefined;
    });

    await expect(fireHook('workflow_status_changed', ENVELOPE)).resolves.toBeUndefined();
    expect(failingHandler).toHaveBeenCalledOnce();
    expect(successHandler).toHaveBeenCalledOnce();
  });

  it('times out a slow provider and continues', async () => {
    // Use a very short timeout for this test
    const origTimeout = process.env.OCTOMUX_HOOK_TIMEOUT_MS;
    process.env.OCTOMUX_HOOK_TIMEOUT_MS = '50';

    try {
      const slowHandler = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 5000)));
      const provider = makeProvider({ handler: slowHandler });
      const integration = makeIntegration();

      mockListIntegrations.mockReturnValue([integration]);
      mockGetProvider.mockReturnValue(provider);

      await expect(fireHook('workflow_status_changed', ENVELOPE)).resolves.toBeUndefined();
      expect(slowHandler).toHaveBeenCalledOnce();
    } finally {
      if (origTimeout === undefined) {
        delete process.env.OCTOMUX_HOOK_TIMEOUT_MS;
      } else {
        process.env.OCTOMUX_HOOK_TIMEOUT_MS = origTimeout;
      }
    }
  });

  it('handles listIntegrations throwing gracefully', async () => {
    mockListIntegrations.mockImplementation(() => {
      throw new Error('DB not ready');
    });
    mockGetProvider.mockReturnValue(makeProvider());

    await expect(fireHook('workflow_status_changed', ENVELOPE)).resolves.toBeUndefined();
  });
});
