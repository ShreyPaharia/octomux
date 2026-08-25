import { describe, it, expect, beforeEach, afterEach, vi } from './bun-test.js';

// Mock the task-runner so app creation doesn't fail on server-level setup
// (same shape as server/api.integrations.test.ts).
vi.mock('./task-engine/index.js', () => ({
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

// Fixed 32-byte key so the suite never writes a real key file to ~/.octomux.
vi.stubEnv('OCTOMUX_SECRET_KEY', Buffer.alloc(32, 7).toString('base64'));

const { default: request } = await import('supertest');
const { createApp } = await import('./app.js');
const { createTestDb } = await import('./test-helpers.js');
const { resetSecretKey } = await import('./secrets/crypto.js');
const { resetRedaction } = await import('./secrets/redact.js');

/** Recursively asserts no key resembling a raw secret value ever appears in a payload. */
function assertNoValueLeak(payload: unknown): void {
  const json = JSON.stringify(payload);
  expect(json.toLowerCase()).not.toContain('"value"');
  expect(json.toLowerCase()).not.toContain('"value_enc"');
}

describe('secrets API', () => {
  beforeEach(() => {
    createTestDb();
    resetSecretKey();
    resetRedaction();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('PUT creates a secret and returns metadata only, no value in the body', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/secrets/MY_TOKEN')
      .send({ value: 'super-secret-value-123', description: 'a token' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'MY_TOKEN', description: 'a token' });
    expect(res.body.created_at).toBeDefined();
    expect(res.body.updated_at).toBeDefined();
    assertNoValueLeak(res.body);
    expect(JSON.stringify(res.body)).not.toContain('super-secret-value-123');
  });

  it('PUT again updates the value and returns 200', async () => {
    const app = createApp();
    await request(app).put('/api/secrets/MY_TOKEN').send({ value: 'first-value-abc' });
    const res = await request(app)
      .put('/api/secrets/MY_TOKEN')
      .send({ value: 'second-value-xyz', description: 'updated' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'MY_TOKEN', description: 'updated' });
    assertNoValueLeak(res.body);
  });

  it('GET lists metadata only, never a value field', async () => {
    const app = createApp();
    await request(app)
      .put('/api/secrets/ONE')
      .send({ value: 'value-one-secret', description: null });
    await request(app).put('/api/secrets/TWO').send({ value: 'value-two-secret' });

    const res = await request(app).get('/api/secrets');
    expect(res.status).toBe(200);
    expect(res.body.secrets).toHaveLength(2);
    const names = res.body.secrets.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(['ONE', 'TWO']);
    assertNoValueLeak(res.body);
    expect(JSON.stringify(res.body)).not.toContain('value-one-secret');
    expect(JSON.stringify(res.body)).not.toContain('value-two-secret');
  });

  it('DELETE removes a secret', async () => {
    const app = createApp();
    await request(app).put('/api/secrets/GONE').send({ value: 'to-be-deleted-value' });

    const del = await request(app).delete('/api/secrets/GONE');
    expect(del.status).toBe(204);

    const list = await request(app).get('/api/secrets');
    expect(list.body.secrets).toHaveLength(0);
  });

  it('DELETE of an unknown name is 404', async () => {
    const app = createApp();
    const res = await request(app).delete('/api/secrets/NOPE');
    expect(res.status).toBe(404);
  });

  it('PUT with an invalid name is 400', async () => {
    const app = createApp();
    const res = await request(app)
      .put('/api/secrets/' + encodeURIComponent('bad name!'))
      .send({ value: 'some-secret-value' });
    expect(res.status).toBe(400);
  });

  it('PUT with an empty value is 400', async () => {
    const app = createApp();
    const res = await request(app).put('/api/secrets/EMPTY').send({ value: '' });
    expect(res.status).toBe(400);
  });

  it('PUT with a missing value is 400', async () => {
    const app = createApp();
    const res = await request(app).put('/api/secrets/MISSING').send({});
    expect(res.status).toBe(400);
  });

  it('there is no route that returns a value — GET /api/secrets/:name does not 200', async () => {
    const app = createApp();
    await request(app).put('/api/secrets/PINNED').send({ value: 'pinned-secret-value' });

    // Pinning actual behavior: express matches GET /api/secrets/:name against
    // no handler in this router, and no other router owns it either, so it
    // falls through to the app's 404 handler. Whatever it is, it must not be
    // 200 with a value in the body.
    const res = await request(app).get('/api/secrets/PINNED');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('pinned-secret-value');
  });
});
