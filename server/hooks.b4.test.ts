/**
 * B4: Stop hook → human_review auto-transition tests.
 *
 * Verifies that POST /api/hooks/stop transitions in_progress → human_review
 * when the stopping agent is the last running one and no pending prompts remain.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createTestDb, insertTask, insertAgent, insertPermissionPrompt } from './test-helpers.js';
import { createApp } from './app.js';

vi.mock('./hook-dispatcher.js', () => ({
  fireHook: vi.fn(),
  getTaskHookExecutions: vi.fn(async () => []),
}));

describe('B4: POST /api/hooks/stop → human_review transition', () => {
  let db: Database.Database;
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

  it('transitions in_progress → human_review when last agent stops', async () => {
    await request(app)
      .post('/api/hooks/stop?token=tok-b4')
      .send({ session_id: 'sess-123' })
      .expect(200);

    const task = db.prepare('SELECT workflow_status FROM tasks WHERE id = ?').get('t1') as {
      workflow_status: string;
    };
    expect(task.workflow_status).toBe('human_review');

    const update = db
      .prepare(`SELECT * FROM task_updates WHERE task_id = 't1' AND kind = 'transition'`)
      .get() as any;
    expect(update).not.toBeNull();
    expect(update.from_status).toBe('in_progress');
    expect(update.to_status).toBe('human_review');
    expect(update.body).toBe('auto: agent stopped');
  });

  it('fires workflow_status_changed hook on transition', async () => {
    const { fireHook } = await import('./hook-dispatcher.js');

    await request(app)
      .post('/api/hooks/stop?token=tok-b4')
      .send({ session_id: 'sess-123' })
      .expect(200);

    expect(fireHook).toHaveBeenCalledWith(
      'workflow_status_changed',
      expect.objectContaining({
        event: 'workflow_status_changed',
        data: expect.objectContaining({ from: 'in_progress', to: 'human_review' }),
      }),
    );
  });

  it('skips transition when other agents are still running', async () => {
    // Add a second running agent
    insertAgent(db, {
      id: 'a2',
      task_id: 't1',
      harness_session_id: 'sess-456',
      hook_token: 'tok-b4-2',
      status: 'running',
      window_index: 1,
    } as any);

    await request(app)
      .post('/api/hooks/stop?token=tok-b4')
      .send({ session_id: 'sess-123' })
      .expect(200);

    const task = db.prepare('SELECT workflow_status FROM tasks WHERE id = ?').get('t1') as {
      workflow_status: string;
    };
    // Should remain in_progress because a2 is still running
    expect(task.workflow_status).toBe('in_progress');
  });

  it('skips transition when pending permission prompts remain', async () => {
    insertPermissionPrompt(db, {
      id: 'pp1',
      task_id: 't1',
      agent_id: null, // no agent (or same agent — just needs to be pending)
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
  ])('skips transition when task is in $workflow_status', async ({ workflow_status }) => {
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
