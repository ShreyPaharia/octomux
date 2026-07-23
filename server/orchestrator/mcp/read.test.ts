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
  handleRecentRepos,
  handleDefaultBranch,
  handleSearchLearnings,
} from './read.js';
import { upsertManagedTask } from '../store.js';
import { addLearning, SHARED_LANE } from '../../repositories/agent-learnings.js';
import { POLICY_ONLY_COMMANDS } from '../command-registry.js';

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

    // ── Task 5.3: monitor summaries ─────────────────────────────────────────

    it('returns by_phase rollup from managed_tasks (planning/awaiting_approval/implementing/done)', () => {
      const db = getDb();
      // Insert tasks + managed_tasks rows in different phases
      insertTask(db, { id: 'task-ph-01', title: 'Planning task', runtime_state: 'running' });
      insertTask(db, { id: 'task-ph-02', title: 'Awaiting task', runtime_state: 'idle' });
      insertTask(db, { id: 'task-ph-03', title: 'Implementing task', runtime_state: 'running' });

      db.prepare(
        `INSERT INTO orchestrator_conversations (id, title) VALUES ('conv-ph-01', 'Test conv')`,
      ).run();
      upsertManagedTask({
        conversation_id: 'conv-ph-01',
        task_id: 'task-ph-01',
        phase: 'planning',
      });
      upsertManagedTask({
        conversation_id: 'conv-ph-01',
        task_id: 'task-ph-02',
        phase: 'awaiting_approval',
      });
      upsertManagedTask({
        conversation_id: 'conv-ph-01',
        task_id: 'task-ph-03',
        phase: 'implementing',
      });

      const result = handleMonitorStatus({});
      expect(result).toHaveProperty('by_phase');
      expect(result.by_phase['planning']).toBeGreaterThanOrEqual(1);
      expect(result.by_phase['awaiting_approval']).toBeGreaterThanOrEqual(1);
      expect(result.by_phase['implementing']).toBeGreaterThanOrEqual(1);
    });

    it('surfaces awaiting_approval tasks in needs_attention', () => {
      const db = getDb();
      insertTask(db, {
        id: 'task-awa-01',
        title: 'Plan pending approval',
        runtime_state: 'idle',
        workflow_status: 'in_progress',
      });
      db.prepare(
        `INSERT INTO orchestrator_conversations (id, title) VALUES ('conv-awa-01', 'Awa conv')`,
      ).run();
      upsertManagedTask({
        conversation_id: 'conv-awa-01',
        task_id: 'task-awa-01',
        phase: 'awaiting_approval',
      });

      const result = handleMonitorStatus({});
      const awaiting = result.needs_attention.find((t) => t.id === 'task-awa-01');
      expect(awaiting).toBeDefined();
      expect(awaiting!.reason).toBe('awaiting_approval');
    });

    it('surfaces tasks with agents in hook_activity=waiting in needs_attention', () => {
      const db = getDb();
      insertTask(db, {
        id: 'task-hw-01',
        title: 'Hook waiting task',
        runtime_state: 'running',
        workflow_status: 'in_progress',
      });
      // Insert an agent with hook_activity=waiting
      insertAgent(db, {
        id: 'agent-hw-01',
        task_id: 'task-hw-01',
        hook_activity: 'waiting',
      } as Parameters<typeof insertAgent>[1]);

      const result = handleMonitorStatus({});
      const hooking = result.needs_attention.find((t) => t.id === 'task-hw-01');
      expect(hooking).toBeDefined();
      expect(hooking!.reason).toBe('hook_waiting');
    });

    it('surfaces tasks with recent task:stuck events in needs_attention', () => {
      const db = getDb();
      insertTask(db, {
        id: 'task-stk-01',
        title: 'Stuck task',
        runtime_state: 'running',
        workflow_status: 'in_progress',
      });
      // Insert a task:stuck event
      db.prepare(
        `INSERT INTO events (task_id, type, payload) VALUES ('task-stk-01', 'task:stuck', '{"reason":"inactive"}')`,
      ).run();

      const result = handleMonitorStatus({});
      const stuck = result.needs_attention.find((t) => t.id === 'task-stk-01');
      expect(stuck).toBeDefined();
      expect(stuck!.reason).toBe('stuck');
    });

    it('deduplicates tasks appearing in multiple needs_attention categories', () => {
      const db = getDb();
      // A task that is both errored AND has a task:stuck event
      insertTask(db, {
        id: 'task-dup-01',
        title: 'Dup task',
        runtime_state: 'error',
        workflow_status: 'in_progress',
      });
      db.prepare(
        `INSERT INTO events (task_id, type, payload) VALUES ('task-dup-01', 'task:stuck', '{"reason":"error"}')`,
      ).run();

      const result = handleMonitorStatus({});
      const appearances = result.needs_attention.filter((t) => t.id === 'task-dup-01');
      expect(appearances).toHaveLength(1);
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

  // ─── recent_repos ──────────────────────────────────────────────────────────

  describe('handleRecentRepos', () => {
    it('returns repo_path and last_used for tasks with worktrees', () => {
      const db = getDb();
      insertTask(db, {
        id: 'task-rr-01',
        title: 'Repo task',
        repo_path: '/tmp/my-repo',
        runtime_state: 'idle',
        workflow_status: 'backlog',
        created_at: '2026-01-02 00:00:00',
        updated_at: '2026-01-02 00:00:00',
      });

      const result = handleRecentRepos();
      expect(Array.isArray(result)).toBe(true);
      const row = result.find((r) => r.repo_path === '/tmp/my-repo');
      expect(row).toBeDefined();
      expect(row).toHaveProperty('repo_path');
      expect(row).toHaveProperty('last_used');
    });

    it('returns empty array when no tasks with worktrees exist', () => {
      const result = handleRecentRepos();
      expect(result).toEqual([]);
    });

    it('deduplicates multiple tasks from the same repo, taking max created_at', () => {
      const db = getDb();
      insertTask(db, {
        id: 'task-rr-02',
        title: 'Older task',
        repo_path: '/tmp/shared-repo',
        created_at: '2026-01-01 00:00:00',
        updated_at: '2026-01-01 00:00:00',
      });
      insertTask(db, {
        id: 'task-rr-03',
        title: 'Newer task',
        repo_path: '/tmp/shared-repo',
        created_at: '2026-01-03 00:00:00',
        updated_at: '2026-01-03 00:00:00',
      });

      const result = handleRecentRepos();
      const rows = result.filter((r) => r.repo_path === '/tmp/shared-repo');
      // Only one row per distinct repo_path
      expect(rows).toHaveLength(1);
      // last_used should be the newer created_at
      expect(rows[0].last_used).toBe('2026-01-03 00:00:00');
    });

    it('excludes soft-deleted tasks', () => {
      const db = getDb();
      insertTask(db, {
        id: 'task-rr-04',
        title: 'Deleted task',
        repo_path: '/tmp/deleted-repo',
      });
      db.prepare(`UPDATE tasks SET deleted_at = datetime('now') WHERE id = 'task-rr-04'`).run();

      const result = handleRecentRepos();
      expect(result.find((r) => r.repo_path === '/tmp/deleted-repo')).toBeUndefined();
    });
  });

  // ─── default_branch ────────────────────────────────────────────────────────

  describe('handleDefaultBranch', () => {
    it('falls back to "main" for a bogus/non-git path', async () => {
      const result = await handleDefaultBranch({ repo_path: '/tmp/__nonexistent_repo__' });
      expect(result).toEqual({ branch: 'main' });
    });

    it('falls back to "main" when origin HEAD is not set', async () => {
      // A directory that exists but is not a git repo
      const result = await handleDefaultBranch({ repo_path: '/tmp' });
      expect(result).toEqual({ branch: 'main' });
    });
  });

  // ─── search_learnings ──────────────────────────────────────────────────────

  describe('handleSearchLearnings', () => {
    it('returns matching shared-lane rows as lean summaries', () => {
      addLearning({
        repo_path: '/tmp/repo-a',
        lane: SHARED_LANE,
        trigger: 'retry',
        lesson: 'hedging retry lives in retry.ts',
        evidence: 'retry.ts',
      });
      addLearning({
        repo_path: '/tmp/repo-b',
        lane: SHARED_LANE,
        trigger: 'tests',
        lesson: 'vitest needs default: mocked',
        evidence: 'setup.ts',
      });

      const result = handleSearchLearnings({ query: 'retry' });
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        trigger: 'retry',
        lesson: 'hedging retry lives in retry.ts',
        evidence: 'retry.ts',
        repo_path: '/tmp/repo-a',
      });
      // Lean shape only — no id, usage_count, or other internal fields.
      expect(result[0]).not.toHaveProperty('id');
      expect(result[0]).not.toHaveProperty('usage_count');
    });

    it('filters by repo when given', () => {
      addLearning({
        repo_path: '/tmp/repo-a',
        lane: SHARED_LANE,
        trigger: 't',
        lesson: 'in a',
        evidence: null,
      });
      addLearning({
        repo_path: '/tmp/repo-b',
        lane: SHARED_LANE,
        trigger: 't',
        lesson: 'in b',
        evidence: null,
      });

      const result = handleSearchLearnings({ query: 'in', repo: '/tmp/repo-a' });
      expect(result.map((r) => r.lesson)).toEqual(['in a']);
    });

    it('returns empty array when nothing matches', () => {
      const result = handleSearchLearnings({ query: 'nonexistent-keyword' });
      expect(result).toEqual([]);
    });

    it('is registered as an auto-approved (policy-only) tool', () => {
      const entry = POLICY_ONLY_COMMANDS.find((c) => c.mcpName === 'search_learnings');
      expect(entry).toBeDefined();
      expect(entry!.tier).toBe('auto');
    });
  });
});
