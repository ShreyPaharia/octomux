import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, insertTask, insertAgent as insertTestAgent } from '../test-helpers.js';
import {
  getAgent,
  listActiveAgents,
  listStoppedAgents,
  getTaskHookToken,
  insertAgent,
  insertAgentWithNotify,
  setAgentHarnessSessionId,
  setAgentWindowRunning,
  stopAllAgents,
  stopRunningAgents,
  stopRunningAgentsForTask,
  stopAgent,
  hopAgentToTask,
  listAgentsByTasks,
  listUserTerminalsByTasks,
  countUserTerminals,
  insertUserTerminal,
  deleteUserTerminalsByTask,
  deleteUserTerminal,
  countAgentsForTask,
} from './agent-runtime.js';
import type Database from 'better-sqlite3';

describe('repositories/agent-runtime', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // Seed a default task so FK constraints on agents pass.
    insertTask(db, { id: 'task-01', worktree: null });
    insertTask(db, { id: 'task-02', worktree: null });
  });

  // ─── insertAgent / getAgent round-trip ────────────────────────────────────────

  describe('insertAgent / getAgent', () => {
    it('inserts and reads back an agent', () => {
      const id = insertAgent({
        task_id: 'task-01',
        window_index: 0,
        label: 'Agent 1',
        harness_id: 'claude-code',
        harness_session_id: 'sess-abc',
        hook_token: 'tok-xyz',
        agent: null,
      });
      expect(id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
      const a = getAgent(id);
      expect(a).toBeDefined();
      expect(a!.task_id).toBe('task-01');
      expect(a!.window_index).toBe(0);
      expect(a!.label).toBe('Agent 1');
      expect(a!.harness_id).toBe('claude-code');
      expect(a!.harness_session_id).toBe('sess-abc');
      expect(a!.hook_token).toBe('tok-xyz');
      expect(a!.status).toBe('running');
      expect(a!.hook_activity).toBe('active');
    });

    it('created_at is populated', () => {
      const id = insertAgent({
        task_id: 'task-01',
        window_index: 0,
        label: 'A',
        harness_id: 'claude-code',
        hook_token: '',
      });
      const a = getAgent(id);
      expect(a!.created_at).not.toBeNull();
    });

    it('accepts an explicit id', () => {
      insertAgent({
        id: 'my-agent-id',
        task_id: 'task-01',
        window_index: 0,
        label: 'X',
        harness_id: 'claude-code',
        hook_token: '',
      });
      expect(getAgent('my-agent-id')).toBeDefined();
    });

    it('returns undefined for unknown id', () => {
      expect(getAgent('no-such')).toBeUndefined();
    });
  });

  // ─── insertAgentWithNotify ────────────────────────────────────────────────────

  describe('insertAgentWithNotify', () => {
    it('stores notify_agent_id', () => {
      // seed the parent agent first
      insertAgent({
        id: 'parent-agent',
        task_id: 'task-01',
        window_index: 0,
        label: 'Parent',
        harness_id: 'claude-code',
        hook_token: '',
      });
      const id = insertAgentWithNotify({
        task_id: 'task-01',
        window_index: 1,
        label: 'Child',
        harness_id: 'claude-code',
        hook_token: '',
        notify_agent_id: 'parent-agent',
      });
      const a = getAgent(id);
      expect(a!.notify_agent_id).toBe('parent-agent');
    });

    it('stores null notify_agent_id when omitted', () => {
      const id = insertAgentWithNotify({
        task_id: 'task-01',
        window_index: 0,
        label: 'Solo',
        harness_id: 'claude-code',
        hook_token: '',
      });
      expect(getAgent(id)!.notify_agent_id).toBeNull();
    });
  });

  // ─── listActiveAgents / listStoppedAgents ─────────────────────────────────────

  describe('listActiveAgents / listStoppedAgents', () => {
    it('listActiveAgents excludes stopped agents', () => {
      insertAgent({
        id: 'a1',
        task_id: 'task-01',
        window_index: 0,
        label: 'A1',
        harness_id: 'claude-code',
        hook_token: '',
      });
      insertTestAgent(db, {
        id: 'a2',
        task_id: 'task-01',
        window_index: 1,
        label: 'A2',
        status: 'stopped',
      });
      const active = listActiveAgents('task-01');
      expect(active.map((a) => a.id)).toContain('a1');
      expect(active.map((a) => a.id)).not.toContain('a2');
    });

    it('listStoppedAgents returns only stopped agents', () => {
      insertAgent({
        id: 'a1',
        task_id: 'task-01',
        window_index: 0,
        label: 'A1',
        harness_id: 'claude-code',
        hook_token: '',
      });
      insertTestAgent(db, {
        id: 'a2',
        task_id: 'task-01',
        window_index: 1,
        label: 'A2',
        status: 'stopped',
      });
      const stopped = listStoppedAgents('task-01');
      expect(stopped.map((a) => a.id)).toContain('a2');
      expect(stopped.map((a) => a.id)).not.toContain('a1');
    });

    it('results are ordered by window_index', () => {
      insertAgent({
        id: 'b2',
        task_id: 'task-01',
        window_index: 2,
        label: 'B2',
        harness_id: 'claude-code',
        hook_token: '',
      });
      insertAgent({
        id: 'b1',
        task_id: 'task-01',
        window_index: 1,
        label: 'B1',
        harness_id: 'claude-code',
        hook_token: '',
      });
      const active = listActiveAgents('task-01');
      expect(active.map((a) => a.window_index)).toEqual([1, 2]);
    });
  });

  // ─── getTaskHookToken ──────────────────────────────────────────────────────────

  describe('getTaskHookToken', () => {
    it('returns the hook_token for the first agent with a non-empty token', () => {
      insertAgent({
        task_id: 'task-01',
        window_index: 0,
        label: 'A',
        harness_id: 'claude-code',
        hook_token: 'secret-token',
      });
      const result = getTaskHookToken('task-01');
      expect(result).toBeDefined();
      expect(result!.hook_token).toBe('secret-token');
    });

    it('returns undefined when no agent has a non-empty token', () => {
      insertAgent({
        task_id: 'task-01',
        window_index: 0,
        label: 'A',
        harness_id: 'claude-code',
        hook_token: '',
      });
      expect(getTaskHookToken('task-01')).toBeUndefined();
    });
  });

  // ─── setAgentHarnessSessionId ─────────────────────────────────────────────────

  describe('setAgentHarnessSessionId', () => {
    it('updates harness_session_id', () => {
      const id = insertAgent({
        task_id: 'task-01',
        window_index: 0,
        label: 'A',
        harness_id: 'claude-code',
        hook_token: '',
        harness_session_id: null,
      });
      setAgentHarnessSessionId(id, 'new-session-id');
      expect(getAgent(id)!.harness_session_id).toBe('new-session-id');
    });
  });

  // ─── setAgentWindowRunning ────────────────────────────────────────────────────

  describe('setAgentWindowRunning', () => {
    it('sets window_index and status=running', () => {
      const id = insertTestAgent(db, {
        task_id: 'task-01',
        window_index: 0,
        label: 'A',
        status: 'stopped',
      }).id;
      setAgentWindowRunning(id, 5);
      const a = getAgent(id);
      expect(a!.window_index).toBe(5);
      expect(a!.status).toBe('running');
    });
  });

  // ─── stopAllAgents ────────────────────────────────────────────────────────────

  describe('stopAllAgents', () => {
    it('marks all agents as stopped with idle activity', () => {
      const id1 = insertAgent({
        task_id: 'task-01',
        window_index: 0,
        label: 'A1',
        harness_id: 'claude-code',
        hook_token: '',
      });
      const id2 = insertAgent({
        task_id: 'task-01',
        window_index: 1,
        label: 'A2',
        harness_id: 'claude-code',
        hook_token: '',
      });
      stopAllAgents('task-01');
      expect(getAgent(id1)!.status).toBe('stopped');
      expect(getAgent(id1)!.hook_activity).toBe('idle');
      expect(getAgent(id2)!.status).toBe('stopped');
    });

    it('sets hook_activity_updated_at', () => {
      const id = insertAgent({
        task_id: 'task-01',
        window_index: 0,
        label: 'A',
        harness_id: 'claude-code',
        hook_token: '',
      });
      stopAllAgents('task-01');
      expect(getAgent(id)!.hook_activity_updated_at).not.toBeNull();
    });

    it('does not affect agents of a different task', () => {
      const id = insertAgent({
        task_id: 'task-02',
        window_index: 0,
        label: 'A',
        harness_id: 'claude-code',
        hook_token: '',
      });
      stopAllAgents('task-01');
      expect(getAgent(id)!.status).toBe('running');
    });
  });

  // ─── stopRunningAgents ───────────────────────────────────────────────────────

  describe('stopRunningAgents', () => {
    it('stops non-stopped agents but does not double-update already-stopped ones', () => {
      const id1 = insertAgent({
        task_id: 'task-01',
        window_index: 0,
        label: 'A1',
        harness_id: 'claude-code',
        hook_token: '',
      });
      const id2 = insertTestAgent(db, {
        task_id: 'task-01',
        window_index: 1,
        label: 'A2',
        status: 'stopped',
      }).id;
      stopRunningAgents('task-01');
      expect(getAgent(id1)!.status).toBe('stopped');
      expect(getAgent(id2)!.status).toBe('stopped');
    });
  });

  // ─── stopRunningAgentsForTask ────────────────────────────────────────────────

  describe('stopRunningAgentsForTask', () => {
    it('only stops running agents, leaving idle/stopped untouched', () => {
      const runId = insertAgent({
        task_id: 'task-01',
        window_index: 0,
        label: 'R',
        harness_id: 'claude-code',
        hook_token: '',
      });
      const idleId = insertTestAgent(db, {
        id: 'agent-idle',
        task_id: 'task-01',
        window_index: 1,
        label: 'I',
        status: 'idle',
      }).id;
      const stoppedId = insertTestAgent(db, {
        id: 'agent-stopped',
        task_id: 'task-01',
        window_index: 2,
        label: 'S',
        status: 'stopped',
      }).id;
      stopRunningAgentsForTask('task-01');
      expect(getAgent(runId)!.status).toBe('stopped');
      // The discriminating case: a non-running, non-stopped agent must be left as-is.
      expect(getAgent(idleId)!.status).toBe('idle');
      expect(getAgent(stoppedId)!.status).toBe('stopped');
    });
  });

  // ─── bulk IN-clause readers ───────────────────────────────────────────────────

  describe('bulk readers (listAgentsByTasks / listUserTerminalsByTasks)', () => {
    it('returns rows across multiple tasks', () => {
      insertAgent({
        task_id: 'task-01',
        window_index: 0,
        label: 'A',
        harness_id: 'claude-code',
        hook_token: '',
      });
      insertAgent({
        task_id: 'task-02',
        window_index: 0,
        label: 'B',
        harness_id: 'claude-code',
        hook_token: '',
      });
      insertUserTerminal({ task_id: 'task-01', window_index: 1, label: 'T1' });
      insertUserTerminal({ task_id: 'task-02', window_index: 1, label: 'T2' });
      expect(
        listAgentsByTasks(['task-01', 'task-02'])
          .map((a) => a.task_id)
          .sort(),
      ).toEqual(['task-01', 'task-02']);
      expect(listUserTerminalsByTasks(['task-01', 'task-02'])).toHaveLength(2);
    });

    it('returns [] for an empty id list (no invalid IN () SQL)', () => {
      expect(listAgentsByTasks([])).toEqual([]);
      expect(listUserTerminalsByTasks([])).toEqual([]);
    });
  });

  // ─── stopAgent (single) ───────────────────────────────────────────────────────

  describe('stopAgent', () => {
    it('stops a single agent', () => {
      const id = insertAgent({
        task_id: 'task-01',
        window_index: 0,
        label: 'A',
        harness_id: 'claude-code',
        hook_token: '',
      });
      stopAgent(id);
      const a = getAgent(id);
      expect(a!.status).toBe('stopped');
      expect(a!.hook_activity).toBe('idle');
    });
  });

  // ─── hopAgentToTask ───────────────────────────────────────────────────────────

  describe('hopAgentToTask', () => {
    it('updates task_id, window_index, tmux_session, and status for a hop', () => {
      const id = insertAgent({
        task_id: 'task-01',
        window_index: 0,
        label: 'A',
        harness_id: 'claude-code',
        hook_token: '',
      });
      hopAgentToTask(id, 'task-02', 3, null);
      const a = getAgent(id);
      expect(a!.task_id).toBe('task-02');
      expect(a!.window_index).toBe(3);
      expect(a!.tmux_session).toBeNull();
      expect(a!.status).toBe('running');
      expect(a!.hook_activity).toBe('active');
    });

    it('persists tmux_session for standalone hop', () => {
      const id = insertAgent({
        task_id: 'task-01',
        window_index: 0,
        label: 'A',
        harness_id: 'claude-code',
        hook_token: '',
      });
      hopAgentToTask(id, null, 0, 'standalone-session');
      expect(getAgent(id)!.tmux_session).toBe('standalone-session');
    });

    it('sets hook_activity_updated_at', () => {
      const id = insertAgent({
        task_id: 'task-01',
        window_index: 0,
        label: 'A',
        harness_id: 'claude-code',
        hook_token: '',
      });
      hopAgentToTask(id, 'task-02', 1, null);
      expect(getAgent(id)!.hook_activity_updated_at).not.toBeNull();
    });
  });

  // ─── user_terminals ───────────────────────────────────────────────────────────

  describe('insertUserTerminal / countUserTerminals', () => {
    it('inserts a user_terminal and returns full shape', () => {
      const ut = insertUserTerminal({ task_id: 'task-01', window_index: 2, label: 'Terminal 1' });
      expect(ut.id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
      expect(ut.task_id).toBe('task-01');
      expect(ut.window_index).toBe(2);
      expect(ut.label).toBe('Terminal 1');
      expect(ut.status).toBe('idle');
    });

    it('countUserTerminals reflects inserted rows', () => {
      expect(countUserTerminals('task-01')).toBe(0);
      insertUserTerminal({ task_id: 'task-01', window_index: 1, label: 'T1' });
      insertUserTerminal({ task_id: 'task-01', window_index: 2, label: 'T2' });
      expect(countUserTerminals('task-01')).toBe(2);
    });
  });

  describe('deleteUserTerminalsByTask', () => {
    it('deletes all terminals for the task', () => {
      insertUserTerminal({ task_id: 'task-01', window_index: 1, label: 'T1' });
      insertUserTerminal({ task_id: 'task-01', window_index: 2, label: 'T2' });
      deleteUserTerminalsByTask('task-01');
      expect(countUserTerminals('task-01')).toBe(0);
    });

    it('does not affect terminals for other tasks', () => {
      insertUserTerminal({ task_id: 'task-01', window_index: 1, label: 'T1' });
      insertUserTerminal({ task_id: 'task-02', window_index: 1, label: 'T2' });
      deleteUserTerminalsByTask('task-01');
      expect(countUserTerminals('task-02')).toBe(1);
    });
  });

  describe('deleteUserTerminal', () => {
    it('deletes a single terminal by id', () => {
      const ut1 = insertUserTerminal({ task_id: 'task-01', window_index: 1, label: 'T1' });
      const ut2 = insertUserTerminal({ task_id: 'task-01', window_index: 2, label: 'T2' });
      deleteUserTerminal(ut1.id);
      expect(countUserTerminals('task-01')).toBe(1);
      // The second terminal should remain
      const remaining = db
        .prepare('SELECT id FROM user_terminals WHERE task_id = ?')
        .all('task-01') as Array<{ id: string }>;
      expect(remaining.map((r) => r.id)).toContain(ut2.id);
    });
  });

  describe('countAgentsForTask — mcp/read.ts:handleGetTask', () => {
    it('returns 0 when task has no agents', () => {
      expect(countAgentsForTask('task-01')).toBe(0);
    });

    it('counts all agents regardless of status', () => {
      insertAgent({
        task_id: 'task-01',
        window_index: 0,
        label: 'Agent A',
        harness_id: 'claude-code',
        hook_token: 'tok-a',
      });
      insertAgent({
        task_id: 'task-01',
        window_index: 1,
        label: 'Agent B',
        harness_id: 'claude-code',
        hook_token: 'tok-b',
      });
      // Stop one agent; countAgentsForTask should still count it
      const stoppedId = insertAgent({
        task_id: 'task-01',
        window_index: 2,
        label: 'Agent C',
        harness_id: 'claude-code',
        hook_token: 'tok-c',
      });
      stopAgent(stoppedId);
      expect(countAgentsForTask('task-01')).toBe(3);
    });

    it('does not count agents from other tasks', () => {
      insertAgent({
        task_id: 'task-02',
        window_index: 0,
        label: 'Other Agent',
        harness_id: 'claude-code',
        hook_token: 'tok-other',
      });
      expect(countAgentsForTask('task-01')).toBe(0);
    });
  });
});
