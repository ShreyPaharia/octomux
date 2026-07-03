import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HookEnvelope } from '../../hook-types.js';

const mockInvokeLinear = vi.fn();

vi.mock('./graphql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./graphql.js')>();
  return {
    ...actual,
    invokeLinear: (...args: unknown[]) => mockInvokeLinear(...args),
  };
});

import { linearProvider } from './index.js';
import { LinearApiError } from './graphql.js';

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

  it('calls Linear viewer via SDK with configured api key', async () => {
    mockInvokeLinear.mockImplementation(async (apiKey, fn) =>
      fn({
        get viewer() {
          return Promise.resolve({ id: 'u', name: 'Dev User', email: 'dev@x.io' });
        },
      }),
    );

    const result = await linearProvider.test!(VALID_CONFIG);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Dev User');
    expect(mockInvokeLinear).toHaveBeenCalledWith('lin_api_xyz', expect.any(Function));
  });

  it('returns ok:false on auth error', async () => {
    mockInvokeLinear.mockRejectedValue(new LinearApiError('Authentication failed'));
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
    const updateIssue = vi.fn().mockResolvedValue({ success: true });
    const createComment = vi.fn().mockResolvedValue({ success: true });

    mockInvokeLinear.mockImplementation(async (_apiKey, fn) => fn({ updateIssue, createComment }));

    await linearProvider.handler(makeEnvelope(), VALID_CONFIG);

    expect(mockInvokeLinear).toHaveBeenCalledTimes(2);
    expect(updateIssue).toHaveBeenCalledWith('lin-uuid-1', {
      stateId: '55555555-5555-5555-5555-555555555555',
    });
    expect(createComment).toHaveBeenCalledWith({
      issueId: 'lin-uuid-1',
      body: expect.stringContaining('done'),
    });
  });

  it('suppresses comment when target is backlog', async () => {
    const updateIssue = vi.fn().mockResolvedValue({ success: true });
    const createComment = vi.fn();

    mockInvokeLinear.mockImplementation(async (_apiKey, fn) => fn({ updateIssue, createComment }));

    await linearProvider.handler(
      makeEnvelope({ data: { from: 'planned', to: 'backlog' } }),
      VALID_CONFIG,
    );
    expect(mockInvokeLinear).toHaveBeenCalledTimes(1);
    expect(createComment).not.toHaveBeenCalled();
  });

  it('skips when no linear ref on task', async () => {
    await linearProvider.handler(
      makeEnvelope({
        task: { id: 't', external_refs: [{ integration: 'jira', ref: 'P-1' }] } as any,
      }),
      VALID_CONFIG,
    );
    expect(mockInvokeLinear).not.toHaveBeenCalled();
  });

  it('skips when team has no mapping for to_status', async () => {
    await linearProvider.handler(
      makeEnvelope({ data: { from: 'backlog', to: 'unknown_status' } as any }),
      VALID_CONFIG,
    );
    expect(mockInvokeLinear).not.toHaveBeenCalled();
  });

  it('parses team_key from ref string when metadata missing', async () => {
    const issue = vi.fn().mockResolvedValue({ id: 'lin-uuid-2' });
    const updateIssue = vi.fn().mockResolvedValue({ success: true });
    const createComment = vi.fn().mockResolvedValue({ success: true });

    mockInvokeLinear.mockImplementation(async (_apiKey, fn) =>
      fn({ issue, updateIssue, createComment }),
    );

    await linearProvider.handler(
      makeEnvelope({
        task: {
          id: 't',
          external_refs: [{ integration: 'linear', ref: 'BAC-9', metadata: null }],
        } as any,
      }),
      VALID_CONFIG,
    );

    expect(mockInvokeLinear).toHaveBeenCalledTimes(3);
    expect(issue).toHaveBeenCalledWith('BAC-9');
    expect(updateIssue).toHaveBeenCalledWith('lin-uuid-2', {
      stateId: '55555555-5555-5555-5555-555555555555',
    });
  });
});
