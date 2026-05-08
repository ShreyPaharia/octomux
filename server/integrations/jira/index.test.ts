import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HookEnvelope } from '../../hook-types.js';

// ─── Mock fetch globally ──────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Import provider after stubbing ──────────────────────────────────────────

// We import the registry to ensure registerProvider was called, but we import
// the provider directly for white-box testing.
import { jiraProvider } from './index.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_CONFIG = {
  base_url: 'https://acme.atlassian.net',
  email: 'dev@acme.com',
  api_token: 'token123',
  status_map: {
    in_progress: '31',
    done: '41',
  },
};

function makeEnvelope(overrides: Partial<HookEnvelope> = {}): HookEnvelope {
  return {
    event: 'workflow_status_changed',
    task: {
      id: 'task-abc',
      external_refs: [{ integration: 'jira', ref: 'PROJ-123' }],
    } as any,
    data: { from: 'in_progress', to: 'done' },
    ...overrides,
  };
}

function mockFetchOk(jsonData?: unknown) {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(jsonData ?? {}),
    text: vi.fn().mockResolvedValue(''),
  });
}

function mockFetchFail(status: number, statusText = 'Error') {
  mockFetch.mockResolvedValue({
    ok: false,
    status,
    statusText,
    json: vi.fn().mockResolvedValue({ error: statusText }),
    text: vi.fn().mockResolvedValue(statusText),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('jiraProvider.validate', () => {
  it('accepts a valid config', () => {
    expect(jiraProvider.validate(VALID_CONFIG)).toEqual({ ok: true });
  });

  it.each([
    ['missing base_url', { ...VALID_CONFIG, base_url: '' }, 'base_url'],
    ['invalid base_url', { ...VALID_CONFIG, base_url: 'not-a-url' }, 'base_url'],
    ['missing email', { ...VALID_CONFIG, email: '' }, 'email'],
    ['invalid email', { ...VALID_CONFIG, email: 'notanemail' }, 'email'],
    ['missing api_token', { ...VALID_CONFIG, api_token: '' }, 'api_token'],
    ['missing status_map', { ...VALID_CONFIG, status_map: undefined }, 'status_map'],
    ['null config', null, 'object'],
  ] as const)('rejects %s', (_label, config, expectedErrorWord) => {
    const result = jiraProvider.validate(config);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.toLowerCase().includes(expectedErrorWord))).toBe(true);
  });
});

describe('jiraProvider.test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls /rest/api/3/myself with Basic auth', async () => {
    mockFetchOk({ displayName: 'Dev User' });

    const result = await jiraProvider.test!(VALID_CONFIG);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Dev User');

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/myself');
    const expectedCreds = Buffer.from(`${VALID_CONFIG.email}:${VALID_CONFIG.api_token}`).toString(
      'base64',
    );
    expect((opts.headers as Record<string, string>)['Authorization']).toBe(
      `Basic ${expectedCreds}`,
    );
  });

  it('returns ok: false when Jira returns 401', async () => {
    mockFetchFail(401, 'Unauthorized');
    const result = await jiraProvider.test!(VALID_CONFIG);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('401');
  });

  it('returns ok: false when fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await jiraProvider.test!(VALID_CONFIG);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ECONNREFUSED');
  });
});

describe('jiraProvider.handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips when task has no jira ref', async () => {
    const envelope = makeEnvelope({
      task: { id: 'task-abc', external_refs: [] } as any,
    });
    await jiraProvider.handler(envelope, VALID_CONFIG);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips when to_status has no mapping in status_map', async () => {
    const envelope = makeEnvelope({
      data: { from: 'backlog', to: 'planned' }, // 'planned' not in status_map
    });
    await jiraProvider.handler(envelope, VALID_CONFIG);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips when envelope data is missing to_status', async () => {
    const envelope = makeEnvelope({ data: {} });
    await jiraProvider.handler(envelope, VALID_CONFIG);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('POSTs the correct transition when matching ref and status', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 204, text: vi.fn().mockResolvedValue('') });

    const envelope = makeEnvelope();
    await jiraProvider.handler(envelope, VALID_CONFIG);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/issue/PROJ-123/transitions');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({ transition: { id: '41' } });
    const expectedCreds = Buffer.from(`${VALID_CONFIG.email}:${VALID_CONFIG.api_token}`).toString(
      'base64',
    );
    expect((opts.headers as Record<string, string>)['Authorization']).toBe(
      `Basic ${expectedCreds}`,
    );
  });

  it('works with integration ref prefixed with "jira:"', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 204, text: vi.fn().mockResolvedValue('') });

    const envelope = makeEnvelope({
      task: {
        id: 'task-abc',
        external_refs: [{ integration: 'jira:my-instance', ref: 'ACME-99' }],
      } as any,
    });
    await jiraProvider.handler(envelope, VALID_CONFIG);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('ACME-99');
  });

  it('does not throw when fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));

    const envelope = makeEnvelope();
    await expect(jiraProvider.handler(envelope, VALID_CONFIG)).resolves.toBeUndefined();
  });
});
