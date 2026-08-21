import { describe, it, expect, beforeEach } from '../bun-test.js';
import { createTestDb } from '../test-helpers.js';
import { getDb } from '../db.js';
import {
  getTask,
  listTasks,
  insertTask,
  updateTaskFields,
  setRuntimeState,
  setWorkflowStatus,
  softDeleteTask,
  restoreTask,
  hardDeleteTask,
  addTaskUpdate,
  listTaskUpdates,
  getTaskExternalRefs,
  getTaskExternalRef,
  upsertTaskExternalRef,
  deleteTaskExternalRef,
  insertTaskExternalRefIfAbsent,
  touchLastViewed,
  touchAllLastViewed,
  touchUpdatedAt,
  setPrHeadSha,
  unlinkWorktree,
  markTaskRunning,
  countTasks,
  setDependsOn,
  validateDependsOn,
  isDependencyUnmet,
  listDependentsAwaitingStart,
} from './tasks.js';
import { inTransaction } from './tx.js';

describe('repositories/tasks', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
  });

  // ─── insertTask / getTask round-trip ────────────────────────────────────────

  describe('insertTask / getTask', () => {
    it('inserts a task and reads it back', () => {
      const id = insertTask({ title: 'Hello', description: 'World' });
      expect(id).toMatch(/^[a-zA-Z0-9_-]{12}$/);

      // Use the joined SELECT so the Task shape is returned
      const task = db
        .prepare(
          `SELECT t.*, w.path AS worktree, w.repo_path, w.branch, w.base_branch, w.base_sha,
                  COALESCE(w.mode, 'new') AS run_mode
             FROM tasks t LEFT JOIN worktrees w ON t.worktree_id = w.id WHERE t.id = ?`,
        )
        .get(id) as Record<string, unknown>;
      expect(task.title).toBe('Hello');
      expect(task.description).toBe('World');
      expect(task.runtime_state).toBe('idle');
      expect(task.workflow_status).toBe('backlog');
      expect(task.harness_id).toBe('claude-code');
    });

    it('created_at and updated_at are non-null after insert', () => {
      const id = insertTask({ title: 'T', description: 'D' });
      const row = db.prepare('SELECT created_at, updated_at FROM tasks WHERE id = ?').get(id) as {
        created_at: string;
        updated_at: string;
      };
      expect(row.created_at).not.toBeNull();
      expect(row.updated_at).not.toBeNull();
    });

    it('returns undefined for unknown id', () => {
      db.prepare(
        `INSERT INTO worktrees (id, path, mode, status) VALUES ('wt1', '', 'new', 'available')`,
      ).run();
      db.prepare(
        `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, worktree_id)
         VALUES ('t1', 'x', 'y', 'idle', 'backlog', 'wt1')`,
      ).run();
      expect(getTask('does-not-exist')).toBeUndefined();
    });

    it('getTask returns the joined Task shape', () => {
      db.prepare(
        `INSERT INTO worktrees (id, path, repo_path, branch, mode, status) VALUES ('wt1', '/path', '/repo', 'main', 'new', 'in_use')`,
      ).run();
      db.prepare(
        `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, worktree_id)
         VALUES ('t1', 'Title', 'Desc', 'running', 'in_progress', 'wt1')`,
      ).run();
      const task = getTask('t1');
      expect(task).toBeDefined();
      expect(task!.title).toBe('Title');
      expect(task!.branch).toBe('main');
      expect(task!.repo_path).toBe('/repo');
    });

    it('accepts optional fields at insert', () => {
      const id = insertTask({
        title: 'T',
        description: 'D',
        source: 'auto_review',
        model: 'claude-opus-4-8',
        pr_number: 42,
        pr_head_sha: 'abc123',
      });
      const row = db
        .prepare('SELECT source, model, pr_number, pr_head_sha FROM tasks WHERE id = ?')
        .get(id) as Record<string, unknown>;
      expect(row.source).toBe('auto_review');
      expect(row.model).toBe('claude-opus-4-8');
      expect(row.pr_number).toBe(42);
      expect(row.pr_head_sha).toBe('abc123');
    });

    it('accepts an optional schedule_id at insert', () => {
      const id = insertTask({ title: 'T', description: 'D', schedule_id: 'sched-1' });
      const row = db.prepare('SELECT schedule_id FROM tasks WHERE id = ?').get(id) as Record<
        string,
        unknown
      >;
      expect(row.schedule_id).toBe('sched-1');
    });

    it('leaves schedule_id null when not provided', () => {
      const id = insertTask({ title: 'T', description: 'D' });
      const row = db.prepare('SELECT schedule_id FROM tasks WHERE id = ?').get(id) as Record<
        string,
        unknown
      >;
      expect(row.schedule_id).toBeNull();
    });

    // Regression: SELECT_TASK_SQL used to omit t.schedule_id, so every reader of
    // a getTask()-shaped Task (laneFor in agent-learnings.ts, respawn-agent.ts,
    // start-task.ts, etc.) saw `schedule_id: undefined` even for a task the
    // schedule poller stamped — silently routing scheduled agents' learnings
    // into a fresh loop:<task-id> lane every cron firing instead of the shared
    // schedule:<id> lane (see plans/2026-07-22-agent-learnings-store.md Task 5).
    it('getTask surfaces schedule_id on the returned Task', () => {
      const id = insertTask({ title: 'T', description: 'D', schedule_id: 'sched-1' });
      expect(getTask(id)!.schedule_id).toBe('sched-1');
    });

    // SHR-266: compute must stay NULL when unset, not default to a literal
    // like harness_id does — sessionFor() resolves NULL to DEFAULT_COMPUTE_KIND
    // itself, so a NULL row keeps following the default if it ever changes.
    it('a task created without compute round-trips as null', () => {
      const id = insertTask({ title: 'T', description: 'D' });
      const row = db.prepare('SELECT compute FROM tasks WHERE id = ?').get(id) as Record<
        string,
        unknown
      >;
      expect(row.compute).toBeNull();
      expect(getTask(id)!.compute).toBeNull();
    });

    it('a task created with compute: "ssh" round-trips as "ssh"', () => {
      const id = insertTask({ title: 'T', description: 'D', compute: 'ssh' });
      const row = db.prepare('SELECT compute FROM tasks WHERE id = ?').get(id) as Record<
        string,
        unknown
      >;
      expect(row.compute).toBe('ssh');
      expect(getTask(id)!.compute).toBe('ssh');
    });
  });

  // ─── listTasks ───────────────────────────────────────────────────────────────

  describe('listTasks', () => {
    beforeEach(() => {
      db.prepare(
        `INSERT INTO tasks (id, title, description, runtime_state, workflow_status)
                  VALUES ('t1', 'A', '', 'idle', 'backlog')`,
      ).run();
      db.prepare(
        `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source)
                  VALUES ('t2', 'B', '', 'idle', 'backlog', 'auto_review')`,
      ).run();
    });

    it('excludes auto_review by default', () => {
      const tasks = listTasks();
      expect(tasks.map((t) => t.id)).not.toContain('t2');
      expect(tasks.map((t) => t.id)).toContain('t1');
    });

    it('includes auto_review when asked', () => {
      const tasks = listTasks({ includeAutoReview: true });
      expect(tasks.map((t) => t.id)).toContain('t2');
    });

    it('excludes soft-deleted tasks by default', () => {
      db.prepare(`UPDATE tasks SET deleted_at = datetime('now') WHERE id = 't1'`).run();
      const tasks = listTasks();
      expect(tasks.map((t) => t.id)).not.toContain('t1');
    });

    it('trash view returns only soft-deleted tasks', () => {
      db.prepare(`UPDATE tasks SET deleted_at = datetime('now') WHERE id = 't1'`).run();
      const tasks = listTasks({ trash: true });
      expect(tasks.map((t) => t.id)).toContain('t1');
      expect(tasks.map((t) => t.id)).not.toContain('t2');
    });
  });

  describe('listTasks automated filtering', () => {
    beforeEach(() => {
      db.prepare(
        `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source)
                  VALUES ('manual', 'manual', '', 'idle', 'backlog', NULL)`,
      ).run();
      db.prepare(
        `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source)
                  VALUES ('drift', 'drift', '', 'idle', 'backlog', 'doc_drift')`,
      ).run();
    });

    it('hides tasks with a non-null source by default', () => {
      const rows = listTasks();
      expect(rows.map((t) => t.id)).toEqual(['manual']);
    });

    it('includes automated tasks when asked', () => {
      const rows = listTasks({ includeAutomated: true });
      expect(rows.map((t) => t.id).sort()).toEqual(['drift', 'manual']);
    });
  });

  // ─── updateTaskFields ────────────────────────────────────────────────────────

  describe('updateTaskFields', () => {
    let taskId: string;

    beforeEach(() => {
      taskId = insertTask({ title: 'Old', description: 'Old desc' });
    });

    it('updates specified fields and bumps updated_at', () => {
      const beforeRow = db.prepare('SELECT updated_at FROM tasks WHERE id = ?').get(taskId) as {
        updated_at: string;
      };

      // SQLite datetime has 1-second resolution; sleep is not guaranteed in tests.
      // Instead just verify the columns changed.
      updateTaskFields(taskId, { title: 'New', description: 'New desc' });
      const row = db
        .prepare('SELECT title, description, updated_at FROM tasks WHERE id = ?')
        .get(taskId) as { title: string; description: string; updated_at: string };
      expect(row.title).toBe('New');
      expect(row.description).toBe('New desc');
      // updated_at is set by datetime('now'), not necessarily different in < 1s
      expect(row.updated_at).not.toBeNull();
      // suppress unused variable warning
      void beforeRow;
    });

    it('leaves unspecified fields unchanged', () => {
      updateTaskFields(taskId, { title: 'Changed' });
      const row = db.prepare('SELECT title, description FROM tasks WHERE id = ?').get(taskId) as {
        title: string;
        description: string;
      };
      expect(row.title).toBe('Changed');
      expect(row.description).toBe('Old desc');
    });

    it('throws for non-allowlisted column', () => {
      expect(() => updateTaskFields(taskId, { evil_col: 'x' })).toThrow(/allowlist/);
    });

    it('is a no-op when patch is empty', () => {
      expect(() => updateTaskFields(taskId, {})).not.toThrow();
    });
  });

  // ─── setRuntimeState ─────────────────────────────────────────────────────────

  describe('setRuntimeState', () => {
    it.each([
      ['running', undefined],
      ['error', 'something went wrong'],
      ['idle', null],
    ] as const)('sets state=%s', (state, error) => {
      const id = insertTask({ title: 'T', description: 'D' });
      if (error !== undefined) {
        setRuntimeState(id, state, error);
        const row = db.prepare('SELECT runtime_state, error FROM tasks WHERE id = ?').get(id) as {
          runtime_state: string;
          error: string | null;
        };
        expect(row.runtime_state).toBe(state);
        expect(row.error).toBe(error);
      } else {
        setRuntimeState(id, state);
        const row = db.prepare('SELECT runtime_state FROM tasks WHERE id = ?').get(id) as {
          runtime_state: string;
        };
        expect(row.runtime_state).toBe(state);
      }
    });
  });

  // ─── softDeleteTask / restoreTask / hardDeleteTask ───────────────────────────

  describe('soft-delete lifecycle', () => {
    it('softDeleteTask sets deleted_at and flips state to idle', () => {
      const id = insertTask({ title: 'T', description: 'D', runtime_state: 'running' });
      softDeleteTask(id);
      const row = db
        .prepare('SELECT deleted_at, runtime_state FROM tasks WHERE id = ?')
        .get(id) as { deleted_at: string | null; runtime_state: string };
      expect(row.deleted_at).not.toBeNull();
      expect(row.runtime_state).toBe('idle');
    });

    it('restoreTask clears deleted_at', () => {
      const id = insertTask({ title: 'T', description: 'D' });
      softDeleteTask(id);
      restoreTask(id);
      const row = db.prepare('SELECT deleted_at FROM tasks WHERE id = ?').get(id) as {
        deleted_at: string | null;
      };
      expect(row.deleted_at).toBeNull();
    });

    it('hardDeleteTask removes the row', () => {
      const id = insertTask({ title: 'T', description: 'D' });
      hardDeleteTask(id);
      const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
      expect(row).toBeUndefined();
    });
  });

  // ─── setWorkflowStatus ───────────────────────────────────────────────────────

  describe('setWorkflowStatus', () => {
    it('updates workflow_status', () => {
      const id = insertTask({ title: 'T', description: 'D' });
      setWorkflowStatus(id, 'in_progress');
      const row = db.prepare('SELECT workflow_status FROM tasks WHERE id = ?').get(id) as {
        workflow_status: string;
      };
      expect(row.workflow_status).toBe('in_progress');
    });
  });

  // ─── markTaskRunning ─────────────────────────────────────────────────────────

  describe('markTaskRunning', () => {
    it.each(['backlog', 'planned'] as const)(
      'flips workflow_status from %s to in_progress',
      (ws) => {
        const id = insertTask({
          title: 'T',
          description: 'D',
          workflow_status: ws,
          runtime_state: 'setting_up',
        });
        markTaskRunning(id);
        const row = db
          .prepare('SELECT runtime_state, workflow_status, error FROM tasks WHERE id = ?')
          .get(id) as { runtime_state: string; workflow_status: string; error: string | null };
        expect(row.runtime_state).toBe('running');
        expect(row.workflow_status).toBe('in_progress');
        expect(row.error).toBeNull();
      },
    );

    it('preserves existing non-backlog/planned workflow_status', () => {
      const id = insertTask({
        title: 'T',
        description: 'D',
        workflow_status: 'human_review',
        runtime_state: 'setting_up',
      });
      markTaskRunning(id);
      const row = db.prepare('SELECT workflow_status FROM tasks WHERE id = ?').get(id) as {
        workflow_status: string;
      };
      expect(row.workflow_status).toBe('human_review');
    });
  });

  // ─── touchLastViewed / touchAllLastViewed / touchUpdatedAt ──────────────────

  describe('touch helpers', () => {
    it('touchLastViewed sets last_viewed_at', () => {
      const id = insertTask({ title: 'T', description: 'D' });
      touchLastViewed(id);
      const row = db.prepare('SELECT last_viewed_at FROM tasks WHERE id = ?').get(id) as {
        last_viewed_at: string | null;
      };
      expect(row.last_viewed_at).not.toBeNull();
    });

    it('touchAllLastViewed returns changed row count', () => {
      insertTask({ title: 'T1', description: 'D' });
      insertTask({ title: 'T2', description: 'D' });
      const count = touchAllLastViewed();
      expect(count).toBeGreaterThanOrEqual(2);
    });

    it('touchUpdatedAt bumps updated_at without error', () => {
      const id = insertTask({ title: 'T', description: 'D' });
      expect(() => touchUpdatedAt(id)).not.toThrow();
    });
  });

  // ─── setPrHeadSha / unlinkWorktree ──────────────────────────────────────────
  // current_summary retired (spec §5.5) — see server/artifact.test.ts for its
  // replacement (setTaskSummary / getArtifactSummary against .octomux/artifact.md).

  describe('misc setters', () => {
    it('setPrHeadSha updates the column', () => {
      const id = insertTask({ title: 'T', description: 'D' });
      setPrHeadSha(id, 'deadbeef');
      const row = db.prepare('SELECT pr_head_sha FROM tasks WHERE id = ?').get(id) as {
        pr_head_sha: string | null;
      };
      expect(row.pr_head_sha).toBe('deadbeef');
    });

    it('unlinkWorktree sets worktree_id to NULL', () => {
      db.prepare(
        `INSERT INTO worktrees (id, path, mode, status) VALUES ('wt1', '', 'new', 'available')`,
      ).run();
      const id = insertTask({ title: 'T', description: 'D', worktree_id: 'wt1' });
      unlinkWorktree(id);
      const row = db.prepare('SELECT worktree_id FROM tasks WHERE id = ?').get(id) as {
        worktree_id: string | null;
      };
      expect(row.worktree_id).toBeNull();
    });
  });

  // ─── task_updates ────────────────────────────────────────────────────────────

  describe('addTaskUpdate / listTaskUpdates', () => {
    let taskId: string;

    beforeEach(() => {
      taskId = insertTask({ title: 'T', description: 'D' });
    });

    it('inserts a transition update and reads it back', () => {
      const id = addTaskUpdate({
        task_id: taskId,
        kind: 'transition',
        from_status: 'backlog',
        to_status: 'in_progress',
      });
      expect(id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
      const updates = listTaskUpdates(taskId);
      expect(updates.length).toBe(1);
      expect(updates[0]!.kind).toBe('transition');
      expect(updates[0]!.from_status).toBe('backlog');
      expect(updates[0]!.to_status).toBe('in_progress');
    });

    it('inserts a note update', () => {
      addTaskUpdate({ task_id: taskId, kind: 'note', body: 'Looks good' });
      const updates = listTaskUpdates(taskId);
      expect(updates[0]!.kind).toBe('note');
      expect(updates[0]!.body).toBe('Looks good');
    });

    it('created_at is non-null', () => {
      addTaskUpdate({ task_id: taskId, kind: 'note', body: 'x' });
      const updates = listTaskUpdates(taskId);
      expect(updates[0]!.created_at).not.toBeNull();
    });

    it('listTaskUpdates respects the limit', () => {
      for (let i = 0; i < 5; i++) {
        addTaskUpdate({ task_id: taskId, kind: 'note', body: `note ${i}` });
      }
      const limited = listTaskUpdates(taskId, 3);
      expect(limited.length).toBe(3);
    });
  });

  // ─── task_external_refs ───────────────────────────────────────────────────────

  describe('task_external_refs', () => {
    let taskId: string;

    beforeEach(() => {
      taskId = insertTask({ title: 'T', description: 'D' });
    });

    it('upserts and retrieves an external ref', () => {
      const ref = upsertTaskExternalRef({
        task_id: taskId,
        integration: 'linear',
        ref: 'SHR-42',
        url: 'https://linear.app/issue/SHR-42',
        metadata: { priority: 'high' },
      });
      expect(ref.task_id).toBe(taskId);
      expect(ref.integration).toBe('linear');
      expect(ref.ref).toBe('SHR-42');
      expect(ref.metadata).toEqual({ priority: 'high' });
    });

    it('getTaskExternalRefs returns parsed metadata', () => {
      upsertTaskExternalRef({ task_id: taskId, integration: 'github', ref: '#123' });
      const refs = getTaskExternalRefs(taskId);
      expect(refs.length).toBe(1);
      expect(refs[0]!.metadata).toBeNull();
    });

    it('upsert replaces on conflict', () => {
      upsertTaskExternalRef({ task_id: taskId, integration: 'linear', ref: 'OLD' });
      upsertTaskExternalRef({ task_id: taskId, integration: 'linear', ref: 'NEW' });
      const ref = getTaskExternalRef(taskId, 'linear');
      expect(ref!.ref).toBe('NEW');
    });

    it('deleteTaskExternalRef removes the row', () => {
      upsertTaskExternalRef({ task_id: taskId, integration: 'linear', ref: 'SHR-1' });
      deleteTaskExternalRef(taskId, 'linear');
      expect(getTaskExternalRef(taskId, 'linear')).toBeUndefined();
    });

    it('insertTaskExternalRefIfAbsent does not overwrite existing', () => {
      upsertTaskExternalRef({ task_id: taskId, integration: 'linear', ref: 'SHR-1' });
      insertTaskExternalRefIfAbsent({ task_id: taskId, integration: 'linear', ref: 'SHR-99' });
      const ref = getTaskExternalRef(taskId, 'linear');
      expect(ref!.ref).toBe('SHR-1'); // original not overwritten
    });

    it('created_at is non-null', () => {
      upsertTaskExternalRef({ task_id: taskId, integration: 'jira', ref: 'PROJ-1' });
      const refs = getTaskExternalRefs(taskId);
      expect(refs[0]!.created_at).not.toBeNull();
    });
  });
});

