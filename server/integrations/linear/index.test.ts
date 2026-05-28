import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HookEnvelope } from '../../hook-types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { linearProvider } from './index.js';

const VALID_CONFIG = {
  api_key: 'lin_api_xyz',
  default_team_key: 'BAC',
  status_map_by_team: {
    BAC: {
      backlog: '11111111-1111-1111-1111-111111111111',
      planned: '22222222-2222-2222-2222-222222222222',
      in_progress: '33333333-3333-3333-3333-333333333333',
      human_review: '44444444-4444-4444-4444-444444444444',
      pr: '44444444-4444-4444-4444-444444444444',
      done: '55555555-5555-5555-5555-555555555555',
    },
  },
};

function mockFetchOk(data: unknown) {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({ data }),
    text: vi.fn().mockResolvedValue(''),
  });
}

describe('linearProvider.validate', () => {
  it('accepts a valid config', () => {
    expect(linearProvider.validate(VALID_CONFIG)).toEqual({ ok: true });
  });

  it.each([
    ['missing api_key', { ...VALID_CONFIG, api_key: '' }, 'api_key'],
    ['null config', null, 'object'],
    [
      'status_map_by_team not an object',
      { ...VALID_CONFIG, status_map_by_team: 'bad' },
      'status_map_by_team',
    ],
    [
      'invalid status_map column key',
      { ...VALID_CONFIG, status_map_by_team: { BAC: { bogus: 'uuid' } } },
      'column',
    ],
    [
      'invalid UUID in map',
      { ...VALID_CONFIG, status_map_by_team: { BAC: { done: 'not-a-uuid' } } },
      'uuid',
    ],
  ] as const)('rejects %s', (_label, config, expectedWord) => {
    const result = linearProvider.validate(config);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.toLowerCase().includes(expectedWord))).toBe(true);
  });

  it('allows partial team maps (unmapped slots OK)', () => {
    const cfg = {
      api_key: 'k',
      status_map_by_team: { BAC: { done: '55555555-5555-5555-5555-555555555555' } },
    };
    expect(linearProvider.validate(cfg)).toEqual({ ok: true });
  });
});

describe('linearProvider.test', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls Linear `viewer` query with bare api key', async () => {
    mockFetchOk({ viewer: { id: 'u', name: 'Dev User', email: 'dev@x.io' } });
    const result = await linearProvider.test!(VALID_CONFIG);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Dev User');

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.linear.app/graphql');
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('lin_api_xyz');
  });

  it('returns ok:false on auth error', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        errors: [
          { message: 'Authentication failed', extensions: { code: 'AUTHENTICATION_ERROR' } },
        ],
      }),
    });
    const result = await linearProvider.test!(VALID_CONFIG);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/authentication/i);
  });
});

function makeEnvelope(overrides: Partial<HookEnvelope> = {}): HookEnvelope {
  return {
    event: 'workflow_status_changed',
    task: {
      id: 'task-abc',
      external_refs: [
        {
          integration: 'linear',
          ref: 'BAC-1',
          url: null,
          metadata: { team_key: 'BAC', issue_id: 'lin-uuid-1' },
        },
      ],
    } as any,
    data: { from: 'in_progress', to: 'done' },
    ...overrides,
  };
}

describe('linearProvider.handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('issueUpdate + commentCreate when ref + map hit + non-backlog target', async () => {
    // Two sequential graphql calls expected: issueUpdate, then commentCreate.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: { issueUpdate: { success: true } } }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: { commentCreate: { success: true } } }),
    });

    await linearProvider.handler(makeEnvelope(), VALID_CONFIG);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(firstBody.query).toContain('issueUpdate');
    expect(firstBody.variables).toMatchObject({
      id: 'lin-uuid-1',
      stateId: '55555555-5555-5555-5555-555555555555',
    });
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(secondBody.query).toContain('commentCreate');
    expect(secondBody.variables.body).toContain('done');
  });

  it('suppresses comment when target is backlog', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: { issueUpdate: { success: true } } }),
    });
    await linearProvider.handler(
      makeEnvelope({ data: { from: 'planned', to: 'backlog' } }),
      VALID_CONFIG,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1); // only issueUpdate, no commentCreate
  });

  it('skips when no linear ref on task', async () => {
    await linearProvider.handler(
      makeEnvelope({
        task: { id: 't', external_refs: [{ integration: 'jira', ref: 'P-1' }] } as any,
      }),
      VALID_CONFIG,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips when team has no mapping for to_status', async () => {
    await linearProvider.handler(
      makeEnvelope({ data: { from: 'backlog', to: 'unknown_status' } as any }),
      VALID_CONFIG,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('parses team_key from ref string when metadata missing', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: { issue: { id: 'lin-uuid-2', team: { key: 'BAC' } } },
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: { issueUpdate: { success: true } } }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: { commentCreate: { success: true } } }),
    });

    await linearProvider.handler(
      makeEnvelope({
        task: {
          id: 't',
          external_refs: [{ integration: 'linear', ref: 'BAC-9', metadata: null }],
        } as any,
      }),
      VALID_CONFIG,
    );
    expect(mockFetch).toHaveBeenCalledTimes(3); // issue lookup + issueUpdate + commentCreate
    // Confirms the regex-derived team_key 'BAC' resolved through VALID_CONFIG's BAC map.
    const lookupBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(lookupBody.variables).toEqual({ id: 'BAC-9' });
    const updateBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(updateBody.variables).toMatchObject({
      id: 'lin-uuid-2',
      stateId: '55555555-5555-5555-5555-555555555555',
    });
  });
});
