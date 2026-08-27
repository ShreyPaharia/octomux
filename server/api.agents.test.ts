import { describe, it, expect, beforeEach, vi } from './bun-test.js';

/**
 * Fake conductor runtime: no real tmux. `startConversation` stamps a
 * tmux_window (as the real one does after `new-session`) so the status
 * helper's liveness probe has something to evaluate; `isConversationSessionAlive`
 * is controllable per-test via `aliveOverride`.
 */
let aliveOverride: (() => Promise<boolean>) | null = null;

vi.mock('./orchestrator/runner.js', (importOriginal) => {
  const actual = importOriginal<typeof import('./orchestrator/runner.js')>();
  return {
    ...actual,
    startConversation: vi.fn(async (convId: string) => {
      updateConversation(convId, { tmux_window: `octomux-orch-${convId}:0` });
    }),
    stopConversation: vi.fn(async (convId: string) => {
      updateConversation(convId, { status: 'stopped', tmux_window: null });
    }),
    isConversationSessionAlive: vi.fn(async () => (aliveOverride ? aliveOverride() : true)),
  };
});

const { default: request } = await import('supertest');
const { createApp } = await import('./app.js');
const { createTestDb } = await import('./test-helpers.js');
const { updateConversation } = await import('./repositories/orchestrator.js');

