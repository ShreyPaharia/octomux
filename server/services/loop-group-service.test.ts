import { describe, it, expect, vi, beforeEach } from '../bun-test.js';

vi.mock('./task-service.js', () => ({ createTask: vi.fn() }));
vi.mock('../task-engine/loop/engine.js', () => ({ startLoop: vi.fn() }));

const { createTestDb, insertTask } = await import('../test-helpers.js');

describe('loop-group-service', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createTestDb();
  });

  it('createLoopGroupWithCandidates creates N candidate tasks, waits for each to run, and starts a loop on each with the group id', async () => {
    const { createTask } = await import('./task-service.js');
    const { startLoop } = await import('../task-engine/loop/engine.js');
    const { createLoopGroupWithCandidates } = await import('./loop-group-service.js');

    let counter = 0;
    vi.mocked(createTask).mockImplementation(async () => {
      counter += 1;
      return insertTask(db, { id: `cand-${counter}`, runtime_state: 'running' });
    });
    vi.mocked(startLoop).mockImplementation(async (taskId, _spec, groupId) => ({
      id: `run-${taskId}`,
      task_id: taskId,
      spec_json: '{}',
      status: 'running',
      iteration: 0,
      max_iterations: 5,
      budget_json: null,
      termination_reason: null,
      group_id: groupId ?? null,
      created_at: '2026-01-01 00:00:00',
      updated_at: '2026-01-01 00:00:00',
    }));

    const { group, loopRuns } = await createLoopGroupWithCandidates({
      repoPath: '/repo',
      baseBranch: 'main',
      spec: { prompt: 'do it', verify: 'true', maxIterations: 5 },
      n: 3,
    });

    expect(createTask).toHaveBeenCalledTimes(3);
    expect(startLoop).toHaveBeenCalledTimes(3);
    expect(loopRuns).toHaveLength(3);
    expect(loopRuns.every((r) => r.group_id === group.id)).toBe(true);
  });

  // Adoption fix: this service used to never call insertRun, so a best-of-N
  // group and its candidates never showed up in GET /api/runs (see
  // routes/runs.ts's module doc). Every candidate's own `spec.runId` (threaded
  // into startLoop's 2nd arg) must resolve to a DIFFERENT runs row than the
  // group's own — each loop iterates and emits against its OWN run.
  it('adoption fix: creates one runs row for the group and one per candidate, linked via loop_groups.run_id', async () => {
    const { createTask } = await import('./task-service.js');
    const { startLoop } = await import('../task-engine/loop/engine.js');
    const { createLoopGroupWithCandidates } = await import('./loop-group-service.js');
    const { getLoopGroup } = await import('../repositories/loop-groups.js');

    let counter = 0;
    vi.mocked(createTask).mockImplementation(async () => {
      counter += 1;
      return insertTask(db, { id: `cand-${counter}`, runtime_state: 'running' });
    });
    vi.mocked(startLoop).mockImplementation(async (taskId, spec, groupId) => ({
      id: `loop-run-${taskId}`,
      task_id: taskId,
      spec_json: JSON.stringify(spec),
      status: 'running',
      iteration: 0,
      max_iterations: 5,
      budget_json: null,
      termination_reason: null,
      group_id: groupId ?? null,
      created_at: '2026-01-01 00:00:00',
      updated_at: '2026-01-01 00:00:00',
    }));

    const { group } = await createLoopGroupWithCandidates({
      repoPath: '/repo',
      baseBranch: 'main',
      spec: { prompt: 'do it', verify: 'true', maxIterations: 5 },
      n: 3,
    });

    const runsRows = db.prepare('SELECT * FROM runs ORDER BY started_at ASC').all() as Array<{
      id: string;
      workflow_kind: string;
      task_id: string | null;
    }>;
    const groupRuns = runsRows.filter((r) => r.workflow_kind === 'loop-group');
    const loopRuns = runsRows.filter((r) => r.workflow_kind === 'loop');
    expect(groupRuns).toHaveLength(1);
    expect(loopRuns).toHaveLength(3);
    expect(new Set(loopRuns.map((r) => r.task_id)).size).toBe(3);

    expect(getLoopGroup(group.id)?.run_id).toBe(groupRuns[0].id);

    // Every startLoop call got a DIFFERENT runId than the group's own.
    const specRunIds = vi.mocked(startLoop).mock.calls.map(([, spec]) => (spec as any).runId);
    expect(new Set(specRunIds).size).toBe(3);
    expect(specRunIds.every((id) => id !== groupRuns[0].id)).toBe(true);
  });

  it('createLoopGroupWithCandidates throws if a candidate task errors during setup', async () => {
    const { createTask } = await import('./task-service.js');
    const { createLoopGroupWithCandidates } = await import('./loop-group-service.js');

    vi.mocked(createTask).mockImplementation(async () =>
      insertTask(db, { id: 'errored-task', runtime_state: 'error', error: 'boom' }),
    );

    await expect(
      createLoopGroupWithCandidates({
        repoPath: '/repo',
        baseBranch: 'main',
        spec: { prompt: 'do it', verify: 'true', maxIterations: 5 },
        n: 1,
      }),
    ).rejects.toThrow(/boom/);
  });

  it('launchJudge throws 409 if any candidate is still running', async () => {
    const { createLoopGroup } = await import('../repositories/loop-groups.js');
    const { createLoopRun } = await import('../repositories/loop-runs.js');
    const { launchJudge } = await import('./loop-group-service.js');

    const task = insertTask(db, { id: 'still-running' });
    const group = createLoopGroup({
      spec_json: '{}',
      n: 1,
      repo_path: '/repo',
      base_branch: 'main',
    });
    createLoopRun({ task_id: task.id, spec_json: '{}', group_id: group.id });

    await expect(launchJudge(group.id)).rejects.toMatchObject({ status: 409 });
  });

  it('launchJudge creates a judge task once all candidates are terminal', async () => {
    const { createTask } = await import('./task-service.js');
    const { createLoopGroup } = await import('../repositories/loop-groups.js');
    const { createLoopRun, terminateLoopRun } = await import('../repositories/loop-runs.js');
    const { launchJudge } = await import('./loop-group-service.js');
    const { getLoopGroup } = await import('../repositories/loop-groups.js');

    vi.mocked(createTask).mockResolvedValue(insertTask(db, { id: 'judge-task' }));

    const task = insertTask(db, { id: 'done-candidate' });
    const group = createLoopGroup({
      spec_json: '{}',
      n: 1,
      repo_path: '/repo',
      base_branch: 'main',
    });
    const run = createLoopRun({ task_id: task.id, spec_json: '{}', group_id: group.id });
    terminateLoopRun(run.id, 'done', 'done');

    const updated = await launchJudge(group.id);
    expect(updated.judge_status).toBe('running');
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(getLoopGroup(group.id)?.judge_status).toBe('running');
  });
});

