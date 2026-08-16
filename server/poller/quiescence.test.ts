import { describe, it, expect, beforeEach } from '../bun-test.js';
import Database from '../sqlite.js';
import { createTestDb, insertTask, insertAgent, insertPermissionPrompt } from '../test-helpers.js';
import { upsertManagedTask, createConversation } from '../repositories/orchestrator.js';
import { pollQuiescence } from './quiescence.js';

// Helper to set hook_activity and hook_activity_updated_at directly
function setWorkerActivity(db: Database, agentId: string, activity: string, updatedAtExpr: string) {
  db.prepare(
    `UPDATE workers SET hook_activity = ?, hook_activity_updated_at = ${updatedAtExpr} WHERE id = ?`,
  ).run(activity, agentId);
}

function getWorkflowStatus(db: Database, taskId: string): string {
  const row = db.prepare(`SELECT workflow_status FROM tasks WHERE id = ?`).get(taskId) as {
    workflow_status: string;
  };
  return row.workflow_status;
}

function countTaskUpdates(db: Database, taskId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM task_updates WHERE task_id = ?`)
    .get(taskId) as { n: number };
  return row.n;
}

describe('pollQuiescence', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  const cases = [
    {
      name: '(a) task idle > debounce, no pending prompts, not managed → transitions once + fires hook',
      setup: (db: Database) => {
        insertTask(db, { id: 'task-q1', runtime_state: 'running', workflow_status: 'in_progress' });
        insertAgent(db, {
          id: 'agent-q1',
          task_id: 'task-q1',
          status: 'running',
          hook_token: 'tok-q1',
        } as any);
        // idle for 120s (well past 90s debounce)
        setWorkerActivity(db, 'agent-q1', 'idle', `datetime('now', '-120 seconds')`);
      },
      taskId: 'task-q1',
      expectTransition: true,
    },
    {
      name: '(b) idle but WITHIN debounce window → no transition',
      setup: (db: Database) => {
        insertTask(db, { id: 'task-q2', runtime_state: 'running', workflow_status: 'in_progress' });
        insertAgent(db, {
          id: 'agent-q2',
          task_id: 'task-q2',
          status: 'running',
          hook_token: 'tok-q2',
        } as any);
        // idle for only 30s (within 90s debounce)
        setWorkerActivity(db, 'agent-q2', 'idle', `datetime('now', '-30 seconds')`);
      },
      taskId: 'task-q2',
      expectTransition: false,
    },
    {
      name: '(c) a worker still active → no transition',
      setup: (db: Database) => {
        insertTask(db, { id: 'task-q3', runtime_state: 'running', workflow_status: 'in_progress' });
        insertAgent(db, {
          id: 'agent-q3',
          task_id: 'task-q3',
          status: 'running',
          hook_token: 'tok-q3',
        } as any);
        setWorkerActivity(db, 'agent-q3', 'active', `datetime('now', '-120 seconds')`);
      },
      taskId: 'task-q3',
      expectTransition: false,
    },
    {
      name: '(c2) a worker waiting → no transition',
      setup: (db: Database) => {
        insertTask(db, { id: 'task-q4', runtime_state: 'running', workflow_status: 'in_progress' });
        insertAgent(db, {
          id: 'agent-q4',
          task_id: 'task-q4',
          status: 'running',
          hook_token: 'tok-q4',
        } as any);
        setWorkerActivity(db, 'agent-q4', 'waiting', `datetime('now', '-120 seconds')`);
      },
      taskId: 'task-q4',
      expectTransition: false,
    },
    {
      name: '(d) pending permission prompt present → no transition',
      setup: (db: Database) => {
        insertTask(db, { id: 'task-q5', runtime_state: 'running', workflow_status: 'in_progress' });
        insertAgent(db, {
          id: 'agent-q5',
          task_id: 'task-q5',
          status: 'running',
          hook_token: 'tok-q5',
        } as any);
        setWorkerActivity(db, 'agent-q5', 'idle', `datetime('now', '-120 seconds')`);
        insertPermissionPrompt(db, {
          id: 'pp-q5',
          task_id: 'task-q5',
          agent_id: 'agent-q5',
          session_id: 'sess-q5',
          status: 'pending',
        });
      },
      taskId: 'task-q5',
      expectTransition: false,
    },
    {
      name: '(e) orchestrator-managed → no transition',
      setup: (db: Database) => {
        insertTask(db, { id: 'task-q6', runtime_state: 'running', workflow_status: 'in_progress' });
        insertAgent(db, {
          id: 'agent-q6',
          task_id: 'task-q6',
          status: 'running',
          hook_token: 'tok-q6',
        } as any);
        setWorkerActivity(db, 'agent-q6', 'idle', `datetime('now', '-120 seconds')`);
        const convId = createConversation({ title: 'test-q6' });
        upsertManagedTask({ conversation_id: convId, task_id: 'task-q6', phase: 'planning' });
      },
      taskId: 'task-q6',
      expectTransition: false,
    },
    {
      name: '(f) already human_review → no transition',
      setup: (db: Database) => {
        insertTask(db, {
          id: 'task-q7',
          runtime_state: 'running',
          workflow_status: 'human_review',
        });
        insertAgent(db, {
          id: 'agent-q7',
          task_id: 'task-q7',
          status: 'running',
          hook_token: 'tok-q7',
        } as any);
        setWorkerActivity(db, 'agent-q7', 'idle', `datetime('now', '-120 seconds')`);
      },
      taskId: 'task-q7',
      expectTransition: false,
    },
  ];

  it.each(cases)('$name', async ({ setup, taskId, expectTransition }) => {
    setup(db);

    await pollQuiescence();

    const status = getWorkflowStatus(db, taskId);
    if (expectTransition) {
      expect(status).toBe('human_review');
      // Exactly one transition task_update row must be written
      expect(countTaskUpdates(db, taskId)).toBe(1);
      const update = db
        .prepare(`SELECT * FROM task_updates WHERE task_id = ?`)
        .get(taskId) as Record<string, unknown>;
      expect(update.kind).toBe('transition');
      expect(update.from_status).toBe('in_progress');
      expect(update.to_status).toBe('human_review');
      expect(update.body).toBe('auto: agent stopped');
    } else {
      // No transition should have been written (regardless of initial status)
      expect(countTaskUpdates(db, taskId)).toBe(0);
    }
  });

  it('transitions only once even when called twice (idempotent)', async () => {
    insertTask(db, { id: 'task-idem', runtime_state: 'running', workflow_status: 'in_progress' });
    insertAgent(db, {
      id: 'agent-idem',
      task_id: 'task-idem',
      status: 'running',
      hook_token: 'tok-idem',
    } as any);
    setWorkerActivity(db, 'agent-idem', 'idle', `datetime('now', '-120 seconds')`);

    await pollQuiescence();
    await pollQuiescence();

    expect(getWorkflowStatus(db, 'task-idem')).toBe('human_review');
    // Only one task_update row — second call skips (workflow_status != 'in_progress')
    expect(countTaskUpdates(db, 'task-idem')).toBe(1);
  });

  it('task with no workers is not transitioned (no workers = not yet started)', async () => {
    insertTask(db, {
      id: 'task-noworker',
      runtime_state: 'running',
      workflow_status: 'in_progress',
    });
    // No workers inserted

    await pollQuiescence();

    expect(getWorkflowStatus(db, 'task-noworker')).toBe('in_progress');
  });
});