describe('agents CRUD routes', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    aliveOverride = null;
    createTestDb();
    app = createApp();
  });

  describe('POST /api/agents', () => {
    it('creates an agent and returns it with derived status/session_id', async () => {
      const res = await request(app)
        .post('/api/agents')
        .send({ name: 'Ops Agent', system_prompt: 'You watch prod.' });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Ops Agent');
      expect(res.body.system_prompt).toBe('You watch prod.');
      expect(res.body.status).toBe('stopped');
      expect(res.body.session_id).toBeNull();
      expect(res.body.id).toHaveLength(12);
    });

    it('accepts an optional channel + object channel_config (stored as JSON)', async () => {
      const res = await request(app)
        .post('/api/agents')
        .send({
          name: 'Telegram Agent',
          system_prompt: 'p',
          channel: 'telegram',
          channel_config: { threadKey: 'chat-1' },
        });

      expect(res.status).toBe(201);
      expect(res.body.channel).toBe('telegram');
      expect(JSON.parse(res.body.channel_config)).toEqual({ threadKey: 'chat-1' });
    });

    it('rejects a missing name with 400', async () => {
      const res = await request(app).post('/api/agents').send({ system_prompt: 'p' });
      expect(res.status).toBe(400);
    });

    it('rejects a blank system_prompt with 400', async () => {
      const res = await request(app).post('/api/agents').send({ name: 'X', system_prompt: '   ' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/agents', () => {
    it('lists all agents with status', async () => {
      await request(app).post('/api/agents').send({ name: 'A', system_prompt: 'p1' });
      await request(app).post('/api/agents').send({ name: 'B', system_prompt: 'p2' });

      const res = await request(app).get('/api/agents');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body.every((a: { status: string }) => a.status === 'stopped')).toBe(true);
    });

    it('returns an empty list when there are no agents', async () => {
      const res = await request(app).get('/api/agents');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('never throws even if the liveness probe errors (defaults to stopped)', async () => {
      const create = await request(app).post('/api/agents').send({ name: 'A', system_prompt: 'p' });
      await request(app).post(`/api/agents/${create.body.id}/session`);

      aliveOverride = () => Promise.reject(new Error('tmux exploded'));

      const res = await request(app).get('/api/agents');
      expect(res.status).toBe(200);
      expect(res.body[0].status).toBe('stopped');
    });
  });

  describe('GET /api/agents/:id', () => {
    it('returns 404 for an unknown id', async () => {
      const res = await request(app).get('/api/agents/does-not-exist');
      expect(res.status).toBe(404);
    });

    it('returns the agent with status idle once its session is alive', async () => {
      const create = await request(app).post('/api/agents').send({ name: 'A', system_prompt: 'p' });
      await request(app).post(`/api/agents/${create.body.id}/session`);

      const res = await request(app).get(`/api/agents/${create.body.id}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('idle');
      expect(res.body.session_id).toEqual(expect.any(String));
    });
  });

  describe('PATCH /api/agents/:id', () => {
    it('updates given fields and leaves others untouched', async () => {
      const create = await request(app)
        .post('/api/agents')
        .send({ name: 'Original', system_prompt: 'orig' });

      const res = await request(app)
        .patch(`/api/agents/${create.body.id}`)
        .send({ name: 'Renamed' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Renamed');
      expect(res.body.system_prompt).toBe('orig');
    });

    it('rejects an empty name with 400', async () => {
      const create = await request(app)
        .post('/api/agents')
        .send({ name: 'Original', system_prompt: 'orig' });

      const res = await request(app).patch(`/api/agents/${create.body.id}`).send({ name: '   ' });

      expect(res.status).toBe(400);
    });

    it('returns 404 for an unknown id', async () => {
      const res = await request(app).patch('/api/agents/does-not-exist').send({ name: 'X' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/agents/:id', () => {
    it('deletes the agent and stops its session if it has one', async () => {
      const create = await request(app)
        .post('/api/agents')
        .send({ name: 'Doomed', system_prompt: 'p' });
      await request(app).post(`/api/agents/${create.body.id}/session`);

      const runner = await import('./orchestrator/runner.js');

      const res = await request(app).delete(`/api/agents/${create.body.id}`);
      expect(res.status).toBe(204);
      expect(runner.stopConversation).toHaveBeenCalledTimes(1);

      const getRes = await request(app).get(`/api/agents/${create.body.id}`);
      expect(getRes.status).toBe(404);
    });

    it('deletes an agent that never had a session without calling stopConversation', async () => {
      const create = await request(app)
        .post('/api/agents')
        .send({ name: 'Never started', system_prompt: 'p' });

      const runner = await import('./orchestrator/runner.js');

      const res = await request(app).delete(`/api/agents/${create.body.id}`);
      expect(res.status).toBe(204);
      expect(runner.stopConversation).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown id', async () => {
      const res = await request(app).delete('/api/agents/does-not-exist');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/agents/:id/session', () => {
    it('returns 404 for an unknown agent', async () => {
      const res = await request(app).post('/api/agents/does-not-exist/session');
      expect(res.status).toBe(404);
    });

    it('starts a fresh session with the agent name + system prompt', async () => {
      const create = await request(app)
        .post('/api/agents')
        .send({ name: 'Ops Agent', system_prompt: 'You watch prod.' });

      const res = await request(app).post(`/api/agents/${create.body.id}/session`);
      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Ops Agent');
      expect(res.body.agent_id).toBe(create.body.id);

      const runner = await import('./orchestrator/runner.js');
      expect(runner.startConversation).toHaveBeenCalledTimes(1);
      const [, , opts] = (runner.startConversation as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(opts).toMatchObject({ systemPrompt: 'You watch prod.' });
    });

    it('reuses the existing session on a second call instead of starting another', async () => {
      const create = await request(app)
        .post('/api/agents')
        .send({ name: 'Ops Agent', system_prompt: 'p' });

      const first = await request(app).post(`/api/agents/${create.body.id}/session`);
      const second = await request(app).post(`/api/agents/${create.body.id}/session`);

      expect(second.body.id).toBe(first.body.id);

      const runner = await import('./orchestrator/runner.js');
      expect(runner.startConversation).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /api/advisor/session', () => {
    it('creates the Advisor agent on first call and starts its session', async () => {
      const res = await request(app).post('/api/advisor/session');
      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Advisor');
      expect(res.body.agent_id).toBeTruthy();

      const agents = await request(app).get('/api/agents');
      const advisor = agents.body.find((a: { name: string }) => a.name === 'Advisor');
      expect(advisor).toBeDefined();
      expect(advisor.system_prompt).toContain('octomux ADVISOR');

      const runner = await import('./orchestrator/runner.js');
      const [, , opts] = (runner.startConversation as ReturnType<typeof vi.fn>).mock.calls[0];
      expect((opts as { systemPrompt: string }).systemPrompt).toContain('octomux ADVISOR');
    });

    it('reuses both the agent row and the session across calls', async () => {
      const first = await request(app).post('/api/advisor/session');
      const second = await request(app).post('/api/advisor/session');

      expect(second.body.id).toBe(first.body.id);
      expect(second.body.agent_id).toBe(first.body.agent_id);

      const agents = await request(app).get('/api/agents');
      expect(agents.body.filter((a: { name: string }) => a.name === 'Advisor')).toHaveLength(1);

      const runner = await import('./orchestrator/runner.js');
      expect(runner.startConversation).toHaveBeenCalledTimes(1);
    });
  });
});
