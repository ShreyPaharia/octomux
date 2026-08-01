import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, insertTask } from '../test-helpers.js';

vi.mock('./task-service.js', () => ({ createTask: vi.fn() }));
vi.mock('../task-engine/loop/engine.js', () => ({ startLoop: vi.fn() }));

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
