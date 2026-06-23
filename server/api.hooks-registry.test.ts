/**
 * C4: API tests for hook registry endpoints.
 *
 * GET  /api/hooks/registry   → returns built-in + FS hooks with enabled state
 * PATCH /api/hooks/registry/:scope/:key → upserts hook_settings + invalidates cache
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createTestDb } from './test-helpers.js';
import { createApp } from './app.js';

vi.mock('./hook-dispatcher.js', () => ({
  fireHook: vi.fn(),
  getTaskHookExecutions: vi.fn(async () => []),
  isHookEnabled: vi.fn(() => true),
  invalidateHookEnabledCache: vi.fn(),
}));

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

describe('C4: GET /api/hooks/registry', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
  });

  it('returns a hooks array with at least the built-in entry', async () => {
    const res = await request(app).get('/api/hooks/registry').expect(200);
    expect(res.body).toHaveProperty('hooks');
    expect(Array.isArray(res.body.hooks)).toBe(true);

    const builtin = res.body.hooks.find(
      (h: { scope: string; key: string }) =>
        h.scope === 'builtin' && h.key === 'summarize-progress',
    );
    expect(builtin).toBeDefined();
    expect(builtin.description).toBeTruthy();
    expect(typeof builtin.enabled).toBe('boolean');
  });

  it('built-in summarize-progress is disabled by default (no row = disabled)', async () => {
    const res = await request(app).get('/api/hooks/registry').expect(200);
    const builtin = res.body.hooks.find(
      (h: { scope: string; key: string }) =>
        h.scope === 'builtin' && h.key === 'summarize-progress',
    );
    expect(builtin.enabled).toBe(false);
  });

  it('built-in has requires_env set when ANTHROPIC_API_KEY is missing', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const res = await request(app).get('/api/hooks/registry').expect(200);
      const builtin = res.body.hooks.find(
        (h: { scope: string; key: string }) => h.key === 'summarize-progress',
      );
      expect(builtin.requires_env).toBe('ANTHROPIC_API_KEY');
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('built-in has requires_env null when ANTHROPIC_API_KEY is set', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const res = await request(app).get('/api/hooks/registry').expect(200);
      const builtin = res.body.hooks.find(
        (h: { scope: string; key: string }) => h.key === 'summarize-progress',
      );
      expect(builtin.requires_env).toBeNull();
    } finally {
      if (saved === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = saved;
      }
    }
  });

  it('reflects enabled state from hook_settings', async () => {
    db.prepare(
      `INSERT INTO hook_settings (scope, key, enabled, updated_at)
       VALUES ('builtin', 'summarize-progress', 1, datetime('now'))`,
    ).run();

    const res = await request(app).get('/api/hooks/registry').expect(200);
    const builtin = res.body.hooks.find(
      (h: { scope: string; key: string }) => h.key === 'summarize-progress',
    );
    expect(builtin.enabled).toBe(true);
  });
});

describe('C4: PATCH /api/hooks/registry/:scope/:key', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
  });

  it('upserts a new enabled=true row', async () => {
    const res = await request(app)
      .patch('/api/hooks/registry/builtin/summarize-progress')
      .send({ enabled: true })
      .expect(200);

    expect(res.body.enabled).toBe(true);

    const row = db
      .prepare(
        `SELECT enabled FROM hook_settings WHERE scope='builtin' AND key='summarize-progress'`,
      )
      .get() as { enabled: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(1);
  });

  it('upserts a new enabled=false row', async () => {
    await request(app)
      .patch('/api/hooks/registry/builtin/summarize-progress')
      .send({ enabled: false })
      .expect(200);

    const row = db
      .prepare(
        `SELECT enabled FROM hook_settings WHERE scope='builtin' AND key='summarize-progress'`,
      )
      .get() as { enabled: number } | undefined;
    expect(row!.enabled).toBe(0);
  });

  it('updates an existing row (toggle)', async () => {
    db.prepare(
      `INSERT INTO hook_settings (scope, key, enabled, updated_at)
       VALUES ('builtin', 'summarize-progress', 1, datetime('now'))`,
    ).run();

    await request(app)
      .patch('/api/hooks/registry/builtin/summarize-progress')
      .send({ enabled: false })
      .expect(200);

    const row = db
      .prepare(
        `SELECT enabled FROM hook_settings WHERE scope='builtin' AND key='summarize-progress'`,
      )
      .get() as { enabled: number };
    expect(row.enabled).toBe(0);
  });

  it('calls invalidateHookEnabledCache after update', async () => {
    const { invalidateHookEnabledCache } = await import('./hook-dispatcher.js');

    await request(app)
      .patch('/api/hooks/registry/builtin/summarize-progress')
      .send({ enabled: true })
      .expect(200);

    expect(invalidateHookEnabledCache).toHaveBeenCalledWith('builtin', 'summarize-progress');
  });

  it('returns 400 when body is missing enabled', async () => {
    await request(app).patch('/api/hooks/registry/builtin/summarize-progress').send({}).expect(400);
  });

  it('returns 400 when enabled is not boolean', async () => {
    await request(app)
      .patch('/api/hooks/registry/builtin/summarize-progress')
      .send({ enabled: 'yes' })
      .expect(400);
  });

  it('handles URL-encoded scope and key', async () => {
    const scope = encodeURIComponent('repo:/Users/me/my-repo');
    const key = encodeURIComponent('workflow_status_changed/slack.sh');

    await request(app)
      .patch(`/api/hooks/registry/${scope}/${key}`)
      .send({ enabled: false })
      .expect(200);

    const row = db
      .prepare(`SELECT enabled FROM hook_settings WHERE scope=? AND key=?`)
      .get('repo:/Users/me/my-repo', 'workflow_status_changed/slack.sh') as
      | { enabled: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(0);
  });
});
