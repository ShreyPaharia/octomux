import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, insertTask } from '../test-helpers.js';
import { insertAgent } from './agent-runtime.js';
import {
  listPendingPromptsByTask,
  listPendingPromptsByTasks,
  listRecentResolvedByAgent,
  countPendingByTask,
  insertPermissionPrompt,
  resolveTaskPermissionPrompts,
  resolveAgentPermissionPrompts,
  resolveOldestPendingByAgent,
} from './permission-prompts.js';
import type Database from 'better-sqlite3';

describe('repositories/permission-prompts', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertTask(db, { id: 'task-01', worktree: null });
    insertTask(db, { id: 'task-02', worktree: null });
  });

  function seedAgent(id: string, taskId = 'task-01'): string {
    return insertAgent({
      id,
      task_id: taskId,
      window_index: 0,
      label: `Agent ${id}`,
      harness_id: 'claude-code',
      hook_token: '',
    });
  }

  function seedPrompt(opts: {
    id: string;
    taskId: string;
    agentId?: string | null;
    status?: 'pending' | 'resolved';
  }): void {
    db.prepare(
      `INSERT INTO permission_prompts (id, task_id, agent_id, session_id, tool_name, tool_input, status, created_at)
       VALUES (?, ?, ?, 'sess', 'Bash', '{"command":"ls"}', ?, datetime('now'))`,
    ).run(opts.id, opts.taskId, opts.agentId ?? null, opts.status ?? 'pending');
  }

  // ─── insertPermissionPrompt ────────────────────────────────────────────────

  describe('insertPermissionPrompt', () => {
    it('inserts a pending prompt and returns an id', () => {
      const agentId = seedAgent('ag1');
      const id = insertPermissionPrompt({
        task_id: 'task-01',
        agent_id: agentId,
        session_id: 'sess',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });
      expect(id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
      const row = db.prepare('SELECT * FROM permission_prompts WHERE id = ?').get(id) as
        | { status: string; tool_input: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row!.status).toBe('pending');
      expect(JSON.parse(row!.tool_input)).toEqual({ command: 'ls' });
    });

    it('accepts an explicit id', () => {
      insertPermissionPrompt({
        id: 'my-pp-id',
        task_id: 'task-01',
        agent_id: null,
        session_id: null,
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/x' },
      });
      const row = db.prepare('SELECT id FROM permission_prompts WHERE id = ?').get('my-pp-id') as
        | { id: string }
        | undefined;
      expect(row?.id).toBe('my-pp-id');
    });
  });

  // ─── listPendingPromptsByTask ──────────────────────────────────────────────

  describe('listPendingPromptsByTask', () => {
    it('returns only pending prompts for the task', () => {
      const agentId = seedAgent('ag2');
      seedPrompt({ id: 'pp1', taskId: 'task-01', agentId, status: 'pending' });
      seedPrompt({ id: 'pp2', taskId: 'task-01', agentId, status: 'resolved' });
      seedPrompt({ id: 'pp3', taskId: 'task-02', agentId: null, status: 'pending' });

      const results = listPendingPromptsByTask('task-01');
      expect(results.map((r) => r.id)).toEqual(['pp1']);
    });

    it('parses tool_input as object', () => {
      const agentId = seedAgent('ag3');
      seedPrompt({ id: 'pp4', taskId: 'task-01', agentId });
      const results = listPendingPromptsByTask('task-01');
      expect(results[0]?.tool_input).toEqual({ command: 'ls' });
    });

    it('joins agent_label from agents table', () => {
      const agentId = seedAgent('ag4');
      seedPrompt({ id: 'pp5', taskId: 'task-01', agentId });
      const results = listPendingPromptsByTask('task-01');
      expect(results[0]?.agent_label).toBe('Agent ag4');
    });

    it('returns empty array when no pending prompts', () => {
      expect(listPendingPromptsByTask('task-01')).toHaveLength(0);
    });
  });

  // ─── listPendingPromptsByTasks ─────────────────────────────────────────────

  describe('listPendingPromptsByTasks', () => {
    it('returns pending prompts across multiple tasks', () => {
      seedPrompt({ id: 'pp6', taskId: 'task-01' });
      seedPrompt({ id: 'pp7', taskId: 'task-02' });
      const results = listPendingPromptsByTasks(['task-01', 'task-02']);
      expect(results.map((r) => r.id).sort()).toEqual(['pp6', 'pp7']);
    });

    it('returns [] for an empty id list', () => {
      expect(listPendingPromptsByTasks([])).toEqual([]);
    });
  });

  // ─── countPendingByTask ────────────────────────────────────────────────────

  describe('countPendingByTask', () => {
    it('counts only pending prompts', () => {
      expect(countPendingByTask('task-01')).toBe(0);
      seedPrompt({ id: 'pp8', taskId: 'task-01', status: 'pending' });
      seedPrompt({ id: 'pp9', taskId: 'task-01', status: 'resolved' });
      expect(countPendingByTask('task-01')).toBe(1);
    });

    it('is scoped to a task', () => {
      seedPrompt({ id: 'pp10', taskId: 'task-02', status: 'pending' });
      expect(countPendingByTask('task-01')).toBe(0);
    });
  });

  // ─── resolveTaskPermissionPrompts ─────────────────────────────────────────

  describe('resolveTaskPermissionPrompts', () => {
    it('resolves all pending prompts for a task', () => {
      const agentId = seedAgent('ag5');
      seedPrompt({ id: 'pp11', taskId: 'task-01', agentId, status: 'pending' });
      seedPrompt({ id: 'pp12', taskId: 'task-01', agentId, status: 'pending' });
      resolveTaskPermissionPrompts('task-01');
      const count = countPendingByTask('task-01');
      expect(count).toBe(0);
    });

    it('does not affect already-resolved prompts', () => {
      seedPrompt({ id: 'pp13', taskId: 'task-01', status: 'resolved' });
      resolveTaskPermissionPrompts('task-01');
      const row = db.prepare('SELECT status FROM permission_prompts WHERE id = ?').get('pp13') as {
        status: string;
      };
      expect(row.status).toBe('resolved');
    });

    it('does not affect prompts for other tasks', () => {
      seedPrompt({ id: 'pp14', taskId: 'task-02', status: 'pending' });
      resolveTaskPermissionPrompts('task-01');
      expect(countPendingByTask('task-02')).toBe(1);
    });
  });

  // ─── resolveAgentPermissionPrompts ────────────────────────────────────────

  describe('resolveAgentPermissionPrompts', () => {
    it('resolves pending prompts for a specific agent', () => {
      const agentId = seedAgent('ag6');
      seedPrompt({ id: 'pp15', taskId: 'task-01', agentId, status: 'pending' });
      resolveAgentPermissionPrompts(agentId);
      const row = db.prepare('SELECT status FROM permission_prompts WHERE id = ?').get('pp15') as {
        status: string;
      };
      expect(row.status).toBe('resolved');
    });

    it('does not resolve prompts belonging to a different agent', () => {
      const agent1 = seedAgent('ag7');
      const agent2 = seedAgent('ag8');
      seedPrompt({ id: 'pp16', taskId: 'task-01', agentId: agent2, status: 'pending' });
      resolveAgentPermissionPrompts(agent1);
      expect(countPendingByTask('task-01')).toBe(1);
    });
  });

  // ─── resolveOldestPendingByAgent ──────────────────────────────────────────

  describe('resolveOldestPendingByAgent', () => {
    it('resolves only the oldest pending prompt (FIFO)', () => {
      const agentId = seedAgent('ag9');
      // Use explicit created_at ordering
      db.prepare(
        `INSERT INTO permission_prompts (id, task_id, agent_id, session_id, tool_name, tool_input, status, created_at)
         VALUES ('ppA', 'task-01', ?, 'sess', 'Bash', '{}', 'pending', '2024-01-01 10:00:00')`,
      ).run(agentId);
      db.prepare(
        `INSERT INTO permission_prompts (id, task_id, agent_id, session_id, tool_name, tool_input, status, created_at)
         VALUES ('ppB', 'task-01', ?, 'sess', 'Read', '{}', 'pending', '2024-01-01 11:00:00')`,
      ).run(agentId);

      resolveOldestPendingByAgent(agentId);

      const a = db.prepare('SELECT status FROM permission_prompts WHERE id = ?').get('ppA') as {
        status: string;
      };
      const b = db.prepare('SELECT status FROM permission_prompts WHERE id = ?').get('ppB') as {
        status: string;
      };
      expect(a.status).toBe('resolved');
      expect(b.status).toBe('pending');
    });
  });

  // ─── listRecentResolvedByAgent ────────────────────────────────────────────

  describe('listRecentResolvedByAgent', () => {
    it('returns resolved prompts since the given timestamp', () => {
      const agentId = seedAgent('ag10');
      db.prepare(
        `INSERT INTO permission_prompts (id, task_id, agent_id, session_id, tool_name, tool_input, status, resolved_at, created_at)
         VALUES ('ppC', 'task-01', ?, 'sess', 'Bash', '{"command":"pwd"}', 'resolved', datetime('now'), datetime('now'))`,
      ).run(agentId);

      const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace('T', ' ');
      const results = listRecentResolvedByAgent(agentId, tenMinsAgo);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.tool_input).toEqual({ command: 'pwd' });
    });

    it('returns [] when no resolved prompts in time window', () => {
      const agentId = seedAgent('ag11');
      const farFuture = '2099-01-01 00:00:00';
      expect(listRecentResolvedByAgent(agentId, farFuture)).toHaveLength(0);
    });
  });
});
