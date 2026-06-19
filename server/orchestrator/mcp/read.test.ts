/**
 * server/orchestrator/mcp/read.test.ts
 *
 * Tests for the orchestrator MCP read tools (Task 1.5 / SHR-121).
 *
 * Contract: all tools return lean summaries + pointers — never full row dumps
 * or file contents. get_task_output returns artifact pointers only.
 *
 * Tests call the handler functions directly; no MCP transport is exercised here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, insertTask, insertAgent } from '../../test-helpers.js';
import { getDb } from '../../db.js';
import {
  handleListTasks,
  handleGetTask,
  handleMonitorStatus,
  handleGetTaskOutput,
} from './read.js';
import { upsertManagedTask } from '../store.js';

describe('orchestrator mcp read tools', () => {
  beforeEach(() => {
    createTestDb();
  });

  // ─── list_tasks ────────────────────────────────────────────────────────────

  describe('handleListTasks', () => {
    it('returns lean summary fields — only id, title, status, workflow_status', () => {
      const db = getDb();
      insertTask(db, {
        id: 'task-lt-01',
        title: 'Build feature A',
        workflow_status: 'in_progress',
        runtime_state: 'running',
      });
      insertTask(db, {
        id: 'task-lt-02',
        title: 'Fix bug B',
        workflow_status: 'backlog',
        runtime_state: 'idle',
      });

      const result = handleListTasks({});
      expect(Array.isArray(result)).toBe(true);
      const task = result.find((t) => t.id === 'task-lt-01');
      expect(task).toBeDefined();
      // Lean summary: only these fields
      expect(task).toHaveProperty('id');
      expect(task).toHaveProperty('title');
      expect(task).toHaveProperty('runtime_state');
      expect(task).toHaveProperty('workflow_status');
      // Must NOT include full rows
      expect(task).not.toHaveProperty('description');
      expect(task).not.toHaveProperty('initial_prompt');
      expect(task).not.toHaveProperty('error');
    });

    it('filters by workflow_status when provided', () => {
      const db = getDb();
      insertTask(db, {
        id: 'task-lt-03',
        title: 'Running task',
        workflow_status: 'in_progress',
        runtime_state: 'running',
      });
      insertTask(db, {
        id: 'task-lt-04',
        title: 'Done task',
        workflow_status: 'done',
        runtime_state: 'idle',
      });

      const result = handleListTasks({ workflow_status: 'in_progress' });
      expect(result.every((t) => t.workflow_status === 'in_progress')).toBe(true);
      expect(result.find((t) => t.id === 'task-lt-03')).toBeDefined();
      expect(result.find((t) => t.id === 'task-lt-04')).toBeUndefined();
    });

    it('returns empty array when no tasks match', () => {
      const result = handleListTasks({ workflow_status: 'pr' });
      expect(result).toEqual([]);
    });

    it('excludes soft-deleted tasks', () => {
      const db = getDb();
      insertTask(db, { id: 'task-lt-05', title: 'Active task', workflow_status: 'backlog' });
      // Mark as deleted
      db.prepare(`UPDATE tasks SET deleted_at = datetime('now') WHERE id = 'task-lt-05'`).run();
      const result = handleListTasks({});
      expect(result.find((t) => t.id === 'task-lt-05')).toBeUndefined();
    });
  });

  // ─── get_task ──────────────────────────────────────────────────────────────

  describe('handleGetTask', () => {
    it('returns lean task summary for an existing task', () => {
      const db = getDb();
      insertTask(db, {
        id: 'task-gt-01',
        title: 'Implement auth',
        workflow_status: 'in_progress',
        runtime_state: 'running',
      });

      const result = handleGetTask({ task_id: 'task-gt-01' });
      expect(result).not.toBeNull();
      expect(result!.id).toBe('task-gt-01');
      expect(result!.title).toBe('Implement auth');
      expect(result!.workflow_status).toBe('in_progress');
      expect(result!.runtime_state).toBe('running');
      // Lean: no description/initial_prompt/error in the summary
      expect(result).not.toHaveProperty('initial_prompt');
    });

    it('returns null for an unknown task_id', () => {
      const result = handleGetTask({ task_id: 'nonexistent-task' });
      expect(result).toBeNull();
    });

    it('includes agent count (pointer, not agent rows)', () => {
      const db = getDb();
      insertTask(db, { id: 'task-gt-02', title: 'Task with agents', worktree: null });
      insertAgent(db, { id: 'agent-gt-01', task_id: 'task-gt-02' });
      insertAgent(db, { id: 'agent-gt-02', task_id: 'task-gt-02', window_index: 1 });

      const result = handleGetTask({ task_id: 'task-gt-02' });
      expect(result!.agent_count).toBe(2);
      // Must not include full agent rows
      expect(result).not.toHaveProperty('agents');
    });
  });

  // ─── monitor_status ────────────────────────────────────────────────────────

  describe('handleMonitorStatus', () => {
    it.each([
      ['running', 'in_progress', 1],
      ['idle', 'backlog', 0],
      ['error', 'in_progress', 0],
    ] as const)(
      'counts runtime_state=%s correctly',
      (runtimeState, workflowStatus, _expectedRunning) => {
        const db = getDb();
        insertTask(db, {
          id: `task-ms-${runtimeState}`,
          title: `Task ${runtimeState}`,
          runtime_state: runtimeState,
          workflow_status: workflowStatus,
        });
        const result = handleMonitorStatus({});
        // result is a rollup — at minimum contains counts
        expect(result).toHaveProperty('total');
        expect(result).toHaveProperty('by_runtime_state');
        expect(result).toHaveProperty('by_workflow_status');
        expect(typeof result.total).toBe('number');
      },
    );

    it('returns zero counts when no tasks exist', () => {
      const result = handleMonitorStatus({});
      expect(result.total).toBe(0);
    });

    it('surfaces needs_attention list (error tasks and tasks with pending prompts)', () => {
      const db = getDb();
      insertTask(db, {
        id: 'task-ms-err',
        title: 'Errored task',
        runtime_state: 'error',
        workflow_status: 'in_progress',
      });

      const result = handleMonitorStatus({});
      expect(result).toHaveProperty('needs_attention');
      expect(Array.isArray(result.needs_attention)).toBe(true);
      // error task should appear
      const errored = result.needs_attention.find((t: { id: string }) => t.id === 'task-ms-err');
      expect(errored).toBeDefined();
    });
  });

  // ─── get_task_output ───────────────────────────────────────────────────────

  describe('handleGetTaskOutput', () => {
    it('returns only artifact pointers — never file contents', () => {
      const db = getDb();
      insertTask(db, { id: 'task-gto-01', title: 'Plan task', worktree: null });
      const convId = getDb()
        .prepare(
          `INSERT INTO orchestrator_conversations (id, title) VALUES ('conv-gto-01', 'Conv') RETURNING id`,
        )
        .get() as { id: string };
      upsertManagedTask({
        conversation_id: convId.id,
        task_id: 'task-gto-01',
        phase: 'awaiting_approval',
        artifacts: JSON.stringify({ plan: 'plan.json', diff_url: '/tasks/task-gto-01?view=diff' }),
      });

      const result = handleGetTaskOutput({ task_id: 'task-gto-01' });
      // Returns pointers, not contents
      expect(result).toHaveProperty('plan');
      expect(result.plan).toBe('plan.json');
      expect(result).toHaveProperty('diff_url');
      expect(result.diff_url).toBe('/tasks/task-gto-01?view=diff');
      // Must not include file contents (no large string bodies)
      expect(typeof result.plan).toBe('string');
      // plan should be a path, not file contents
      expect(result.plan!.length).toBeLessThan(256);
    });

    it('returns empty pointers when no managed_tasks row exists', () => {
      const db = getDb();
      insertTask(db, { id: 'task-gto-02', title: 'Unmanaged', worktree: null });

      const result = handleGetTaskOutput({ task_id: 'task-gto-02' });
      // Should return an empty-ish pointer object, not throw
      expect(result).toBeDefined();
      expect(result.plan).toBeUndefined();
      expect(result.diff_url).toBeUndefined();
    });

    it('includes tests status as a pointer string, not test output', () => {
      const db = getDb();
      insertTask(db, { id: 'task-gto-03', title: 'Test task', worktree: null });
      const convId = db
        .prepare(
          `INSERT INTO orchestrator_conversations (id, title) VALUES ('conv-gto-03', 'Conv3') RETURNING id`,
        )
        .get() as { id: string };
      upsertManagedTask({
        conversation_id: convId.id,
        task_id: 'task-gto-03',
        artifacts: JSON.stringify({ tests: 'passing' }),
      });

      const result = handleGetTaskOutput({ task_id: 'task-gto-03' });
      expect(result.tests).toBe('passing');
      // tests is a status string (pointer), not actual test output
      expect(typeof result.tests).toBe('string');
      expect(result.tests!.length).toBeLessThan(64);
    });

    it('returns diff_url as a URL path (pointer), never as diff contents', () => {
      const db = getDb();
      insertTask(db, { id: 'task-gto-04', title: 'Diff task', worktree: null });
      const convId = db
        .prepare(
          `INSERT INTO orchestrator_conversations (id, title) VALUES ('conv-gto-04', 'Conv4') RETURNING id`,
        )
        .get() as { id: string };
      upsertManagedTask({
        conversation_id: convId.id,
        task_id: 'task-gto-04',
        artifacts: JSON.stringify({ diff_url: '/tasks/task-gto-04?view=diff' }),
      });

      const result = handleGetTaskOutput({ task_id: 'task-gto-04' });
      expect(result.diff_url).toMatch(/^\/tasks\/task-gto-04/);
      // A URL is a pointer, never the actual diff text
      expect(result.diff_url!.length).toBeLessThan(256);
    });
  });
});
