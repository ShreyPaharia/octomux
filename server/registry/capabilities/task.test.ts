import { afterEach, beforeEach, describe, expect, it, vi } from '../../bun-test.js';
import type Database from '../../sqlite.js';
import type { CapabilityContext } from '../types.js';

// ─── Mocks: every side-effecting boundary the handlers cross ──────────────────
//
// Mirrors the codebase's stated pattern (CLAUDE.md "Testing Patterns"): DB
// tests use real in-memory SQLite via createTestDb(); only OS/network-boundary
// calls (tmux, hook callbacks, webhooks, websocket pushes) get mocked.

vi.mock('../../task-engine/index.js', () => ({
  startTask: vi.fn().mockResolvedValue(undefined),
  closeTask: vi.fn().mockResolvedValue(undefined),
  resumeTask: vi.fn().mockResolvedValue(undefined),
  softDeleteTask: vi.fn().mockResolvedValue(undefined),
  deleteTask: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../events.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../hook-token.js', () => ({
  ensureHookToken: vi.fn().mockResolvedValue('backfilled-token'),
}));
vi.mock('../../hook-dispatcher.js', () => ({ fireHook: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../orchestrator/exec.js', (importOriginal) => {
  const actual = importOriginal<typeof import('../../orchestrator/exec.js')>();
  return { ...actual, runCloseTask: vi.fn().mockResolvedValue(undefined) };
});

const { getCapability, resetRegistry } = await import('../index.js');
const { createTestDb, insertTestTask, insertAgent, getTask } =
  await import('../../test-helpers.js');
const { registerTaskCapabilities } = await import('./task.js');
const { startTask, closeTask, resumeTask, softDeleteTask, deleteTask } =
  await import('../../task-engine/index.js');
const { broadcast } = await import('../../events.js');
const { ensureHookToken } = await import('../../hook-token.js');
const { fireHook } = await import('../../hook-dispatcher.js');
const { runCloseTask } = await import('../../orchestrator/exec.js');
const { upsertManagedTask } = await import('../../repositories/orchestrator.js');

const ctx: CapabilityContext = { caller: 'agent' };

let db: Database;

beforeEach(() => {
  db = createTestDb();
  resetRegistry();
  registerTaskCapabilities();
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

// ─── Registration + shape ──────────────────────────────────────────────────────

describe('registerTaskCapabilities', () => {
  it('registers all eight capabilities without throwing', () => {
    resetRegistry();
    expect(() => registerTaskCapabilities()).not.toThrow();
    for (const id of [
      'task.list',
      'task.get',
      'task.create',
      'task.start',
      'task.move',
      'task.rename',
      'task.close',
      'task.delete',
    ]) {
      expect(getCapability(id), `${id} should be registered`).toBeDefined();
    }
  });

  it.each([
    ['task.list', 'get', '/api/tasks', 'task list', 'list_tasks', 'auto'],
    ['task.get', 'get', '/api/tasks/:id', 'task get', 'get_task', 'auto'],
    ['task.create', 'post', '/api/tasks', 'task create', 'create_task', 'ask'],
    ['task.start', 'post', '/api/tasks/:id/start', 'task start', undefined, 'ask'],
    ['task.move', 'post', '/api/tasks/:id/move', 'task move', 'set_task_status', 'ask'],
    ['task.rename', 'post', '/api/tasks/:id/rename', 'task rename', 'rename_task', 'auto'],
    ['task.delete', 'delete', '/api/tasks/:id', 'task delete', 'delete_task', 'ask'],
  ] as const)('%s has the expected http/cli/mcp/tier shape', (id, method, path, cli, mcp, tier) => {
    const cap = getCapability(id)!;
    expect(cap.http?.method).toBe(method);
    expect(cap.http?.path).toBe(path);
    expect(cap.cli).toBe(cli);
    expect(cap.mcp).toBe(mcp);
    expect(cap.tier).toBe(tier);
  });

  // Behaviour preservation against the routes these replace: 201 at
  // routes/tasks.ts:253, 204 at routes/tasks.ts:348. Everything else is 200.
  it.each([
    ['task.create', 201],
    ['task.delete', 204],
    ['task.list', undefined],
    ['task.get', undefined],
    ['task.start', undefined],
    ['task.move', undefined],
    ['task.rename', undefined],
  ] as const)('%s declares success status %s', (id, status) => {
    expect(getCapability(id)!.http?.status).toBe(status);
  });

  // task.close deliberately deviates from the ticket's table (`cli: task close`):
  // server/registry/projections/cli.ts's generator proxies every CLI command
  // through the capability's own http route, and task.close has none (no
  // `POST /api/tasks/:id/close` route exists) — see module doc point 1.
  it('task.close has neither http nor cli (see task.ts module doc point 1)', () => {
    const cap = getCapability('task.close')!;
    expect(cap.http).toBeUndefined();
    expect(cap.cli).toBeUndefined();
    expect(cap.cliAliases).toBeUndefined();
    expect(cap.mcp).toBe('close_task');
    // 'auto', not 'always-ask': closing preserves the worktree and branch and
    // the session stays resumable, so there is nothing for a human to protect
    // against — and it is the most common write an agent makes.
    expect(cap.tier).toBe('auto');
  });

  it('task.delete raises itself to always-ask when purge is set', () => {
    // Soft-delete is reversible via the restore route, so it sits at 'ask' and
    // can be promoted to 'auto' with "always allow". purge:true is the
    // irreversible one — worktree removed, branch deleted, rows dropped — and
    // must never be reachable through a stored permission rule.
    const cap = getCapability('task.delete')!;
    expect(cap.tier).toBe('ask');
    expect(cap.tierFor).toBeDefined();
    expect(cap.tierFor!({ task_id: 't1' })).toBe('ask');
    expect(cap.tierFor!({ task_id: 't1', purge: false })).toBe('ask');
    expect(cap.tierFor!({ task_id: 't1', purge: true })).toBe('always-ask');
  });

  it.each([
    ['task.list', ['list-tasks']],
    ['task.get', ['get-task']],
    ['task.create', ['create-task']],
    ['task.move', ['task-move']],
    ['task.delete', ['delete-task']],
  ] as const)('%s carries the legacy alias %s', (id, aliases) => {
    expect(getCapability(id)!.cliAliases).toEqual(aliases);
  });

  it('task.start has no legacy alias (no prior flat CLI command existed)', () => {
    expect(getCapability('task.start')!.cliAliases).toBeUndefined();
  });
});

// ─── Handler delegation ─────────────────────────────────────────────────────────

describe('task.list', () => {
  it('returns the lean summary by default — no relations, no full task row', async () => {
    insertTestTask({ id: 't1', workflow_status: 'in_progress' });

    const cap = getCapability('task.list')!;
    const result = (await cap.handler({}, ctx)) as Array<Record<string, unknown>>;

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 't1',
      title: expect.any(String),
      runtime_state: expect.any(String),
      workflow_status: 'in_progress',
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(result[0]).not.toHaveProperty('workers');
    expect(result[0]).not.toHaveProperty('description');
  });

  it('expands to the full task row + requested relations via include', async () => {
    insertTestTask({ id: 't1', workflow_status: 'in_progress' });

    const cap = getCapability('task.list')!;
    const result = (await cap.handler(
      { include: 'workers,pending_prompts,user_terminals' },
      ctx,
    )) as Array<Record<string, unknown>>;

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 't1',
      workers: [],
      pending_prompts: [],
      user_terminals: [],
    });
    // pull_requests is never offered for list (would be an N+1) — see module doc point 6.
    expect(result[0]).not.toHaveProperty('pull_requests');
  });

  it('rejects an unknown include value', () => {
    // listTasksHandler is synchronous — parseInclude throws immediately rather
    // than returning a rejected promise (unlike task.get's async handler).
    // Needs a task in the DB — the empty-list short-circuit runs before include
    // is even parsed.
    insertTestTask({ id: 't1' });
    const cap = getCapability('task.list')!;
    expect(() => cap.handler({ include: 'pull_requests' }, ctx)).toThrow(/unknown include value/);
  });

  it('short-circuits to [] when there are no tasks', async () => {
    const cap = getCapability('task.list')!;
    expect(await cap.handler({}, ctx)).toEqual([]);
  });
});

describe('task.get', () => {
  it('returns the lean summary by default — no relations, no hook_token backfill', async () => {
    insertTestTask({ id: 't1' });
    insertAgent(db, { id: 'a1', task_id: 't1', hook_token: '' });

    const cap = getCapability('task.get')!;
    const result = (await cap.handler({ id: 't1' }, ctx)) as Record<string, unknown>;

    expect(result.id).toBe('t1');
    expect(result).toHaveProperty('agent_count', 1);
    expect(result).toHaveProperty('phase', null);
    expect(result).not.toHaveProperty('workers');
    expect(ensureHookToken).not.toHaveBeenCalled();
  });

  it('lean summary surfaces the managed phase (distinguishes paused-at-gate from working)', async () => {
    insertTestTask({ id: 't1', runtime_state: 'running' });
    db.prepare(`INSERT INTO orchestrator_conversations (id, title) VALUES ('conv-gt', 'c')`).run();
    upsertManagedTask({ conversation_id: 'conv-gt', task_id: 't1', phase: 'awaiting_approval' });

    const cap = getCapability('task.get')!;
    const result = (await cap.handler({ id: 't1' }, ctx)) as Record<string, unknown>;

    // runtime_state says 'running', but phase reveals it's paused for approval.
    expect(result.runtime_state).toBe('running');
    expect(result.phase).toBe('awaiting_approval');
  });

  it('expands to the full task row + workers via include=workers', async () => {
    insertTestTask({ id: 't1' });
    insertAgent(db, { id: 'a1', task_id: 't1', hook_token: 'has-a-token' });

    const cap = getCapability('task.get')!;
    const result = (await cap.handler({ id: 't1', include: 'workers' }, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.id).toBe('t1');
    expect(result.workers).toHaveLength(1);
    expect(ensureHookToken).not.toHaveBeenCalled();
  });

  it('throws notFound for a missing task', async () => {
    const cap = getCapability('task.get')!;
    await expect(cap.handler({ id: 'nope' }, ctx)).rejects.toThrow('Task not found');
  });

  it('rejects an unknown include value', async () => {
    insertTestTask({ id: 't1' });
    const cap = getCapability('task.get')!;
    await expect(cap.handler({ id: 't1', include: 'bogus' }, ctx)).rejects.toThrow(
      /unknown include value/,
    );
  });

  it('backfills an empty hook_token via ensureHookToken when include is non-empty', async () => {
    insertTestTask({ id: 't1' });
    insertAgent(db, { id: 'a1', task_id: 't1', hook_token: '' });

    const cap = getCapability('task.get')!;
    const result = (await cap.handler({ id: 't1', include: 'workers' }, ctx)) as {
      workers: Array<{ hook_token: string }>;
    };

    expect(ensureHookToken).toHaveBeenCalledTimes(1);
    expect(result.workers[0].hook_token).toBe('backfilled-token');
  });
});

describe('task.create', () => {
  it("delegates to the createTask service, returning its exact envelope (not runCreateTask's narrow shape)", async () => {
    const cap = getCapability('task.create')!;
    const result = (await cap.handler(
      { title: 'T', description: 'D', repo_path: '/tmp/repo', run_mode: 'none' },
      ctx,
    )) as Record<string, unknown>;

    // createTask() (task-service.ts) sets .workers/.user_terminals but NOT
    // pull_requests/pending_prompts/derived_status — see the doc comment on
    // createTaskHandler for why runCreateTask's { task_id, title } shape
    // would also be wrong here.
    expect(result).toMatchObject({ title: 'T', description: 'D' });
    expect(result).toHaveProperty('workers', []);
    expect(result).toHaveProperty('user_terminals', []);
    expect(result).not.toHaveProperty('task_id'); // not runCreateTask's shape
    expect(startTask).toHaveBeenCalledTimes(1); // not a draft — fires immediately
  });

  it('does not fire startTask for a draft', async () => {
    const cap = getCapability('task.create')!;
    await cap.handler(
      { title: 'T', description: 'D', repo_path: '/tmp/repo', run_mode: 'none', draft: true },
      ctx,
    );
    expect(startTask).not.toHaveBeenCalled();
  });

  it("reuses validateCreateTaskBody's rule: title+description XOR initial_prompt", async () => {
    const cap = getCapability('task.create')!;
    await expect(cap.handler({ repo_path: '/tmp/repo', run_mode: 'none' }, ctx)).rejects.toThrow(
      /title and description are required/,
    );
  });

  it('accepts depends_on, storing it and skipping startTask while the dependency is unmet', async () => {
    insertTestTask({ id: 'dep', workflow_status: 'in_progress' }); // not done yet
    const cap = getCapability('task.create')!;
    const result = (await cap.handler(
      {
        title: 'T',
        description: 'D',
        repo_path: '/tmp/repo',
        run_mode: 'none',
        depends_on: 'dep',
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result.depends_on).toBe('dep');
    expect(result.runtime_state).toBe('idle');
    expect(startTask).not.toHaveBeenCalled();
  });

  it('rejects create with a nonexistent depends_on task', async () => {
    const cap = getCapability('task.create')!;
    await expect(
      cap.handler(
        {
          title: 'T',
          description: 'D',
          repo_path: '/tmp/repo',
          run_mode: 'none',
          depends_on: 'ghost',
        },
        ctx,
      ),
    ).rejects.toThrow(/not found/);
  });
});

describe('task.start', () => {
  it('flips runtime_state, responds immediately, then fires startTask in the background', async () => {
    insertTestTask({ id: 't1', runtime_state: 'idle' });

    const cap = getCapability('task.start')!;
    const result = (await cap.handler({ id: 't1' }, ctx)) as { runtime_state: string };

    expect(result.runtime_state).toBe('setting_up');
    expect(startTask).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({ type: 'task:updated', payload: { taskId: 't1' } });
  });

  it('rejects a task that is not idle', async () => {
    insertTestTask({ id: 't1', runtime_state: 'running' });
    const cap = getCapability('task.start')!;
    await expect(cap.handler({ id: 't1' }, ctx)).rejects.toThrow('Only draft tasks can be started');
  });

  it('rejects starting a draft task whose depends_on has not reached done', async () => {
    insertTestTask({ id: 'dep', workflow_status: 'in_progress' });
    insertTestTask({ id: 't1', runtime_state: 'idle', depends_on: 'dep' });
    const cap = getCapability('task.start')!;
    await expect(cap.handler({ id: 't1' }, ctx)).rejects.toThrow(/waiting on depends_on/);
    expect(startTask).not.toHaveBeenCalled();
  });

  it('starts a draft task once its depends_on has reached done', async () => {
    insertTestTask({ id: 'dep', workflow_status: 'done' });
    insertTestTask({ id: 't1', runtime_state: 'idle', depends_on: 'dep' });
    const cap = getCapability('task.start')!;
    await cap.handler({ id: 't1' }, ctx);
    expect(startTask).toHaveBeenCalledTimes(1);
  });
});

describe('task.move', () => {
  it('closes the task first when moving to done, and writes a transition update', async () => {
    insertTestTask({ id: 't1', workflow_status: 'in_progress' });

    const cap = getCapability('task.move')!;
    const result = (await cap.handler({ id: 't1', workflow_status: 'done' }, ctx)) as {
      workflow_status: string;
    };

    expect(closeTask).toHaveBeenCalledTimes(1);
    expect(result.workflow_status).toBe('done');
    expect(fireHook).toHaveBeenCalledWith(
      'workflow_status_changed',
      expect.objectContaining({ event: 'workflow_status_changed' }),
    );
  });

  it('requires a note when moving to human_review', async () => {
    insertTestTask({ id: 't1', workflow_status: 'in_progress' });
    const cap = getCapability('task.move')!;
    await expect(cap.handler({ id: 't1', workflow_status: 'human_review' }, ctx)).rejects.toThrow(
      /note is required/,
    );
  });

  // ─── task.rename ───────────────────────────────────────────────────────────

  describe('task.rename', () => {
    const rename = (input: Record<string, unknown>) =>
      getCapability('task.rename')!.handler(input, ctx);

    // The reason this capability exists at all: applyDraftUpdates (the PATCH
    // path) refuses anything where runtime_state !== 'idle', so a running agent
    // could never rename the task it had just figured out.
    it.each(['running', 'setting_up', 'looping', 'error', 'idle'] as const)(
      'renames a task in runtime_state=%s',
      async (runtime_state) => {
        insertTestTask({ id: 't1', runtime_state, title: 'Investigate the flaky thing that' });
        await rename({ id: 't1', title: 'Fix auth token refresh race' });
        expect(getTask(db, 't1')!.title).toBe('Fix auth token refresh race');
      },
    );

    it.each([
      ['empty', ''],
      ['whitespace-only', '   \n\t '],
    ])('rejects a %s title', async (_label, title) => {
      insertTestTask({ id: 't1', title: 'Original' });
      await expect(rename({ id: 't1', title })).rejects.toThrow(/title cannot be empty/);
      expect(getTask(db, 't1')!.title).toBe('Original');
    });

    it('404s on an unknown id', async () => {
      await expect(rename({ id: 'nope', title: 'x' })).rejects.toThrow(/Task not found/);
    });

    it('trims and truncates at 80 chars, matching the create-time title cap', async () => {
      insertTestTask({ id: 't1' });
      await rename({ id: 't1', title: `  ${'a'.repeat(120)}  ` });
      expect(getTask(db, 't1')!.title).toBe('a'.repeat(80));
    });

    it('leaves the existing description alone when description is omitted', async () => {
      insertTestTask({ id: 't1', description: 'Keep me' });
      await rename({ id: 't1', title: 'New title' });
      expect(getTask(db, 't1')!.description).toBe('Keep me');
    });

    it('updates the description when one is given', async () => {
      insertTestTask({ id: 't1', description: 'Old' });
      await rename({ id: 't1', title: 'New title', description: '  New summary  ' });
      expect(getTask(db, 't1')!.description).toBe('New summary');
    });

    it('rejects a blank description rather than wiping the existing one', async () => {
      insertTestTask({ id: 't1', description: 'Keep me' });
      await expect(rename({ id: 't1', title: 'New title', description: '  ' })).rejects.toThrow(
        /description cannot be empty/,
      );
      expect(getTask(db, 't1')!.description).toBe('Keep me');
    });

    it('broadcasts task:updated so open boards repaint', async () => {
      insertTestTask({ id: 't1' });
      await rename({ id: 't1', title: 'New title' });
      expect(broadcast).toHaveBeenCalledWith({
        type: 'task:updated',
        payload: { taskId: 't1' },
      });
    });
  });

  it('auto-resumes via resumeTask when moving an idle task with a worktree to in_progress', async () => {
    insertTestTask({ id: 't1', workflow_status: 'backlog', runtime_state: 'idle' });
    const cap = getCapability('task.move')!;
    await cap.handler({ id: 't1', workflow_status: 'in_progress' }, ctx);
    expect(resumeTask).toHaveBeenCalledTimes(1);
    expect(startTask).not.toHaveBeenCalled();
  });

  // ─── depends_on: cycle safety + enforcement ────────────────────────────────

  it('rejects setting depends_on to itself', async () => {
    insertTestTask({ id: 't1', workflow_status: 'in_progress' });
    const cap = getCapability('task.move')!;
    await expect(
      cap.handler({ id: 't1', workflow_status: 'in_progress', depends_on: 't1' }, ctx),
    ).rejects.toThrow(/cannot depend on itself/);
  });

  it('rejects a depends_on cycle (t2 already depends on t1)', async () => {
    insertTestTask({ id: 't1', workflow_status: 'in_progress' });
    insertTestTask({ id: 't2', workflow_status: 'in_progress' });
    const cap = getCapability('task.move')!;

    await cap.handler({ id: 't2', workflow_status: 'in_progress', depends_on: 't1' }, ctx);

    await expect(
      cap.handler({ id: 't1', workflow_status: 'in_progress', depends_on: 't2' }, ctx),
    ).rejects.toThrow(/cycle/);
  });

  it('rejects setting depends_on to a nonexistent task', async () => {
    insertTestTask({ id: 't1', workflow_status: 'in_progress' });
    const cap = getCapability('task.move')!;
    await expect(
      cap.handler({ id: 't1', workflow_status: 'in_progress', depends_on: 'ghost' }, ctx),
    ).rejects.toThrow(/not found/);
  });

  it('does NOT auto-start a task moved to in_progress while its depends_on is unmet', async () => {
    insertTestTask({ id: 'dep', workflow_status: 'in_progress' }); // not done
    insertTestTask({
      id: 't1',
      workflow_status: 'backlog',
      runtime_state: 'idle',
      depends_on: 'dep',
    });
    const cap = getCapability('task.move')!;
    await cap.handler({ id: 't1', workflow_status: 'in_progress' }, ctx);
    expect(startTask).not.toHaveBeenCalled();
    expect(resumeTask).not.toHaveBeenCalled();
  });

  it('auto-starts a task moved to in_progress once its depends_on has reached done', async () => {
    insertTestTask({ id: 'dep', workflow_status: 'done' });
    insertTestTask({
      id: 't1',
      workflow_status: 'backlog',
      runtime_state: 'idle',
      depends_on: 'dep',
      worktree: null,
    });
    const cap = getCapability('task.move')!;
    await cap.handler({ id: 't1', workflow_status: 'in_progress' }, ctx);
    expect(startTask).toHaveBeenCalledTimes(1);
  });

  it('unblocks a waiting dependent when its dependency moves to done', async () => {
    insertTestTask({ id: 'dep', workflow_status: 'in_progress' });
    insertTestTask({
      id: 'blocked',
      workflow_status: 'in_progress',
      runtime_state: 'idle',
      depends_on: 'dep',
    });
    const cap = getCapability('task.move')!;
    await cap.handler({ id: 'dep', workflow_status: 'done' }, ctx);
    // 'blocked' carries the default fixture's worktree, so it resumes rather than starts fresh.
    expect(resumeTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'blocked' }));
  });
});

describe('task.close', () => {
  it('delegates to runCloseTask', async () => {
    const cap = getCapability('task.close')!;
    const result = await cap.handler({ task_id: 't1' }, ctx);

    expect(runCloseTask).toHaveBeenCalledWith('t1');
    expect(result).toEqual({ task_id: 't1' });
  });
});

describe('task.delete', () => {
  it('soft-deletes by default via the task-engine softDeleteTask', async () => {
    insertTestTask({ id: 't1' });
    const cap = getCapability('task.delete')!;
    const result = await cap.handler({ id: 't1' }, ctx);

    expect(softDeleteTask).toHaveBeenCalledTimes(1);
    expect(deleteTask).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 't1', purged: false });
  });

  it('rejects purge=true on a task that was never soft-deleted', async () => {
    insertTestTask({ id: 't1' });
    const cap = getCapability('task.delete')!;
    await expect(cap.handler({ id: 't1', purge: 'true' }, ctx)).rejects.toThrow(
      /must be soft-deleted before purge/,
    );
  });

  it('hard-deletes via deleteTask when purge=true on an already-soft-deleted task', async () => {
    insertTestTask({ id: 't1' });
    db.prepare("UPDATE tasks SET deleted_at = datetime('now') WHERE id = ?").run('t1');

    const cap = getCapability('task.delete')!;
    const result = await cap.handler({ id: 't1', purge: 'true' }, ctx);

    expect(deleteTask).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: 't1', purged: true });
  });

  it('throws notFound for a missing task', async () => {
    const cap = getCapability('task.delete')!;
    await expect(cap.handler({ id: 'nope' }, ctx)).rejects.toThrow('Task not found');
  });
});
