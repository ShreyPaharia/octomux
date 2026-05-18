/**
 * UserPromptSubmit hook → in_progress auto-transition tests.
 *
 * Mirrors B4 (Stop → human_review). When the user submits a prompt to an agent
 * whose task is in human_review, the task auto-transitions back to in_progress.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createTestDb, insertTask, insertAgent } from './test-helpers.js';
import { createApp } from './app.js';

vi.mock('./hook-dispatcher.js', () => ({
  fireHook: vi.fn(),
  getTaskHookExecutions: vi.fn(async () => []),
}));

describe('POST /api/hooks/user-prompt-submit → in_progress transition', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    vi.clearAllMocks();
    insertTask(db, { id: 't1', runtime_state: 'running', workflow_status: 'human_review' });
    insertAgent(db, { id: 'a1', task_id: 't1', claude_session_id: 'sess-123', status: 'running' });
  });

  it('transitions human_review → in_progress when user submits a prompt', async () => {
    await request(app)
      .post('/api/hooks/user-prompt-submit')
      .send({ session_id: 'sess-123' })
      .expect(200);

    const task = db.prepare('SELECT workflow_status FROM tasks WHERE id = ?').get('t1') as {
      workflow_status: string;
    };
    expect(task.workflow_status).toBe('in_progress');

    const update = db
      .prepare(`SELECT * FROM task_updates WHERE task_id = 't1' AND kind = 'transition'`)
      .get() as { from_status: string; to_status: string; body: string } | undefined;
    expect(update).toBeDefined();
    expect(update!.from_status).toBe('human_review');
    expect(update!.to_status).toBe('in_progress');
    expect(update!.body).toBe('auto: user replied');
  });

  it('fires workflow_status_changed hook on transition', async () => {
    const { fireHook } = await import('./hook-dispatcher.js');

    await request(app)
      .post('/api/hooks/user-prompt-submit')
      .send({ session_id: 'sess-123' })
      .expect(200);

    expect(fireHook).toHaveBeenCalledWith(
      'workflow_status_changed',
      expect.objectContaining({
        event: 'workflow_status_changed',
        data: expect.objectContaining({ from: 'human_review', to: 'in_progress' }),
      }),
    );
  });

  it.each([
    { workflow_status: 'backlog' as const },
    { workflow_status: 'planned' as const },
    { workflow_status: 'in_progress' as const },
    { workflow_status: 'pr' as const },
    { workflow_status: 'done' as const },
    { workflow_status: 'archived' as const },
  ])('skips transition when task is in $workflow_status', async ({ workflow_status }) => {
    db.prepare('UPDATE tasks SET workflow_status = ? WHERE id = ?').run(workflow_status, 't1');

    await request(app)
      .post('/api/hooks/user-prompt-submit')
      .send({ session_id: 'sess-123' })
      .expect(200);

    const task = db.prepare('SELECT workflow_status FROM tasks WHERE id = ?').get('t1') as {
      workflow_status: string;
    };
    expect(task.workflow_status).toBe(workflow_status);

    const update = db
      .prepare(`SELECT * FROM task_updates WHERE task_id = 't1' AND kind = 'transition'`)
      .get();
    expect(update).toBeUndefined();
  });

  it('does not fire workflow_status_changed when no transition occurs', async () => {
    db.prepare(`UPDATE tasks SET workflow_status = 'in_progress' WHERE id = 't1'`).run();
    const { fireHook } = await import('./hook-dispatcher.js');

    await request(app)
      .post('/api/hooks/user-prompt-submit')
      .send({ session_id: 'sess-123' })
      .expect(200);

    expect(fireHook).not.toHaveBeenCalled();
  });
});
