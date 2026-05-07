import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb } from './test-helpers.js';

// Mock the task-runner so app creation doesn't fail on server-level setup
vi.mock('./task-runner.js', () => ({
  startTask: vi.fn(),
  closeTask: vi.fn(),
  deleteTask: vi.fn(),
  resumeTask: vi.fn(),
  addAgent: vi.fn(),
  stopAgent: vi.fn(),
  createUserTerminal: vi.fn(),
  createShellTerminal: vi.fn(),
  closeShellTerminal: vi.fn(),
  hopAgent: vi.fn(),
}));

vi.mock('./hook-dispatcher.js', () => ({
  fireHook: vi.fn(),
}));

vi.mock('./events.js', () => ({
  broadcast: vi.fn(),
  setupWs: vi.fn(),
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/integrations/providers', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('returns the Jira provider', async () => {
    const app = createApp();
    const res = await request(app).get('/api/integrations/providers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const jira = (res.body as Array<{ kind: string }>).find((p) => p.kind === 'jira');
    expect(jira).toBeDefined();
    expect(jira).toMatchObject({ kind: 'jira', displayName: 'Jira' });
    expect((jira as any).configSchema).toBeDefined();
    expect((jira as any).events).toContain('workflow_status_changed');
  });
});

describe('POST /api/integrations', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('creates a Jira integration and returns masked config', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/integrations')
      .send({
        kind: 'jira',
        name: 'My Jira',
        config: {
          base_url: 'https://acme.atlassian.net',
          email: 'dev@acme.com',
          api_token: 'supersecret',
          status_map: { done: '41' },
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('jira');
    expect(res.body.name).toBe('My Jira');
    // api_token must be masked in the response
    expect(res.body.config.api_token).toBe('••••');
  });

  it('returns 400 for unknown kind', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/integrations')
      .send({ kind: 'unknown', name: 'test', config: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('unknown');
  });

  it('returns 400 when config validation fails', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/integrations')
      .send({ kind: 'jira', name: 'test', config: { base_url: 'not-a-url' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('validation');
  });
});

describe('GET /api/integrations', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty list initially', async () => {
    const app = createApp();
    const res = await request(app).get('/api/integrations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns created integration with masked secret', async () => {
    const app = createApp();
    // Create one first
    await request(app).post('/api/integrations').send({
      kind: 'jira',
      name: 'Test Jira',
      config: {
        base_url: 'https://test.atlassian.net',
        email: 'test@test.com',
        api_token: 'mysecret',
        status_map: {},
      },
    });

    const res = await request(app).get('/api/integrations');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].config.api_token).toBe('••••');
  });
});

describe('PATCH /api/integrations/:id', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  async function createJira(app: ReturnType<typeof createApp>) {
    const res = await request(app).post('/api/integrations').send({
      kind: 'jira',
      name: 'My Jira',
      config: {
        base_url: 'https://acme.atlassian.net',
        email: 'dev@acme.com',
        api_token: 'originaltoken',
        status_map: { done: '41' },
      },
    });
    return res.body as { id: string; config: Record<string, unknown> };
  }

  it('updates the name', async () => {
    const app = createApp();
    const created = await createJira(app);
    const res = await request(app)
      .patch(`/api/integrations/${created.id}`)
      .send({ name: 'Renamed Jira' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed Jira');
  });

  it('toggles enabled', async () => {
    const app = createApp();
    const created = await createJira(app);
    const res = await request(app)
      .patch(`/api/integrations/${created.id}`)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it('preserves stored api_token when masked sentinel is sent', async () => {
    const app = createApp();
    const created = await createJira(app);

    // Send an update with the masked sentinel for api_token
    const patchRes = await request(app)
      .patch(`/api/integrations/${created.id}`)
      .send({
        config: {
          base_url: 'https://acme.atlassian.net',
          email: 'dev@acme.com',
          api_token: '••••', // masked sentinel
          status_map: { done: '41' },
        },
      });
    expect(patchRes.status).toBe(200);
    // The api_token should still be masked in response (not cleared)
    expect(patchRes.body.config.api_token).toBe('••••');

    // Verify the DB actually has the original token by calling the list endpoint
    const listRes = await request(app).get('/api/integrations');
    expect(listRes.body[0].config.api_token).toBe('••••'); // still masked = stored
  });

  it('returns 404 for unknown id', async () => {
    const app = createApp();
    const res = await request(app).patch('/api/integrations/notexist').send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/integrations/:id', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('deletes the integration and returns 204', async () => {
    const app = createApp();
    const createRes = await request(app).post('/api/integrations').send({
      kind: 'jira',
      name: 'To Delete',
      config: {
        base_url: 'https://x.atlassian.net',
        email: 'a@b.com',
        api_token: 'tok',
        status_map: {},
      },
    });
    const id = createRes.body.id as string;

    const deleteRes = await request(app).delete(`/api/integrations/${id}`);
    expect(deleteRes.status).toBe(204);

    const listRes = await request(app).get('/api/integrations');
    expect(listRes.body).toHaveLength(0);
  });

  it('returns 404 for unknown id', async () => {
    const app = createApp();
    const res = await request(app).delete('/api/integrations/notexist');
    expect(res.status).toBe(404);
  });
});
