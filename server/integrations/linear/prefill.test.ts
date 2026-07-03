import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInvokeLinear = vi.fn();

vi.mock('./graphql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./graphql.js')>();
  return {
    ...actual,
    invokeLinear: (...args: unknown[]) => mockInvokeLinear(...args),
  };
});

import { prefillFromLinear } from './prefill.js';

const TEAMS_RESPONSE = {
  teams: {
    nodes: [
      {
        id: 'team-bac',
        key: 'BAC',
        name: 'Backend',
        states: {
          nodes: [
            { id: 's-backlog', name: 'Backlog', type: 'backlog' },
            { id: 's-todo', name: 'Todo', type: 'unstarted' },
            { id: 's-progress', name: 'In Progress', type: 'started' },
            { id: 's-review', name: 'In Review', type: 'started' },
            { id: 's-done', name: 'Done', type: 'completed' },
            { id: 's-cancel', name: 'Canceled', type: 'canceled' },
          ],
        },
      },
      {
        id: 'team-oge',
        key: 'OGE',
        name: 'Ostium Growth Engineering',
        states: {
          nodes: [
            { id: 's2-backlog', name: 'Backlog', type: 'backlog' },
            { id: 's2-prog', name: 'In progress', type: 'started' },
            { id: 's2-shipped', name: 'Shipped', type: 'completed' },
          ],
        },
      },
    ],
  },
};

function mockTeamsFromSdk() {
  mockInvokeLinear.mockImplementation(async (_apiKey, fn) => {
    const teams = TEAMS_RESPONSE.teams.nodes.map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name,
      states: vi.fn().mockResolvedValue({ nodes: t.states.nodes }),
    }));
    return fn({
      teams: vi.fn().mockResolvedValue({ nodes: teams }),
    });
  });
}

describe('prefillFromLinear', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps Backend states by name with auto-prefill, prefers Backend as default', async () => {
    mockTeamsFromSdk();

    const result = await prefillFromLinear('lin_xyz');

    expect(result.teams.length).toBe(2);
    expect(result.default_team_suggestion).toBe('BAC');
    expect(result.status_map_by_team.BAC).toEqual({
      backlog: 's-backlog',
      planned: 's-todo',
      in_progress: 's-progress',
      human_review: 's-review',
      pr: 's-review',
      done: 's-done',
    });
  });

  it('falls back to completed-type state for done when no name match', async () => {
    mockTeamsFromSdk();

    const result = await prefillFromLinear('lin_xyz');
    // OGE has no "Done" by name — should pick the completed-typed "Shipped"
    expect(result.status_map_by_team.OGE.done).toBe('s2-shipped');
  });

  it('leaves slots unmapped when no candidate matches', async () => {
    mockTeamsFromSdk();

    const result = await prefillFromLinear('lin_xyz');
    // OGE has no "Todo" / "Review" — those slots should be absent
    expect(result.status_map_by_team.OGE.planned).toBeUndefined();
    expect(result.status_map_by_team.OGE.human_review).toBeUndefined();
  });

  it('first team becomes default suggestion when no Backend team exists', async () => {
    mockInvokeLinear.mockImplementation(async (_apiKey, fn) => {
      const t = TEAMS_RESPONSE.teams.nodes[1];
      const team = {
        id: t.id,
        key: t.key,
        name: t.name,
        states: vi.fn().mockResolvedValue({ nodes: t.states.nodes }),
      };
      return fn({
        teams: vi.fn().mockResolvedValue({ nodes: [team] }),
      });
    });

    const result = await prefillFromLinear('lin_xyz');
    expect(result.default_team_suggestion).toBe('OGE');
  });
});