describe('buildJudgePrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createTestDb();
  });

  it('emits octomux judge-emit against the group.run_id, not loop_groups.id', async () => {
    const { createLoopGroup } = await import('../repositories/loop-groups.js');
    const { buildJudgePrompt } = await import('./loop-group-service.js');
    const { insertRun } = await import('../repositories/runs.js');

    // run_id is a real FK into `runs` (foreign_keys=ON — see db/schema.ts's applyPragmas).
    const runsRow = insertRun({ workflowKind: 'loop-group', trigger: 'manual' });
    const group = createLoopGroup({
      spec_json: JSON.stringify({ prompt: 'do it', verify: 'true', maxIterations: 5 }),
      n: 1,
      repo_path: '/repo',
      base_branch: 'main',
      run_id: runsRow.id,
    });

    const prompt = buildJudgePrompt(group, []);

    expect(prompt).toContain(`octomux judge-emit --group ${runsRow.id}`);
    expect(prompt).not.toContain(`--group ${group.id}`);
  });

  it('falls back to loop_groups.id when run_id is unset (pre-migration row)', async () => {
    const { createLoopGroup } = await import('../repositories/loop-groups.js');
    const { buildJudgePrompt } = await import('./loop-group-service.js');

    const group = createLoopGroup({
      spec_json: JSON.stringify({ prompt: 'do it', verify: 'true', maxIterations: 5 }),
      n: 1,
      repo_path: '/repo',
      base_branch: 'main',
    });

    const prompt = buildJudgePrompt(group, []);

    expect(prompt).toContain(`octomux judge-emit --group ${group.id}`);
  });
});
