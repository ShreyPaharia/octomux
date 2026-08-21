/**
 * `PATCH /api/tasks/:id` — regression coverage for SHR-278.
 *
 * A stale client (the pre-rename `{ status: 'closed' }` body) used to fall
 * through every branch of the if/else-if chain and reach `fetchTaskBundle`
 * unchanged, returning 200 with nothing done — four tasks silently failed to
 * close in production and nothing in the response or logs said so. These
 * tests assert the observable effect (DB state, closeTask invocation), not
 * just the status code, since the whole point of the bug was a status code
 * lying about what happened.
 *
 * `closeTask` is mocked rather than exercised down to the tmux layer: this
 * file owns only the route, `server/task-engine/cleanup.ts` (closeTask's real
 * implementation) is being changed concurrently by another agent, and
 * `server/api.test.ts` already establishes mocking `closeTask` at the
 * `../task-engine/index.js` boundary as this codebase's route-test pattern
 * for the PATCH endpoint (see its `describe('PATCH /api/tasks/:id')` block).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from '../bun-test.js';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], ..._rest: any[]) => {
    const cb = _rest.find((a: any) => typeof a === 'function');
    if (cb) cb(null, { stdout: '', stderr: '' });
    return undefined;
  }),
}));

vi.mock('../task-engine/index.js', () => {
  const actual =
    vi.importActual<typeof import('../task-engine/index.js')>('../task-engine/index.js');
  const { getDb } = vi.importActual<typeof import('../db.js')>('../db.js');
  return {
    ...actual,
    closeTask: vi.fn(async (task: any) => {
      const db = getDb();
      db.prepare(
        `UPDATE tasks SET runtime_state = 'idle', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
      db.prepare(`UPDATE workers SET status = 'stopped' WHERE task_id = ?`).run(task.id);
    }),
  };
});

const { default: request } = await import('supertest');
const { createTestDb, insertTask, getTask, DEFAULTS, createTestHttpServer } =
  await import('../test-helpers.js');
const { getDb } = await import('../db.js');
const { createApp } = await import('../app.js');
const { closeTask } = await import('../task-engine/index.js');

// Full app on a real (never-closed) http.Server, per createTestHttpServer's
// doc comment — request(app) directly would listen/close per request.
const http_ = createTestHttpServer();

beforeEach(() => {
  createTestDb();
  http_.use(createApp() as unknown as (req: unknown, res: unknown) => void);
  vi.mocked(closeTask).mockClear();
});

afterAll(() => {
  http_.close();
});

describe('PATCH /api/tasks/:id', () => {
  it('rejects a stale-client body matching no branch (SHR-278 regression) and changes nothing', async () => {
    insertTask(getDb(), { ...DEFAULTS.runningTask });

    const res = await request(http_.server)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ status: 'closed' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('status');
    expect(res.body.error).toContain('runtime_state');
    expect(closeTask).not.toHaveBeenCalled();

    const after = getTask(getDb(), DEFAULTS.task.id);
    expect(after?.runtime_state).toBe(DEFAULTS.runningTask.runtime_state);
  });

  it('rejects an empty body', async () => {
    insertTask(getDb(), { ...DEFAULTS.runningTask });

    const res = await request(http_.server).patch(`/api/tasks/${DEFAULTS.task.id}`).send({});

    expect(res.status).toBe(400);
    expect(closeTask).not.toHaveBeenCalled();
  });

  it('closes a running task: 200, DB flips to idle, closeTask invoked for that task', async () => {
    insertTask(getDb(), { ...DEFAULTS.runningTask });

    const res = await request(http_.server)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ runtime_state: 'idle' });

    expect(res.status).toBe(200);
    expect(res.body.runtime_state).toBe('idle');
    expect(closeTask).toHaveBeenCalledOnce();
    expect(vi.mocked(closeTask).mock.calls[0][0].id).toBe(DEFAULTS.task.id);

    const after = getTask(getDb(), DEFAULTS.task.id);
    expect(after?.runtime_state).toBe('idle');
  });

  it('returns 409 for runtime_state=idle on an already-idle task, and does not call closeTask', async () => {
    insertTask(getDb(), { ...DEFAULTS.task }); // default fixture is runtime_state=idle

    const res = await request(http_.server)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ runtime_state: 'idle' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already closed');
    expect(closeTask).not.toHaveBeenCalled();
  });

  it('still applies a draft field update (title) — the draft path is unaffected', async () => {
    insertTask(getDb(), { ...DEFAULTS.task }); // draft (runtime_state=idle)

    const res = await request(http_.server)
      .patch(`/api/tasks/${DEFAULTS.task.id}`)
      .send({ title: 'Updated title' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated title');

    const after = getTask(getDb(), DEFAULTS.task.id);
    expect(after?.title).toBe('Updated title');
  });
});
