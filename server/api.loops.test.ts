import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb, insertTask, insertAgent } from './test-helpers.js';
import { createLoopRun, appendIteration } from './repositories/loop-runs.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const mocked = {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
  return { ...mocked, default: mocked };
});

let nextWindowIndex = 5;
vi.mock('child_process', () => ({
  execFile: vi.fn(
    (_cmd: string, args: string[], optsOrCb: Function | object, maybeCb?: Function) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
      if (args.includes('list-windows')) {
        cb(null, { stdout: String(nextWindowIndex), stderr: '' });
      } else if (args.includes('new-window')) {
        nextWindowIndex++;
        cb(null, { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    },
  ),
}));

vi.mock('./orchestrator/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./orchestrator/store.js')>();
  return { ...actual, isOrchestratorManaged: vi.fn(() => false) };
});
vi.mock('./orchestrator/runner.js', () => ({ mcpServerInvocation: vi.fn(() => null) }));
vi.mock('./hook-base-url.js', () => ({ hookBaseUrl: vi.fn(() => 'http://127.0.0.1:7777') }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('./skills.js', () => ({ syncSkills: vi.fn(async () => undefined) }));
vi.mock('./harnesses/index.js', () => ({
  getHarness: vi.fn(() => ({
    id: 'claude-code',
    sessionIdMode: 'orchestrator-assigned',
    newSessionId: vi.fn(() => 'fresh-session-id'),
    buildLaunchCommand: vi.fn(() => 'claude --session-id fresh-session-id'),
    buildResumeCommand: vi.fn(),
    resolveFlags: vi.fn(() => ''),
    syncAgents: vi.fn(async () => undefined),
    installHooks: vi.fn(async () => undefined),
    postLaunch: vi.fn(async () => undefined),
  })),
}));

describe('loop routes', () => {
  let app: ReturnType<typeof createApp>;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    nextWindowIndex = 5;
    db = createTestDb();
    app = createApp();
    insertTask(db, { id: 't1', runtime_state: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', hook_token: 'tok-loop', status: 'running' } as any);
  });

  describe('POST /api/loops', () => {
    it('creates and starts a loop run', async () => {
      const res = await request(app)
        .post('/api/loops')
        .send({
          taskId: 't1',
          spec: { prompt: 'do the thing', verify: 'echo ok', maxIterations: 5 },
        });

      expect(res.status).toBe(201);
      expect(res.body.task_id).toBe('t1');
      expect(res.body.status).toBe('running');

      const task = db.prepare('SELECT runtime_state FROM tasks WHERE id = ?').get('t1') as {
        runtime_state: string;
      };
      expect(task.runtime_state).toBe('looping');
    });

    it('rejects a missing taskId with 400', async () => {
      const res = await request(app)
        .post('/api/loops')
        .send({ spec: { prompt: 'x', verify: 'y', maxIterations: 5 } });
      expect(res.status).toBe(400);
    });

    it('rejects a missing spec.verify with 400', async () => {
      const res = await request(app)
        .post('/api/loops')
        .send({ taskId: 't1', spec: { prompt: 'x', maxIterations: 5 } });
      expect(res.status).toBe(400);
    });

    it('returns 404 for an unknown task', async () => {
      const res = await request(app)
        .post('/api/loops')
        .send({ taskId: 'nope', spec: { prompt: 'x', verify: 'y', maxIterations: 5 } });
      expect(res.status).toBe(404);
    });

    it('returns 400 when the task has no active agent', async () => {
      db.prepare(`UPDATE agents SET status = 'stopped' WHERE id = 'a1'`).run();
      const res = await request(app)
        .post('/api/loops')
        .send({ taskId: 't1', spec: { prompt: 'x', verify: 'y', maxIterations: 5 } });
      expect(res.status).toBe(400);
    });

    it('returns 409 when the task already has an active loop run', async () => {
      createLoopRun({ task_id: 't1', spec_json: '{}' });
      db.prepare(`UPDATE tasks SET runtime_state = 'looping' WHERE id = 't1'`).run();

      const res = await request(app)
        .post('/api/loops')
        .send({
          taskId: 't1',
          spec: { prompt: 'do the thing', verify: 'echo ok', maxIterations: 5 },
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already has an active loop run/);
    });

    it('returns 409 when a loop_run is running even if runtime_state has not flipped yet', async () => {
      createLoopRun({ task_id: 't1', spec_json: '{}' });

      const res = await request(app)
        .post('/api/loops')
        .send({
          taskId: 't1',
          spec: { prompt: 'do the thing', verify: 'echo ok', maxIterations: 5 },
        });

      expect(res.status).toBe(409);
    });
  });

  describe('POST /api/loops/:runId/emit', () => {
    it('persists a valid emit and returns 200', async () => {
      const run = createLoopRun({ task_id: 't1', spec_json: '{}' });
      appendIteration(run.id, { sha_from: 'a1', sha_to: 'a2' });

      const res = await request(app)
        .post(`/api/loops/${run.id}/emit`)
        .set('Authorization', 'Bearer tok-loop')
        .send({ status: 'done', reason: 'all good' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('done');
      expect(res.body.termination_reason).toBe('all good');

      const iteration = db
        .prepare(`SELECT emit_status, emit_reason FROM loop_iterations WHERE loop_run_id = ?`)
        .get(run.id) as { emit_status: string; emit_reason: string };
      expect(iteration.emit_status).toBe('done');
      expect(iteration.emit_reason).toBe('all good');
    });

    it('rejects an invalid status enum with 400', async () => {
      const run = createLoopRun({ task_id: 't1', spec_json: '{}' });

      const res = await request(app)
        .post(`/api/loops/${run.id}/emit`)
        .set('Authorization', 'Bearer tok-loop')
        .send({ status: 'finished', reason: 'x' });

      expect(res.status).toBe(400);
    });

    it('rejects a missing reason with 400', async () => {
      const run = createLoopRun({ task_id: 't1', spec_json: '{}' });

      const res = await request(app)
        .post(`/api/loops/${run.id}/emit`)
        .set('Authorization', 'Bearer tok-loop')
        .send({ status: 'done' });

      expect(res.status).toBe(400);
    });

    it('rejects a blank reason with 400', async () => {
      const run = createLoopRun({ task_id: 't1', spec_json: '{}' });

      const res = await request(app)
        .post(`/api/loops/${run.id}/emit`)
        .set('Authorization', 'Bearer tok-loop')
        .send({ status: 'done', reason: '   ' });

      expect(res.status).toBe(400);
    });

    it('rejects a missing token with 401', async () => {
      const run = createLoopRun({ task_id: 't1', spec_json: '{}' });

      const res = await request(app)
        .post(`/api/loops/${run.id}/emit`)
        .send({ status: 'done', reason: 'x' });

      expect(res.status).toBe(401);
    });

    it('rejects an unrecognized token with 401', async () => {
      const run = createLoopRun({ task_id: 't1', spec_json: '{}' });

      const res = await request(app)
        .post(`/api/loops/${run.id}/emit`)
        .set('Authorization', 'Bearer nope')
        .send({ status: 'done', reason: 'x' });

      expect(res.status).toBe(401);
    });

    it('returns 404 for an unknown run id', async () => {
      const res = await request(app)
        .post(`/api/loops/does-not-exist/emit`)
        .set('Authorization', 'Bearer tok-loop')
        .send({ status: 'done', reason: 'x' });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/loops/:runId/stop', () => {
    it('terminates a running loop and idles the task', async () => {
      const run = createLoopRun({ task_id: 't1', spec_json: '{}' });
      db.prepare(`UPDATE tasks SET runtime_state = 'looping' WHERE id = 't1'`).run();

      const res = await request(app).post(`/api/loops/${run.id}/stop`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('needs_human');
      expect(res.body.termination_reason).toBe('stopped');

      const task = db.prepare('SELECT runtime_state FROM tasks WHERE id = ?').get('t1') as {
        runtime_state: string;
      };
      expect(task.runtime_state).toBe('idle');
    });

    it('is a no-op for an already-terminated loop', async () => {
      const run = createLoopRun({ task_id: 't1', spec_json: '{}' });
      await request(app).post(`/api/loops/${run.id}/stop`);

      const res = await request(app).post(`/api/loops/${run.id}/stop`);
      expect(res.status).toBe(200);
      expect(res.body.termination_reason).toBe('stopped');
    });

    it('returns 404 for an unknown run id', async () => {
      const res = await request(app).post('/api/loops/does-not-exist/stop');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/loops', () => {
    it('lists loop runs', async () => {
      createLoopRun({ task_id: 't1', spec_json: '{}' });
      createLoopRun({ task_id: 't1', spec_json: '{}' });

      const res = await request(app).get('/api/loops');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });
  });

  describe('GET /api/loops/:runId', () => {
    it('returns the run with its iterations', async () => {
      const run = createLoopRun({ task_id: 't1', spec_json: '{}' });
      appendIteration(run.id, { sha_from: 'a1', sha_to: 'a2' });
      appendIteration(run.id, { sha_from: 'a2', sha_to: 'a3' });

      const res = await request(app).get(`/api/loops/${run.id}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(run.id);
      expect(res.body.iterations).toHaveLength(2);
      expect(res.body.iterations[0].n).toBe(1);
      expect(res.body.iterations[1].n).toBe(2);
    });

    it('returns 404 for an unknown run id', async () => {
      const res = await request(app).get('/api/loops/does-not-exist');
      expect(res.status).toBe(404);
    });
  });
});
