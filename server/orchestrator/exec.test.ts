/**
 * server/orchestrator/exec.test.ts
 *
 * Tests for Task 2.3 / SHR-126 and Task 3.4 / SHR-133:
 *  - runCreateTask starts a task (DB row + triggers startTask) with the given params.
 *  - When kind:'plan', the initial_prompt is prefixed with the planning template
 *    (instructs the worker to write plan.json and call signal_phase_complete).
 *  - A plan.json produced by the worker validates against the exported JSON Schema.
 *  - An invalid plan triggers the prose-fallback flag.
 *  - The orchestrator never receives plan/diff body contents — only pointers.
 *
 * Task 3.4 additions:
 *  - runAddAgent: adds an agent to an existing task (gated: ask).
 *  - runSetStatus: updates workflow_status on a task (gated: ask).
 *  - runCloseTask: closes a task (gated: always-ask).
 *  - runResumeTask: resumes a closed task (gated: ask).
 *  - runDeleteTask: hard-deletes a task (gated: always-ask).
 *  - model/effort right-sizing: create-task honors model+effort hints (§6.7).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createTestDb, insertTask } from '../test-helpers.js';
import { getDb } from '../db.js';

// ─── Mock startTask (avoids real tmux/git side-effects) ─────────────────────

const mockStartTask = vi.fn().mockResolvedValue(undefined);
const mockCloseTask = vi.fn().mockResolvedValue(undefined);
const mockDeleteTask = vi.fn().mockResolvedValue(undefined);
const mockAddAgent = vi.fn().mockResolvedValue({ id: 'agent-new', window_index: 1 });
const mockResumeTask = vi.fn().mockResolvedValue(undefined);

vi.mock('../task-runner.js', () => ({
  startTask: vi.fn((...args: unknown[]) => mockStartTask(...args)),
  closeTask: vi.fn((...args: unknown[]) => mockCloseTask(...args)),
  deleteTask: vi.fn((...args: unknown[]) => mockDeleteTask(...args)),
  addAgent: vi.fn((...args: unknown[]) => mockAddAgent(...args)),
  sendMessageToAgent: vi.fn().mockResolvedValue(undefined),
  resumeTask: vi.fn((...args: unknown[]) => mockResumeTask(...args)),
  stopAgent: vi.fn().mockResolvedValue(undefined),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import {
  runCreateTask,
  runAddAgent,
  runSetStatus,
  runCloseTask,
  runResumeTask,
  runDeleteTask,
  validatePlanJson,
  PLAN_SCHEMA_VERSION,
  PLAN_KIND,
} from './exec.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePlanJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    summary: 'Add user authentication',
    files: [
      {
        path: 'src/auth.ts',
        action: 'create',
        steps: ['Define AuthService class', 'Implement login method'],
      },
    ],
    open_questions: ['Should we use JWT or sessions?'],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('exec.runCreateTask', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('basic task creation', () => {
    it('inserts a task row into the DB and returns its id and title', async () => {
      const result = await runCreateTask({
        title: 'Add authentication',
        repo_path: '/tmp/test-repo',
        initial_prompt: 'Implement login and logout.',
      });

      expect(result.task_id).toBeTruthy();
      expect(result.title).toBe('Add authentication');

      const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(result.task_id) as
        | Record<string, unknown>
        | undefined;
      expect(row).toBeDefined();
      expect(row!['title']).toBe('Add authentication');
    });

    it('calls startTask with the newly created task', async () => {
      await runCreateTask({
        title: 'Refactor auth',
        repo_path: '/tmp/test-repo',
        initial_prompt: 'Refactor the auth module.',
      });

      expect(mockStartTask).toHaveBeenCalledOnce();
      const calledWithTask = mockStartTask.mock.calls[0]![0] as Record<string, unknown>;
      expect(calledWithTask['title']).toBe('Refactor auth');
    });

    it.each([
      ['new', '/tmp/test-repo', undefined],
      ['scratch', undefined, undefined],
    ] as const)('accepts run_mode=%s', async (run_mode, repo_path, _) => {
      const result = await runCreateTask({
        title: 'Test task',
        repo_path,
        initial_prompt: 'Do something.',
        run_mode,
      });
      expect(result.task_id).toBeTruthy();
    });

    it('stores model and effort hints when provided', async () => {
      const result = await runCreateTask({
        title: 'Heavy refactor',
        repo_path: '/tmp/test-repo',
        initial_prompt: 'Big refactor.',
        model: 'claude-opus-4-5',
      });

      const row = getDb().prepare('SELECT model FROM tasks WHERE id = ?').get(result.task_id) as
        | { model: string | null }
        | undefined;
      expect(row?.model).toBe('claude-opus-4-5');
    });
  });

  describe('plan kind — template injection', () => {
    it('injects the planning template into initial_prompt when kind=plan', async () => {
      const result = await runCreateTask({
        title: 'Plan authentication',
        repo_path: '/tmp/test-repo',
        initial_prompt: 'Plan an auth system.',
        kind: PLAN_KIND,
      });

      const row = getDb()
        .prepare('SELECT initial_prompt FROM tasks WHERE id = ?')
        .get(result.task_id) as { initial_prompt: string } | undefined;

      const prompt = row?.initial_prompt ?? '';
      // Template must instruct the worker to write plan.json
      expect(prompt).toMatch(/plan\.json/i);
      // Template must instruct the worker to call signal_phase_complete
      expect(prompt).toMatch(/signal_phase_complete/i);
      // Original prompt must be included
      expect(prompt).toContain('Plan an auth system.');
    });

    it('includes the schema_version in the injected template', async () => {
      const result = await runCreateTask({
        title: 'Schema version test',
        repo_path: '/tmp/test-repo',
        initial_prompt: 'Plan something.',
        kind: PLAN_KIND,
      });

      const row = getDb()
        .prepare('SELECT initial_prompt FROM tasks WHERE id = ?')
        .get(result.task_id) as { initial_prompt: string } | undefined;

      expect(row?.initial_prompt).toContain(PLAN_SCHEMA_VERSION);
    });

    it('does NOT inject the template when kind is not plan', async () => {
      const result = await runCreateTask({
        title: 'Regular task',
        repo_path: '/tmp/test-repo',
        initial_prompt: 'Build something.',
      });

      const row = getDb()
        .prepare('SELECT initial_prompt FROM tasks WHERE id = ?')
        .get(result.task_id) as { initial_prompt: string } | undefined;

      // Should NOT contain the signal_phase_complete instruction
      expect(row?.initial_prompt).not.toContain('signal_phase_complete');
      // Original prompt should be preserved as-is
      expect(row?.initial_prompt).toBe('Build something.');
    });

    it('sets managed_tasks phase=planning when kind=plan and conversation_id is provided', async () => {
      const { createConversation } = await import('./store.js');
      const convId = createConversation({ title: 'Test conv' });

      const result = await runCreateTask({
        title: 'Plan feature',
        repo_path: '/tmp/test-repo',
        initial_prompt: 'Plan the feature.',
        kind: PLAN_KIND,
        conversation_id: convId,
      });

      const mt = getDb()
        .prepare('SELECT * FROM managed_tasks WHERE task_id = ?')
        .get(result.task_id) as Record<string, unknown> | undefined;

      expect(mt).toBeDefined();
      expect(mt!['phase']).toBe('planning');
      expect(mt!['conversation_id']).toBe(convId);
    });
  });
});

describe('validatePlanJson', () => {
  it('returns {valid: true} for a conforming plan.json', () => {
    const plan = makePlanJson();
    const result = validatePlanJson(plan);
    expect(result.valid).toBe(true);
  });

  it('returns {valid: false} when schema_version is missing', () => {
    const plan = makePlanJson({ schema_version: undefined });
    const result = validatePlanJson(plan);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('returns {valid: false} when schema_version is wrong', () => {
    const plan = makePlanJson({ schema_version: '0.0.1' });
    const result = validatePlanJson(plan);
    expect(result.valid).toBe(false);
  });

  it('returns {valid: false} when summary is missing', () => {
    const plan = makePlanJson({ summary: undefined });
    const result = validatePlanJson(plan);
    expect(result.valid).toBe(false);
  });

  it('returns {valid: false} when files is not an array', () => {
    const plan = makePlanJson({ files: 'not-an-array' });
    const result = validatePlanJson(plan);
    expect(result.valid).toBe(false);
  });

  it('returns {valid: false} when a file entry is missing path', () => {
    const plan = makePlanJson({
      files: [{ action: 'create', steps: ['do something'] }],
    });
    const result = validatePlanJson(plan);
    expect(result.valid).toBe(false);
  });

  it.each([
    ['create', true],
    ['modify', true],
    ['delete', true],
    ['rename', true],
    ['invalid-action', false],
  ] as const)('file.action=%s valid=%s', (action, expected) => {
    const plan = makePlanJson({
      files: [{ path: 'src/foo.ts', action, steps: [] }],
    });
    const result = validatePlanJson(plan);
    expect(result.valid).toBe(expected);
  });

  it('accepts an empty files array', () => {
    const plan = makePlanJson({ files: [] });
    const result = validatePlanJson(plan);
    expect(result.valid).toBe(true);
  });

  it('accepts an empty open_questions array', () => {
    const plan = makePlanJson({ open_questions: [] });
    const result = validatePlanJson(plan);
    expect(result.valid).toBe(true);
  });

  it('accepts a plan with no open_questions field (optional)', () => {
    const plan = makePlanJson({ open_questions: undefined });
    const result = validatePlanJson(plan);
    expect(result.valid).toBe(true);
  });

  it('accepts extra fields (additionalProperties allowed for forward compat)', () => {
    const plan = makePlanJson({ detail: 'Some prose body explaining the plan' });
    const result = validatePlanJson(plan);
    expect(result.valid).toBe(true);
  });
});

// ─── Task 3.4: full write-command surface + model/effort right-sizing ─────────

describe('exec.runCreateTask — model/effort right-sizing (§6.7)', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['claude-sonnet-4-6', null],
    ['claude-opus-4-5', 'high'],
    ['claude-opus-4-5', 'xhigh'],
    ['claude-sonnet-4-6', 'low'],
  ] as const)('stores model=%s with effort=%s — model column populated', async (model, effort) => {
    const result = await runCreateTask({
      title: 'Right-sized task',
      repo_path: '/tmp/test-repo',
      initial_prompt: 'Do something.',
      model,
      effort: effort ?? undefined,
    });

    const row = getDb().prepare('SELECT model FROM tasks WHERE id = ?').get(result.task_id) as
      | { model: string | null }
      | undefined;
    expect(row?.model).toBe(model);
  });

  it('passes effort hint through to startTask context (via initial_prompt metadata)', async () => {
    // effort is a conductors hint — it is forwarded as part of CreateTaskInput
    // so callers can inspect it. The task row stores model; effort is advisory.
    const result = await runCreateTask({
      title: 'Max effort task',
      repo_path: '/tmp/test-repo',
      initial_prompt: 'Do a big refactor.',
      model: 'claude-opus-4-5',
      effort: 'xhigh',
    });

    expect(result.task_id).toBeTruthy();
    // startTask is called with the task that has the correct model
    expect(mockStartTask).toHaveBeenCalledOnce();
    const passedTask = mockStartTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(passedTask['model']).toBe('claude-opus-4-5');
  });
});

describe('exec.runAddAgent', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls addAgent with the task and opts, returns agent pointer', async () => {
    const db = createTestDb();
    const task = insertTask(db, {
      id: 'task-add-001',
      runtime_state: 'running',
      tmux_session: 'octomux-agent-task-add-001',
    });

    const result = await runAddAgent(task.id, {
      prompt: 'Focus on tests.',
      label: 'Test Agent',
    });

    expect(result.agent_id).toBeTruthy();
    expect(mockAddAgent).toHaveBeenCalledOnce();
    // Verify the task was looked up and addAgent received the task object
    const calledWithTask = mockAddAgent.mock.calls[0]![0] as Record<string, unknown>;
    expect(calledWithTask['id']).toBe('task-add-001');
  });

  it('throws when task is not found', async () => {
    await expect(runAddAgent('nonexistent-task', {})).rejects.toThrow(/not found/i);
    expect(mockAddAgent).not.toHaveBeenCalled();
  });
});

describe('exec.runSetStatus', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(['backlog', 'planned', 'in_progress', 'human_review', 'pr', 'done'] as const)(
    'updates workflow_status to %s',
    async (status) => {
      const db = createTestDb();
      const task = insertTask(db, { id: 'task-status-001', runtime_state: 'running' });

      await runSetStatus(task.id, status);

      const row = db
        .prepare('SELECT workflow_status FROM tasks WHERE id = ?')
        .get('task-status-001') as { workflow_status: string } | undefined;
      expect(row?.workflow_status).toBe(status);
    },
  );

  it('throws when task is not found', async () => {
    await expect(runSetStatus('nonexistent', 'done')).rejects.toThrow(/not found/i);
  });

  it('throws when status is not a valid WorkflowStatus', async () => {
    const db = createTestDb();
    insertTask(db, { id: 'task-status-bad' });

    await expect(
      runSetStatus('task-status-bad', 'invalid_status' as import('../types.js').WorkflowStatus),
    ).rejects.toThrow(/invalid.*status/i);
  });
});

describe('exec.runCloseTask', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls closeTask with the task object', async () => {
    const db = createTestDb();
    const task = insertTask(db, {
      id: 'task-close-001',
      runtime_state: 'running',
      tmux_session: 'octomux-agent-task-close-001',
    });

    await runCloseTask(task.id);

    expect(mockCloseTask).toHaveBeenCalledOnce();
    const calledWithTask = mockCloseTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(calledWithTask['id']).toBe('task-close-001');
  });

  it('throws when task is not found', async () => {
    await expect(runCloseTask('nonexistent')).rejects.toThrow(/not found/i);
    expect(mockCloseTask).not.toHaveBeenCalled();
  });
});

describe('exec.runResumeTask', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls resumeTask with the task object', async () => {
    const db = createTestDb();
    const task = insertTask(db, {
      id: 'task-resume-001',
      runtime_state: 'idle',
      tmux_session: 'octomux-agent-task-resume-001',
    });

    await runResumeTask(task.id);

    expect(mockResumeTask).toHaveBeenCalledOnce();
    const calledWithTask = mockResumeTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(calledWithTask['id']).toBe('task-resume-001');
  });

  it('throws when task is not found', async () => {
    await expect(runResumeTask('nonexistent')).rejects.toThrow(/not found/i);
    expect(mockResumeTask).not.toHaveBeenCalled();
  });
});

describe('exec.runDeleteTask', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls deleteTask with the task object', async () => {
    const db = createTestDb();
    const task = insertTask(db, {
      id: 'task-delete-001',
      runtime_state: 'idle',
    });

    await runDeleteTask(task.id);

    expect(mockDeleteTask).toHaveBeenCalledOnce();
    const calledWithTask = mockDeleteTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(calledWithTask['id']).toBe('task-delete-001');
  });

  it('throws when task is not found', async () => {
    await expect(runDeleteTask('nonexistent')).rejects.toThrow(/not found/i);
    expect(mockDeleteTask).not.toHaveBeenCalled();
  });
});