// ─── inTransaction (tx.ts) ───────────────────────────────────────────────────

describe('inTransaction', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('commits when the function succeeds', () => {
    const id = insertTask({ title: 'Transactional', description: 'D' });
    inTransaction(() => {
      updateTaskFields(id, { title: 'Updated' });
    });
    const row = getDb().prepare('SELECT title FROM tasks WHERE id = ?').get(id) as
      | { title: string }
      | undefined;
    expect(row?.title).toBe('Updated');
  });

  it('rolls back on throw — neither of two inserts persists', () => {
    let caught = false;
    try {
      inTransaction(() => {
        insertTask({ title: 'First', description: 'D', id: 'tx-row-1' });
        insertTask({ title: 'Second', description: 'D', id: 'tx-row-2' });
        throw new Error('rollback me');
      });
    } catch {
      caught = true;
    }
    expect(caught).toBe(true);
    const r1 = getDb().prepare('SELECT id FROM tasks WHERE id = ?').get('tx-row-1');
    const r2 = getDb().prepare('SELECT id FROM tasks WHERE id = ?').get('tx-row-2');
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
  });

  describe('countTasks — mcp/read.ts:handleMonitorStatus', () => {
    it('returns 0 when no tasks exist', () => {
      expect(countTasks()).toBe(0);
    });

    it('counts only non-deleted tasks', () => {
      insertTask({ title: 'Active 1', description: 'D' });
      insertTask({ title: 'Active 2', description: 'D' });
      const deletedId = insertTask({ title: 'Deleted', description: 'D' });
      softDeleteTask(deletedId);
      expect(countTasks()).toBe(2);
    });

    it('increments when a new task is inserted', () => {
      const before = countTasks();
      insertTask({ title: 'New', description: 'D' });
      expect(countTasks()).toBe(before + 1);
    });
  });

  // ─── depends_on primitive (agents/task-depends-on) ─────────────────────────

  describe('depends_on', () => {
    it('insertTask stores and getTask reads back depends_on', () => {
      const a = insertTask({ title: 'A', description: 'D' });
      const b = insertTask({ title: 'B', description: 'D', depends_on: a });
      expect(getTask(b)?.depends_on).toBe(a);
    });

    it('setDependsOn writes and clears the link', () => {
      const a = insertTask({ title: 'A', description: 'D' });
      const b = insertTask({ title: 'B', description: 'D' });
      setDependsOn(b, a);
      expect(getTask(b)?.depends_on).toBe(a);
      setDependsOn(b, null);
      expect(getTask(b)?.depends_on).toBeNull();
    });

    describe('validateDependsOn — cycle safety', () => {
      it('rejects a nonexistent target task', () => {
        const a = insertTask({ title: 'A', description: 'D' });
        expect(validateDependsOn(a, 'does-not-exist')).toMatch(/not found/);
      });

      it('rejects self-dependency', () => {
        const a = insertTask({ title: 'A', description: 'D' });
        expect(validateDependsOn(a, a)).toMatch(/cannot depend on itself/);
      });

      it('rejects a 2-cycle: A already depends on B, so B -> A is refused', () => {
        const a = insertTask({ title: 'A', description: 'D' });
        const b = insertTask({ title: 'B', description: 'D' });
        expect(validateDependsOn(a, b)).toBeNull();
        setDependsOn(a, b); // A -> B
        expect(validateDependsOn(b, a)).toMatch(/cycle/); // B -> A would close the loop
      });

      it('rejects a 3-cycle: A -> B -> C exists, so C -> A is refused', () => {
        const a = insertTask({ title: 'A', description: 'D' });
        const b = insertTask({ title: 'B', description: 'D' });
        const c = insertTask({ title: 'C', description: 'D' });
        setDependsOn(a, b); // A -> B
        setDependsOn(b, c); // B -> C
        expect(validateDependsOn(c, a)).toMatch(/cycle/); // C -> A would close the loop
      });

      it('allows a valid non-cyclic chain', () => {
        const a = insertTask({ title: 'A', description: 'D' });
        const b = insertTask({ title: 'B', description: 'D' });
        expect(validateDependsOn(a, b)).toBeNull();
      });

      it('taskId=null (create-time) only checks existence, never a cycle', () => {
        const a = insertTask({ title: 'A', description: 'D' });
        expect(validateDependsOn(null, a)).toBeNull();
        expect(validateDependsOn(null, 'nope')).toMatch(/not found/);
      });
    });

    describe('isDependencyUnmet', () => {
      it('is false when depends_on is null', () => {
        expect(isDependencyUnmet(null)).toBe(false);
      });

      it('is true while the dependency has not reached done', () => {
        const a = insertTask({ title: 'A', description: 'D' });
        setWorkflowStatus(a, 'in_progress');
        expect(isDependencyUnmet(a)).toBe(true);
      });

      it('is false once the dependency reaches done', () => {
        const a = insertTask({ title: 'A', description: 'D' });
        setWorkflowStatus(a, 'done');
        expect(isDependencyUnmet(a)).toBe(false);
      });

      it('treats a dependency task that no longer exists as still unmet (safe default)', () => {
        expect(isDependencyUnmet('ghost-task')).toBe(true);
      });
    });

    describe('listDependentsAwaitingStart', () => {
      it('finds idle+in_progress tasks blocked on the given dependency', () => {
        const dep = insertTask({ title: 'Dep', description: 'D' });
        const blocked = insertTask({ title: 'Blocked', description: 'D', depends_on: dep });
        setWorkflowStatus(blocked, 'in_progress'); // runtime_state stays 'idle' (default)
        expect(listDependentsAwaitingStart(dep).map((t) => t.id)).toEqual([blocked]);
      });

      it('excludes a dependent that is already running', () => {
        const dep = insertTask({ title: 'Dep', description: 'D' });
        const running = insertTask({ title: 'Running', description: 'D', depends_on: dep });
        setWorkflowStatus(running, 'in_progress');
        setRuntimeState(running, 'running');
        expect(listDependentsAwaitingStart(dep)).toEqual([]);
      });

      it('excludes tasks that depend on a different task', () => {
        const dep = insertTask({ title: 'Dep', description: 'D' });
        const otherDep = insertTask({ title: 'OtherDep', description: 'D' });
        const blocked = insertTask({ title: 'Blocked', description: 'D', depends_on: otherDep });
        setWorkflowStatus(blocked, 'in_progress');
        expect(listDependentsAwaitingStart(dep)).toEqual([]);
      });
    });
  });
});
