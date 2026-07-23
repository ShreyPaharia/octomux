import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb } from './test-helpers.js';

vi.mock('./task-engine/index.js', async () => {
  const { getDb } = await import('./db.js');
  const { insertAgent } = await import('./test-helpers.js');
  const { nanoid } = await import('nanoid');
  return {
    // Fakes the worktree/tmux/first-agent setup real startTask performs, so
    // downstream startLoop() (real, exercised in this file) finds an active agent.
    startTask: vi.fn(async (task: { id: string; worktree_id?: string | null }) => {
      const db = getDb();
      db.prepare(
        `UPDATE tasks SET runtime_state = 'running', tmux_session = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(`octomux-agent-${task.id}`, task.id);
      if (task.worktree_id) {
        db.prepare(`UPDATE worktrees SET path = ?, branch = COALESCE(branch, ?) WHERE id = ?`).run(
          `/tmp/.worktrees/${task.id}`,
          `agents/${task.id}`,
          task.worktree_id,
        );
      }
      insertAgent(db, {
        id: nanoid(12),
        task_id: task.id,
        window_index: 0,
        status: 'running',
        hook_token: `tok-${task.id}`,
      } as any);
    }),
  };
});

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
vi.mock('./skills.js', () => ({}));
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

const VALID_SPEC = { prompt: 'improve X', verify: 'true', maxIterations: 3 };

describe('loop-group routes', () => {
  let app: ReturnType<typeof createApp>;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    nextWindowIndex = 5;
    db = createTestDb();
    app = createApp();
  });

  describe('POST /api/loop-groups', () => {
    it('creates n candidate tasks + loop_runs sharing one group_id', async () => {
      const res = await request(app)
        .post('/api/loop-groups')
        .send({ repoPath: '/repo', baseBranch: 'main', spec: VALID_SPEC, n: 3 });

      expect(res.status).toBe(201);
      expect(res.body.loopRuns).toHaveLength(3);
      const groupIds = new Set(res.body.loopRuns.map((r: { group_id: string }) => r.group_id));
      expect(groupIds.size).toBe(1);
      expect(groupIds.has(res.body.id)).toBe(true);

      const rows = db.prepare('SELECT * FROM loop_runs WHERE group_id = ?').all(res.body.id);
      expect(rows).toHaveLength(3);
    });

    it('rejects n outside [2, 8]', async () => {
      const res = await request(app)
        .post('/api/loop-groups')
        .send({ repoPath: '/repo', baseBranch: 'main', spec: VALID_SPEC, n: 1 });
      expect(res.status).toBe(400);
    });

    it('rejects a missing repoPath with 400', async () => {
      const res = await request(app)
        .post('/api/loop-groups')
        .send({ baseBranch: 'main', spec: VALID_SPEC, n: 3 });
      expect(res.status).toBe(400);
    });

    it('rejects a missing spec.verify with 400', async () => {
      const res = await request(app)
        .post('/api/loop-groups')
        .send({
          repoPath: '/repo',
          baseBranch: 'main',
          spec: { prompt: 'x', maxIterations: 3 },
          n: 3,
        });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/loop-groups + GET /api/loop-groups/:id', () => {
    it('lists groups and returns one with its loopRuns', async () => {
      const createRes = await request(app)
        .post('/api/loop-groups')
        .send({ repoPath: '/repo', baseBranch: 'main', spec: VALID_SPEC, n: 2 });

      const listRes = await request(app).get('/api/loop-groups');
      expect(listRes.status).toBe(200);
      expect(listRes.body).toHaveLength(1);

      const getRes = await request(app).get(`/api/loop-groups/${createRes.body.id}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.loopRuns).toHaveLength(2);
    });

    it('returns 404 for an unknown group id', async () => {
      const res = await request(app).get('/api/loop-groups/does-not-exist');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/loop-groups/:id/judge', () => {
    it('409s while any candidate is still running', async () => {
      const createRes = await request(app)
        .post('/api/loop-groups')
        .send({ repoPath: '/repo', baseBranch: 'main', spec: VALID_SPEC, n: 2 });
      const judgeRes = await request(app).post(`/api/loop-groups/${createRes.body.id}/judge`);
      expect(judgeRes.status).toBe(409);
    });

    it('202s and flips judge_status to running once all candidates are terminal', async () => {
      const createRes = await request(app)
        .post('/api/loop-groups')
        .send({ repoPath: '/repo', baseBranch: 'main', spec: VALID_SPEC, n: 2 });
      db.prepare(`UPDATE loop_runs SET status = 'done' WHERE group_id = ?`).run(createRes.body.id);

      const judgeRes = await request(app).post(`/api/loop-groups/${createRes.body.id}/judge`);
      expect(judgeRes.status).toBe(202);
      expect(judgeRes.body.judge_status).toBe('running');
    });

    it('returns 404 for an unknown group id', async () => {
      const res = await request(app).post('/api/loop-groups/does-not-exist/judge');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/loop-groups/:id/judge/emit', () => {
    it('records exactly one winner + rationale without altering candidate rows', async () => {
      const createRes = await request(app)
        .post('/api/loop-groups')
        .send({ repoPath: '/repo', baseBranch: 'main', spec: VALID_SPEC, n: 2 });
      const [runA, runB] = createRes.body.loopRuns;
      db.prepare(`UPDATE loop_runs SET status = 'done' WHERE id IN (?, ?)`).run(runA.id, runB.id);

      const agentRow = db.prepare('SELECT hook_token FROM agents LIMIT 1').get() as {
        hook_token: string;
      };

      const emitRes = await request(app)
        .post(`/api/loop-groups/${createRes.body.id}/judge/emit`)
        .set('Authorization', `Bearer ${agentRow.hook_token}`)
        .send({ winnerLoopRunId: runA.id, rationale: 'Candidate A had a cleaner diff.' });

      expect(emitRes.status).toBe(200);
      expect(emitRes.body.judge_status).toBe('done');
      expect(emitRes.body.winner_loop_run_id).toBe(runA.id);

      const untouchedA = db.prepare('SELECT status FROM loop_runs WHERE id = ?').get(runA.id) as {
        status: string;
      };
      const untouchedB = db.prepare('SELECT status FROM loop_runs WHERE id = ?').get(runB.id) as {
        status: string;
      };
      expect(untouchedA.status).toBe('done');
      expect(untouchedB.status).toBe('done');
    });

    it('rejects a winnerLoopRunId that is not a member of the group with 400', async () => {
      const createRes = await request(app)
        .post('/api/loop-groups')
        .send({ repoPath: '/repo', baseBranch: 'main', spec: VALID_SPEC, n: 2 });
      const agentRow = db.prepare('SELECT hook_token FROM agents LIMIT 1').get() as {
        hook_token: string;
      };

      const res = await request(app)
        .post(`/api/loop-groups/${createRes.body.id}/judge/emit`)
        .set('Authorization', `Bearer ${agentRow.hook_token}`)
        .send({ winnerLoopRunId: 'not-a-member', rationale: 'x' });

      expect(res.status).toBe(400);
    });

    it('401s without a valid hook token', async () => {
      const createRes = await request(app)
        .post('/api/loop-groups')
        .send({ repoPath: '/repo', baseBranch: 'main', spec: VALID_SPEC, n: 2 });

      const res = await request(app)
        .post(`/api/loop-groups/${createRes.body.id}/judge/emit`)
        .send({ winnerLoopRunId: createRes.body.loopRuns[0].id, rationale: 'x' });
      expect(res.status).toBe(401);
    });
  });
});
