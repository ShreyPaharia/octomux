/**
 * Unit tests for the task-creation service (SHR-176).
 *
 * Covers:
 *  - happy path: a worktree row + a task row are created in one transaction,
 *    task:created is broadcast, and startTask is kicked for a non-draft task.
 *  - draft: startTask is NOT kicked.
 *  - UNIQUE constraint → ServiceError(409).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { getDb } from '../db.js';

// ─── Mock side-effecting deps (mirror orchestrator/exec.test.ts) ────────────

const mockStartTask = vi.fn().mockResolvedValue(undefined);
vi.mock('../task-engine/index.js', () => ({
  startTask: vi.fn((...args: unknown[]) => mockStartTask(...args)),
}));

const mockBroadcast = vi.fn();
vi.mock('../events.js', () => ({
  broadcast: vi.fn((...args: unknown[]) => mockBroadcast(...args)),
}));

// nanoid is mocked so the UNIQUE-collision test is deterministic. The default
// implementation returns unique ids; individual tests override per-call.
const mockNanoid = vi.fn();
vi.mock('nanoid', () => ({
  nanoid: (...args: unknown[]) => mockNanoid(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { createTask, type CreateTaskServiceInput } from './task-service.js';
import { ServiceError } from './errors.js';

let seq = 0;
function uniqueId(): string {
  return `id-${seq++}`;
}

function baseInput(overrides: Partial<CreateTaskServiceInput> = {}): CreateTaskServiceInput {
  return {
    resolved_title: 'Fix order validation',
    resolved_description: 'Add negative quantity checks',
    initial_prompt: 'do the thing',
    run_mode: 'new',
    stored_repo_path: '/tmp/test-repo',
    staged_path: '',
    branch: null,
    base_branch: null,
    worktree_status: 'available',
    runtime_state: 'idle',
    workflow_status: 'backlog',
    agent: null,
    harness_id: 'claude-code',
    model: null,
    notify_task_id: null,
    is_draft: false,
    ...overrides,
  };
}

describe('task-service.createTask', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
    seq = 0;
    mockNanoid.mockImplementation(() => uniqueId());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates a worktree row and a task row in one transaction', async () => {
    const task = await createTask(baseInput());

    const taskRow = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as {
      id: string;
      title: string;
      worktree_id: string;
    };
    expect(taskRow).toBeTruthy();
    expect(taskRow.title).toBe('Fix order validation');

    const wtRow = getDb()
      .prepare('SELECT * FROM worktrees WHERE id = ?')
      .get(taskRow.worktree_id) as { repo_path: string };
    expect(wtRow).toBeTruthy();
    expect(wtRow.repo_path).toBe('/tmp/test-repo');
  });

  it('broadcasts task:created exactly once', async () => {
    const task = await createTask(baseInput());
    expect(mockBroadcast).toHaveBeenCalledWith({
      type: 'task:created',
      payload: { taskId: task.id },
    });
  });

  it('kicks startTask for a non-draft task', async () => {
    const task = await createTask(baseInput({ is_draft: false }));
    expect(mockStartTask).toHaveBeenCalledTimes(1);
    expect(mockStartTask).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));
  });

  it('does NOT kick startTask for a draft task', async () => {
    await createTask(baseInput({ is_draft: true }));
    expect(mockStartTask).not.toHaveBeenCalled();
  });

  it('maps a UNIQUE constraint violation to ServiceError(409)', async () => {
    // Force both create calls to mint the SAME task id so the second insert
    // trips the tasks.id UNIQUE constraint inside the transaction.
    // Order of nanoid() calls per createTask: task id, then worktree id.
    mockNanoid
      .mockReturnValueOnce('dup-task') // 1st create: task id
      .mockReturnValueOnce('wt-1') // 1st create: worktree id
      .mockReturnValueOnce('dup-task') // 2nd create: task id (collision)
      .mockReturnValueOnce('wt-2'); // 2nd create: worktree id

    await createTask(baseInput());

    let caught: unknown;
    try {
      await createTask(baseInput());
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).status).toBe(409);
    expect((caught as ServiceError).message).toMatch(/UNIQUE constraint/);
  });
});
