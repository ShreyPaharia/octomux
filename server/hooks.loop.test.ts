/**
 * Loop harness: Stop hook guard tests.
 *
 * Verifies POST /api/hooks/stop dispatches to the loop engine — and bypasses
 * human_review/task_updates/fireHook/summarizer entirely — when the stopping
 * agent's task has runtime_state='looping'. A non-looping task keeps the
 * existing B4 behavior unchanged.
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

vi.mock('./task-engine/loop/engine.js', () => ({
  handleLoopIterationBoundary: vi.fn(async () => undefined),
}));

vi.mock('./summarize.js', () => ({
  summarizeAgentProgress: vi.fn(async () => undefined),
}));

describe('Stop hook: loop guard', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    app = createApp();
  });

  it.each([{ runtime_state: 'looping' as const }, { runtime_state: 'running' as const }])(
    'runtime_state=$runtime_state',
    async ({ runtime_state }) => {
      insertTask(db, { id: 't1', runtime_state, workflow_status: 'in_progress' });
      insertAgent(db, {
        id: 'a1',
        task_id: 't1',
        harness_session_id: 'sess-123',
        hook_token: 'tok-loop',
        status: 'running',
      } as any);

      const { handleLoopIterationBoundary } = await import('./task-engine/loop/engine.js');
      const { fireHook } = await import('./hook-dispatcher.js');
      const { summarizeAgentProgress } = await import('./summarize.js');

      await request(app)
        .post('/api/hooks/stop?token=tok-loop')
        .send({ session_id: 'sess-123' })
        .expect(200);

      const task = db.prepare('SELECT workflow_status FROM tasks WHERE id = ?').get('t1') as {
        workflow_status: string;
      };
      const update = db
        .prepare(`SELECT * FROM task_updates WHERE task_id = 't1' AND kind = 'transition'`)
        .get();

      if (runtime_state === 'looping') {
        expect(handleLoopIterationBoundary).toHaveBeenCalledWith('t1', 'a1');
        expect(task.workflow_status).toBe('in_progress');
        expect(update).toBeUndefined();
        expect(fireHook).not.toHaveBeenCalled();
        expect(summarizeAgentProgress).not.toHaveBeenCalled();
      } else {
        expect(handleLoopIterationBoundary).not.toHaveBeenCalled();
        expect(task.workflow_status).toBe('human_review');
        expect(update).not.toBeUndefined();
        expect(fireHook).toHaveBeenCalled();
        expect(summarizeAgentProgress).toHaveBeenCalled();
      }
    },
  );
});
