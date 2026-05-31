import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createTestDb } from './test-helpers.js';
import { createApp } from './app.js';

vi.mock('./setup-status.js', () => ({
  getSetupStatus: vi.fn(async () => ({
    items: [{ id: 'tmux', label: 'tmux', category: 'required', status: 'ok' }],
    summary: { ready: true, blockerCount: 0, attentionCount: 0 },
    platform: 'darwin',
    hasBrew: true,
  })),
  runSetupInstall: vi.fn(async (id: string) => ({ ok: true, message: `installed ${id}` })),
  applyRecommendedDefaults: vi.fn(async () => ({
    editor: 'nvim',
    defaultHarnessId: 'claude-code',
    harnesses: {},
    defaultBaseBranch: 'main',
  })),
}));

vi.mock('./hooks-install.js', () => ({
  installHookTemplate: vi.fn(() => ['/tmp/jira-status']),
  listHookTemplates: vi.fn(() => ['jira-status']),
  isHookTemplateInstalled: vi.fn(() => false),
}));

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

describe('GET /api/setup/status', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
  });

  afterEach(() => {
    db.close();
  });

  it('returns setup status payload', async () => {
    const res = await request(app).get('/api/setup/status').expect(200);
    expect(res.body.summary.ready).toBe(true);
    expect(res.body.items).toHaveLength(1);
  });
});

describe('POST /api/setup/install', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
  });

  afterEach(() => {
    db.close();
  });

  it('400s without id', async () => {
    await request(app).post('/api/setup/install').send({}).expect(400);
  });

  it('runs install for allowed id', async () => {
    const res = await request(app).post('/api/setup/install').send({ id: 'skills' }).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toContain('skills');
  });
});

describe('POST /api/hooks/install', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
  });

  afterEach(() => {
    db.close();
  });

  it('installs hook template', async () => {
    const res = await request(app)
      .post('/api/hooks/install')
      .send({ template: 'jira-status' })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.files).toHaveLength(1);
  });
});

describe('GET /api/hooks/templates', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
  });

  afterEach(() => {
    db.close();
  });

  it('lists available hook templates with installed state', async () => {
    const res = await request(app).get('/api/hooks/templates').expect(200);
    expect(res.body).toEqual([{ id: 'jira-status', installed: false }]);
  });
});
