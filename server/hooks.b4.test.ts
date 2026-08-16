/**
 * Quiescence-guarded in_progress → human_review transition tests.
 *
 * The B4 synchronous transition was removed from the Stop hook and replaced by
 * the quiescence poller (pollQuiescence). These tests verify that Stop no longer
 * transitions the task, and that the quiescence poller does so when the agent
 * has been genuinely idle past the debounce window.
 *
 * Poller-level tests live in server/poller/quiescence.test.ts.
 */
import Database from './sqlite.js';
import { describe, it, expect, beforeEach, vi } from './bun-test.js';

vi.mock('./hook-dispatcher.js', () => ({
  fireHook: vi.fn(),
  getTaskHookExecutions: vi.fn(async () => []),
}));

const { default: request } = await import('supertest');
const { createTestDb, insertTask, insertAgent, insertPermissionPrompt } = await import('./test-helpers.js');
const { createApp } = await import('./app.js');

describe('B4 (removed): POST /api/hooks/stop no longer synchronously transitions to human_review', () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    vi.clearAllMocks();
    insertTask(db, { id: 't1', runtime_state: 'running', workflow_status: 'in_progress' });
    insertAgent(db, {
      id: 'a1',
      task_id: 't1',
      harness_session_id: 'sess-123',
      hook_token: 'tok-b4',
      status: 'running',
    } as any);
  });

  it('Stop does NOT transition in_progress → human_review (debounced via quiescence poller)', async () => {
    await request(app)
      .post('/api/hooks/stop?token=tok-b4')
      .send({ session_id: 'sess-123' })
      .expect(200);

    const task = db.prepare('SELECT workflow_status FROM tasks WHERE id = ?').get('t1') as {
      workflow_status: string;
    };
    // Must remain in_progress — quiescence poller handles the transition after debounce
    expect(task.workflow_status).toBe('in_progress');

    const update = db
      .prepare(`SELECT * FROM task_updates WHERE task_id = 't1' AND kind = 'transition'`)
      .get();
    expect(update).toBeUndefined();
  });

  it('Stop does NOT fire workflow_status_changed (that belongs to the quiescence poller)', async () => {
    const { fireHook } = await import('./hook-dispatcher.js');

    await request(app)
      .post('/api/hooks/stop?token=tok-b4')
      .send({ session_id: 'sess-123' })
      .expect(200);

    expect(fireHook).not.toHaveBeenCalledWith('workflow_status_changed', expect.anything());
  });

  it('Stop sets agent to idle regardless', async () => {
    const row = db.prepare(`SELECT hook_activity FROM workers WHERE id = 'a1'`).get() as {
      hook_activity: string;
    };
    // starts active
    expect(row.hook_activity).toBe('active');

    await request(app)
      .post('/api/hooks/stop?token=tok-b4')
      .send({ session_id: 'sess-123' })
      .expect(200);

    const after = db.prepare(`SELECT hook_activity FROM workers WHERE id = 'a1'`).get() as {
      hook_activity: string;
    };
    expect(after.hook_activity).toBe('idle');
  });

  it('workflow_status remains in_progress even when pending prompts exist', async () => {
    insertPermissionPrompt(db, {
      id: 'pp1',
      task_id: 't1',
      agent_id: null,
      session_id: 'sess-other',
      status: 'pending',
    });

    await request(app)
      .post('/api/hooks/stop?token=tok-b4')
      .send({ session_id: 'sess-123' })
      .expect(200);

    const task = db.prepare('SELECT workflow_status FROM tasks WHERE id = ?').get('t1') as {
      workflow_status: string;
    };
    expect(task.workflow_status).toBe('in_progress');
  });

  it.each([
    { workflow_status: 'backlog' as const },
    { workflow_status: 'planned' as const },
    { workflow_status: 'pr' as const },
    { workflow_status: 'done' as const },
  ])('tasks in $workflow_status are not modified by Stop', async ({ workflow_status }) => {
    db.prepare('UPDATE tasks SET workflow_status = ? WHERE id = ?').run(workflow_status, 't1');

    await request(app)
      .post('/api/hooks/stop?token=tok-b4')
      .send({ session_id: 'sess-123' })
      .expect(200);

    const task = db.prepare('SELECT workflow_status FROM tasks WHERE id = ?').get('t1') as {
      workflow_status: string;
    };
    expect(task.workflow_status).toBe(workflow_status);
  });
});
