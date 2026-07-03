import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mockInvokeLinear = vi.fn();

vi.mock('./integrations/linear/graphql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./integrations/linear/graphql.js')>();
  return {
    ...actual,
    invokeLinear: (...args: unknown[]) => mockInvokeLinear(...args),
  };
});

import { createApp } from './app.js';
import { createTestDb } from './test-helpers.js';
import { LinearApiError } from './integrations/linear/graphql.js';

describe('POST /api/integrations/linear/prefill', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  it('returns prefilled map for given api key', async () => {
    mockInvokeLinear.mockImplementation(async (_apiKey, fn) => {
      const teams = [
        {
          id: 'team-bac',
          key: 'BAC',
          name: 'Backend',
          states: vi.fn().mockResolvedValue({
            nodes: [
              { id: 's-backlog', name: 'Backlog', type: 'backlog' },
              { id: 's-done', name: 'Done', type: 'completed' },
            ],
          }),
        },
      ];
      return fn({
        teams: vi.fn().mockResolvedValue({ nodes: teams }),
      });
    });

    const app = createApp();
    const res = await request(app)
      .post('/api/integrations/linear/prefill')
      .send({ api_key: 'lin_xyz' })
      .expect(200);

    expect(res.body.teams).toHaveLength(1);
    expect(res.body.status_map_by_team.BAC.backlog).toBe('s-backlog');
    expect(res.body.status_map_by_team.BAC.done).toBe('s-done');
    expect(res.body.default_team_suggestion).toBe('BAC');
  });

  it('returns 400 when api_key missing', async () => {
    const app = createApp();
    const res = await request(app).post('/api/integrations/linear/prefill').send({}).expect(400);
    expect(res.body.error).toMatch(/api_key/);
  });

  it('returns 502 on Linear auth failure', async () => {
    mockInvokeLinear.mockRejectedValue(new LinearApiError('Authentication failed'));
    const app = createApp();
    const res = await request(app)
      .post('/api/integrations/linear/prefill')
      .send({ api_key: 'bad' })
      .expect(502);
    expect(res.body.error).toMatch(/authentication/i);
  });
});
