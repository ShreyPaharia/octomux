import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { createApp } from './app.js';
import { createTestDb } from './test-helpers.js';

describe('POST /api/integrations/linear/prefill', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  it('returns prefilled map for given api key', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: {
          teams: {
            nodes: [
              {
                id: 'team-bac',
                key: 'BAC',
                name: 'Backend',
                states: {
                  nodes: [
                    { id: 's-backlog', name: 'Backlog', type: 'backlog' },
                    { id: 's-done', name: 'Done', type: 'completed' },
                  ],
                },
              },
            ],
          },
        },
      }),
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
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        errors: [
          { message: 'Authentication failed', extensions: { code: 'AUTHENTICATION_ERROR' } },
        ],
      }),
    });
    const app = createApp();
    const res = await request(app)
      .post('/api/integrations/linear/prefill')
      .send({ api_key: 'bad' })
      .expect(502);
    expect(res.body.error).toMatch(/authentication/i);
  });
});
