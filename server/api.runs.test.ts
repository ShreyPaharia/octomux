/**
 * server/api.runs.test.ts
 *
 * Replaces server/api.loops.test.ts and server/api.loop-groups.test.ts
 * (both deleted) — the 10 loop/loop-group routes collapsed into the 5
 * generic `runs` routes (see server/routes/runs.ts's module doc).
 * `POST /api/runs/:id/emit`'s coverage lives in
 * server/registry/capabilities/run.test.ts (it's a capability now, not a
 * hand-written route) — this file covers the 4 that stayed hand-written,
 * plus the run-adoption fix proof.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb, insertTask, insertAgent } from './test-helpers.js';
import { createLoopRun, appendIteration } from './repositories/loop-runs.js';

vi.mock('./task-engine/index.js', async () => {
  const { getDb } = await import('./db.js');
  const { insertAgent: insertAgentHelper } = await import('./test-helpers.js');
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
      insertAgentHelper(db, {
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

vi.mock('./repositories/orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./repositories/orchestrator.js')>();
  return { ...actual, isOrchestratorManaged: vi.fn(() => false) };
});
vi.mock('./orchestrator/runner.js', () => ({ mcpServerInvocation: vi.fn(() => null) }));
vi.mock('./hook-base-url.js', () => ({ hookBaseUrl: vi.fn(() => 'http://127.0.0.1:7777') }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('./skills.js', () => ({
  listSkills: vi.fn(async () => []),
  getSkill: vi.fn(async () => null),
}));
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

const VALID_GROUP_SPEC = { prompt: 'improve X', verify: 'true', maxIterations: 3 };

describe('runs API — loop/loop-group surface', () => {
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

  describe('POST /api/runs — workflowKind: loop', () => {
    it('creates and starts a loop run, and it appears in GET /api/runs (adoption fix)', async () => {
      const res = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop',
          taskId: 't1',
          spec: { prompt: 'do the thing', verify: 'echo ok', maxIterations: 5 },
        });

      expect(res.status).toBe(201);
      expect(res.body.workflow_kind).toBe('loop');
      expect(res.body.loop).toBeTruthy();
      expect(res.body.loop.task_id).toBe('t1');
      expect(res.body.loop.status).toBe('running');
      expect(res.body.loopGroup).toBeNull();

      const task = db.prepare('SELECT runtime_state FROM tasks WHERE id = ?').get('t1') as {
        runtime_state: string;
      };
      expect(task.runtime_state).toBe('looping');

      // The adoption fix in question: a manually-started loop (POST /api/runs
      // before this fix would never have written a `runs` row at all) now
      // shows up in the unified feed.
      const listRes = await request(app).get('/api/runs?kind=loop');
      expect(listRes.status).toBe(200);
      expect(listRes.body.runs).toHaveLength(1);
      expect(listRes.body.runs[0].id).toBe(res.body.id);
    });

    it('rejects a missing taskId with 400', async () => {
      const res = await request(app)
        .post('/api/runs')
        .send({ workflowKind: 'loop', spec: { prompt: 'x', verify: 'y', maxIterations: 5 } });
      expect(res.status).toBe(400);
    });

    it('rejects a missing spec.verify with 400', async () => {
      const res = await request(app)
        .post('/api/runs')
        .send({ workflowKind: 'loop', taskId: 't1', spec: { prompt: 'x', maxIterations: 5 } });
      expect(res.status).toBe(400);
    });

    it('returns 404 for an unknown task', async () => {
      const res = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop',
          taskId: 'nope',
          spec: { prompt: 'x', verify: 'y', maxIterations: 5 },
        });
      expect(res.status).toBe(404);
    });

    it('returns 400 when the task has no active agent, and does not orphan a runs row', async () => {
      db.prepare(`UPDATE workers SET status = 'stopped' WHERE id = 'a1'`).run();
      const res = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop',
          taskId: 't1',
          spec: { prompt: 'x', verify: 'y', maxIterations: 5 },
        });
      expect(res.status).toBe(400);

      const rows = db.prepare(`SELECT status FROM runs WHERE task_id = 't1'`).all() as Array<{
        status: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('failed');
    });

    it('returns 409 when the task already has an active loop run', async () => {
      createLoopRun({ task_id: 't1', spec_json: '{}' });
      db.prepare(`UPDATE tasks SET runtime_state = 'looping' WHERE id = 't1'`).run();

      const res = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop',
          taskId: 't1',
          spec: { prompt: 'do the thing', verify: 'echo ok', maxIterations: 5 },
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already has an active loop run/);
    });
  });

  describe('POST /api/runs — workflowKind: loop-group', () => {
    it('creates n candidates sharing one group, and it appears in GET /api/runs (adoption fix)', async () => {
      const res = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop-group',
          repoPath: '/repo',
          baseBranch: 'main',
          spec: VALID_GROUP_SPEC,
          n: 3,
        });

      expect(res.status).toBe(201);
      expect(res.body.workflow_kind).toBe('loop-group');
      expect(res.body.loop).toBeNull();
      expect(res.body.loopGroup).toBeTruthy();
      expect(res.body.loopGroup.candidates).toHaveLength(3);
      const groupIds = new Set(
        res.body.loopGroup.candidates.map((r: { group_id: string }) => r.group_id),
      );
      expect(groupIds.size).toBe(1);

      // The group itself AND each of its 3 candidates got their own runs row.
      const listRes = await request(app).get('/api/runs');
      expect(
        listRes.body.runs.filter(
          (r: { workflow_kind: string }) => r.workflow_kind === 'loop-group',
        ),
      ).toHaveLength(1);
      expect(
        listRes.body.runs.filter((r: { workflow_kind: string }) => r.workflow_kind === 'loop'),
      ).toHaveLength(3);
    });

    it('rejects n outside [2, 8]', async () => {
      const res = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop-group',
          repoPath: '/repo',
          baseBranch: 'main',
          spec: VALID_GROUP_SPEC,
          n: 1,
        });
      expect(res.status).toBe(400);
    });

    it('rejects a missing repoPath with 400', async () => {
      const res = await request(app)
        .post('/api/runs')
        .send({ workflowKind: 'loop-group', baseBranch: 'main', spec: VALID_GROUP_SPEC, n: 3 });
      expect(res.status).toBe(400);
    });

    it('rejects a missing spec.verify with 400', async () => {
      const res = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop-group',
          repoPath: '/repo',
          baseBranch: 'main',
          spec: { prompt: 'x', maxIterations: 3 },
          n: 3,
        });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/runs — workflowKind: judge', () => {
    it('409s while any candidate is still running', async () => {
      const createRes = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop-group',
          repoPath: '/repo',
          baseBranch: 'main',
          spec: VALID_GROUP_SPEC,
          n: 2,
        });

      const res = await request(app)
        .post('/api/runs')
        .send({ workflowKind: 'judge', runId: createRes.body.id });
      expect(res.status).toBe(409);
    });

    it('202s and flips judge_status to running once all candidates are terminal', async () => {
      const createRes = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop-group',
          repoPath: '/repo',
          baseBranch: 'main',
          spec: VALID_GROUP_SPEC,
          n: 2,
        });
      db.prepare(
        `UPDATE loop_runs SET status = 'done' WHERE group_id IN (SELECT id FROM loop_groups WHERE run_id = ?)`,
      ).run(createRes.body.id);

      const res = await request(app)
        .post('/api/runs')
        .send({ workflowKind: 'judge', runId: createRes.body.id });

      expect(res.status).toBe(202);
      expect(res.body.loopGroup.judge_status).toBe('running');
    });

    it('returns 404 for an unknown run id', async () => {
      const res = await request(app)
        .post('/api/runs')
        .send({ workflowKind: 'judge', runId: 'nope' });
      expect(res.status).toBe(404);
    });

    it('rejects launching judge against a non-loop-group run with 400', async () => {
      const createRes = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop',
          taskId: 't1',
          spec: { prompt: 'x', verify: 'y', maxIterations: 5 },
        });

      const res = await request(app)
        .post('/api/runs')
        .send({ workflowKind: 'judge', runId: createRes.body.id });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/runs — bad workflowKind', () => {
    it('rejects an unrecognized workflowKind with 400', async () => {
      const res = await request(app).post('/api/runs').send({ workflowKind: 'nonsense' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/runs/:id', () => {
    it('returns a loop run with its iterations nested under `loop`', async () => {
      const run = createLoopRun({ task_id: 't1', spec_json: '{}' });
      appendIteration(run.id, { sha_from: 'a1', sha_to: 'a2' });
      appendIteration(run.id, { sha_from: 'a2', sha_to: 'a3' });
      const { insertRun } = await import('./repositories/runs.js');
      const runsRow = insertRun({
        workflowKind: 'loop',
        trigger: 'manual',
        taskId: 't1',
        loopRunId: run.id,
      });

      const res = await request(app).get(`/api/runs/${runsRow.id}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(runsRow.id);
      expect(res.body.loop.id).toBe(run.id);
      expect(res.body.loop.iterations).toHaveLength(2);
      expect(res.body.loopGroup).toBeNull();
    });

    it('returns a loop-group run with its candidates + judge verdict nested under `loopGroup`', async () => {
      const createRes = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop-group',
          repoPath: '/repo',
          baseBranch: 'main',
          spec: VALID_GROUP_SPEC,
          n: 2,
        });

      const res = await request(app).get(`/api/runs/${createRes.body.id}`);

      expect(res.status).toBe(200);
      expect(res.body.loop).toBeNull();
      expect(res.body.loopGroup.candidates).toHaveLength(2);
      expect(res.body.loopGroup.judge_status).toBe('not_run');
    });

    it('returns 404 for an unknown run id', async () => {
      const res = await request(app).get('/api/runs/does-not-exist');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/runs/:id/stop', () => {
    it('terminates a running loop and idles the task', async () => {
      const createRes = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop',
          taskId: 't1',
          spec: { prompt: 'x', verify: 'y', maxIterations: 5 },
        });

      const res = await request(app).post(`/api/runs/${createRes.body.id}/stop`);

      expect(res.status).toBe(200);
      expect(res.body.loop.status).toBe('needs_human');
      expect(res.body.loop.termination_reason).toBe('stopped');
      expect(res.body.status).toBe('blocked');

      const task = db.prepare('SELECT runtime_state FROM tasks WHERE id = ?').get('t1') as {
        runtime_state: string;
      };
      expect(task.runtime_state).toBe('idle');
    });

    it('is a no-op for an already-terminated loop', async () => {
      const createRes = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop',
          taskId: 't1',
          spec: { prompt: 'x', verify: 'y', maxIterations: 5 },
        });
      await request(app).post(`/api/runs/${createRes.body.id}/stop`);

      const res = await request(app).post(`/api/runs/${createRes.body.id}/stop`);
      expect(res.status).toBe(200);
      expect(res.body.loop.termination_reason).toBe('stopped');
    });

    it('stops every running candidate of a loop-group run', async () => {
      const createRes = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop-group',
          repoPath: '/repo',
          baseBranch: 'main',
          spec: VALID_GROUP_SPEC,
          n: 2,
        });

      const res = await request(app).post(`/api/runs/${createRes.body.id}/stop`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('blocked');
      for (const candidate of res.body.loopGroup.candidates) {
        expect(candidate.status).toBe('needs_human');
        expect(candidate.termination_reason).toBe('stopped');
      }
    });

    it('returns 404 for an unknown run id', async () => {
      const res = await request(app).post('/api/runs/does-not-exist/stop');
      expect(res.status).toBe(404);
    });
  });

  // `run.emit` is a registry capability (server/registry/capabilities/run.ts),
  // not a hand-written route — mounted via mountCapabilityRoutes inside
  // createApp(), same as POST /api/learnings. Full HTTP-level coverage here
  // mirrors api.learnings.test.ts's pattern for its own bearer-gated routes;
  // handler-level behavior + shape assertions live in
  // server/registry/capabilities/run.test.ts.
  describe('POST /api/runs/:id/emit', () => {
    it('persists a valid loop-backed emit and returns 200 with `loop` populated', async () => {
      const createRes = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop',
          taskId: 't1',
          spec: { prompt: 'x', verify: 'y', maxIterations: 5 },
        });

      const res = await request(app)
        .post(`/api/runs/${createRes.body.id}/emit`)
        .set('Authorization', 'Bearer tok-loop')
        .send({ status: 'done', reason: 'all good' });

      expect(res.status).toBe(200);
      expect(res.body.loop.status).toBe('done');
      expect(res.body.loop.termination_reason).toBe('all good');
    });

    it('rejects an invalid status enum with 400', async () => {
      const createRes = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop',
          taskId: 't1',
          spec: { prompt: 'x', verify: 'y', maxIterations: 5 },
        });

      const res = await request(app)
        .post(`/api/runs/${createRes.body.id}/emit`)
        .set('Authorization', 'Bearer tok-loop')
        .send({ status: 'finished', reason: 'x' });

      expect(res.status).toBe(400);
    });

    it('rejects a missing token with 401', async () => {
      const createRes = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop',
          taskId: 't1',
          spec: { prompt: 'x', verify: 'y', maxIterations: 5 },
        });

      const res = await request(app)
        .post(`/api/runs/${createRes.body.id}/emit`)
        .send({ status: 'done', reason: 'x' });

      expect(res.status).toBe(401);
    });

    it('returns 404 for an unknown run id', async () => {
      const res = await request(app)
        .post('/api/runs/does-not-exist/emit')
        .set('Authorization', 'Bearer tok-loop')
        .send({ status: 'done', reason: 'x' });

      expect(res.status).toBe(404);
    });

    it('records exactly one judge verdict for a loop-group run and finishes it', async () => {
      const createRes = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop-group',
          repoPath: '/repo',
          baseBranch: 'main',
          spec: VALID_GROUP_SPEC,
          n: 2,
        });
      const [runA, runB] = createRes.body.loopGroup.candidates;
      db.prepare(`UPDATE loop_runs SET status = 'done' WHERE id IN (?, ?)`).run(runA.id, runB.id);

      const agentRow = db.prepare('SELECT hook_token FROM workers LIMIT 1').get() as {
        hook_token: string;
      };

      const res = await request(app)
        .post(`/api/runs/${createRes.body.id}/emit`)
        .set('Authorization', `Bearer ${agentRow.hook_token}`)
        .send({ winnerLoopRunId: runA.id, rationale: 'Candidate A had a cleaner diff.' });

      expect(res.status).toBe(200);
      expect(res.body.loopGroup.judge_status).toBe('done');
      expect(res.body.loopGroup.winner_loop_run_id).toBe(runA.id);
      expect(res.body.status).toBe('done');

      const untouchedB = db.prepare('SELECT status FROM loop_runs WHERE id = ?').get(runB.id) as {
        status: string;
      };
      expect(untouchedB.status).toBe('done');
    });

    it('rejects a winnerLoopRunId that is not a member of the group with 400', async () => {
      const createRes = await request(app)
        .post('/api/runs')
        .send({
          workflowKind: 'loop-group',
          repoPath: '/repo',
          baseBranch: 'main',
          spec: VALID_GROUP_SPEC,
          n: 2,
        });
      const agentRow = db.prepare('SELECT hook_token FROM workers LIMIT 1').get() as {
        hook_token: string;
      };

      const res = await request(app)
        .post(`/api/runs/${createRes.body.id}/emit`)
        .set('Authorization', `Bearer ${agentRow.hook_token}`)
        .send({ winnerLoopRunId: 'not-a-member', rationale: 'x' });

      expect(res.status).toBe(400);
    });
  });
});
