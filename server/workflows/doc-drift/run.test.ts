import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createTestDb } from '../../test-helpers.js';
import { getDb } from '../../db.js';

const mockStartTask = vi.fn();
vi.mock('../../task-engine/index.js', () => ({
  startTask: vi.fn((...args: unknown[]) => mockStartTask(...args)),
}));

const mockStartLoop = vi.fn().mockResolvedValue(undefined);
vi.mock('../../task-engine/loop/engine.js', () => ({
  startLoop: vi.fn((...args: unknown[]) => mockStartLoop(...args)),
}));

const mockBroadcast = vi.fn();
vi.mock('../../events.js', () => ({
  broadcast: vi.fn((...args: unknown[]) => mockBroadcast(...args)),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { createDocDriftTaskFromSchedule } from './run.js';
import { setRuntimeState } from '../../repositories/tasks.js';
import { listRunsForWorkflow } from '../../repositories/runs.js';
import type { RunResult } from '../../types.js';

function insertActiveAgent(taskId: string): void {
  getDb()
    .prepare(
      `INSERT INTO agents (id, task_id, window_index, label, status, harness_id, hook_token)
       VALUES (?, ?, 0, 'Agent 1', 'running', 'claude-code', 'tok')`,
    )
    .run(`${taskId}-agent`, taskId);
}

const DEFAULT_INPUT = {
  repoPath: '/repo',
  verify: 'test -n "$(git diff --name-only origin/HEAD... -- \'*.md\')" && bun run build',
  maxIterations: 4,
  baseBranch: 'main',
  branchPrefix: 'doc-drift',
};

describe('createDocDriftTaskFromSchedule', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
    mockStartTask.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: inserts a task, starts it, and starts the retry loop once a live agent exists', async () => {
    mockStartTask.mockImplementation(async (task: { id: string }) => {
      insertActiveAgent(task.id);
    });

    const result = await createDocDriftTaskFromSchedule(DEFAULT_INPUT);

    expect(result.task.source).toBe('doc_drift');
    expect(mockStartTask).toHaveBeenCalledTimes(1);
    expect(mockStartLoop).toHaveBeenCalledTimes(1);
    expect(mockStartLoop).toHaveBeenCalledWith(
      result.id,
      expect.objectContaining({
        verify: 'test -n "$(git diff --name-only origin/HEAD... -- \'*.md\')" && bun run build',
        maxIterations: 4,
        runId: expect.any(String),
      }),
      undefined,
      expect.any(String),
    );
  });

  it('stamps schedule_id on the task when scheduleId is passed', async () => {
    mockStartTask.mockImplementation(async (task: { id: string }) => {
      insertActiveAgent(task.id);
    });

    const result = await createDocDriftTaskFromSchedule({
      ...DEFAULT_INPUT,
      scheduleId: 'sched-1',
    });

    const row = getDb().prepare('SELECT schedule_id FROM tasks WHERE id = ?').get(result.id);
    expect(row).toEqual({ schedule_id: 'sched-1' });
  });

  it('records exactly one runs row linking the task, kind, trigger, and scheduleId', async () => {
    mockStartTask.mockImplementation(async (task: { id: string }) => {
      insertActiveAgent(task.id);
    });

    const result = await createDocDriftTaskFromSchedule({
      ...DEFAULT_INPUT,
      scheduleId: 'sched-1',
    });

    const rows = listRunsForWorkflow('doc-drift');
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe('cron');
    expect(rows[0].task_id).toBe(result.id);
    expect(rows[0].schedule_id).toBe('sched-1');
    expect(rows[0].loop_run_id).toEqual(expect.any(String));
  });

  it('branch name uses branchPrefix and baseBranch from input', async () => {
    mockStartTask.mockImplementation(async (task: { id: string }) => {
      insertActiveAgent(task.id);
    });

    const result = await createDocDriftTaskFromSchedule({
      ...DEFAULT_INPUT,
      branchPrefix: 'docs/fix',
      baseBranch: 'develop',
    });

    const row = getDb()
      .prepare(
        'SELECT wt.branch, wt.base_branch FROM tasks t JOIN worktrees wt ON wt.id = t.worktree_id WHERE t.id = ?',
      )
      .get(result.id) as { branch: string; base_branch: string };
    expect(row.branch).toMatch(/^docs\/fix\//);
    expect(row.base_branch).toBe('develop');
  });

  it('stamps model on the task row when model is provided', async () => {
    mockStartTask.mockImplementation(async (task: { id: string }) => {
      insertActiveAgent(task.id);
    });

    const result = await createDocDriftTaskFromSchedule({
      ...DEFAULT_INPUT,
      model: 'claude-opus-4-8',
    });

    const row = getDb().prepare('SELECT model FROM tasks WHERE id = ?').get(result.id) as {
      model: string | null;
    };
    expect(row.model).toBe('claude-opus-4-8');
  });

  it('leaves model null when no model is provided', async () => {
    mockStartTask.mockImplementation(async (task: { id: string }) => {
      insertActiveAgent(task.id);
    });

    const result = await createDocDriftTaskFromSchedule(DEFAULT_INPUT);

    const row = getDb().prepare('SELECT model FROM tasks WHERE id = ?').get(result.id) as {
      model: string | null;
    };
    expect(row.model).toBeNull();
  });

  it('does NOT call startLoop when startTask leaves the task in runtime_state=error, and finishes the run as failed', async () => {
    mockStartTask.mockImplementation(async (task: { id: string }) => {
      setRuntimeState(task.id, 'error', 'setup failed');
    });

    const result = await createDocDriftTaskFromSchedule(DEFAULT_INPUT);

    expect(mockStartTask).toHaveBeenCalledTimes(1);
    expect(mockStartLoop).not.toHaveBeenCalled();
    expect(result.id).toBeTruthy();

    const rows = listRunsForWorkflow('doc-drift');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].ended_at).not.toBeNull();
    const parsed = JSON.parse(rows[0].result_json!) as RunResult;
    expect(parsed.outcome).toBe('failed');
  });

  it('does NOT call startLoop when startTask resolves but no active agent exists, and finishes the run as failed', async () => {
    mockStartTask.mockResolvedValue(undefined); // resolves, no agent row inserted, no error state

    const result = await createDocDriftTaskFromSchedule(DEFAULT_INPUT);

    expect(mockStartTask).toHaveBeenCalledTimes(1);
    expect(mockStartLoop).not.toHaveBeenCalled();
    expect(result.id).toBeTruthy();

    const rows = listRunsForWorkflow('doc-drift');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
  });
});
