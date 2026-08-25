import { describe, it, expect, beforeEach, vi } from '../bun-test.js';
import type Database from '../sqlite.js';

const execTmuxMock = vi.fn();
vi.mock('../tmux-bin.js', () => ({
  execTmux: execTmuxMock,
}));

const { createTestDb, insertTask, insertAgent, insertPermissionPrompt } =
  await import('../test-helpers.js');
const { pollReviewStalls } = await import('./review-stall.js');

function setWorkerActivity(db: Database, agentId: string, activity: string, updatedAtExpr: string) {
  db.prepare(
    `UPDATE workers SET hook_activity = ?, hook_activity_updated_at = ${updatedAtExpr} WHERE id = ?`,
  ).run(activity, agentId);
}

function insertStalledReviewTask(
  db: Database,
  id: string,
  overrides: Record<string, unknown> = {},
) {
  insertTask(db, {
    id,
    runtime_state: 'running',
    workflow_status: 'in_progress',
    tmux_session: `octomux-agent-${id}`,
    source: 'auto_review',
    ...overrides,
  } as never);
  insertAgent(db, {
    id: `agent-${id}`,
    task_id: id,
    status: 'running',
    hook_token: `tok-${id}`,
  } as never);
  // Stale 'active' — the mid-stream-death shape (Stop hook never fired).
  setWorkerActivity(db, `agent-${id}`, 'active', `datetime('now', '-1200 seconds')`);
}

function insertStallNudgeNote(db: Database, taskId: string, n: number, createdAtExpr: string) {
  for (let i = 0; i < n; i++) {
    db.prepare(
      `INSERT INTO task_updates (id, task_id, kind, body, created_at)
       VALUES (?, ?, 'note', 'auto: stall nudge', ${createdAtExpr})`,
    ).run(`nudge-${taskId}-${i}`, taskId);
  }
}

function countStallNudges(db: Database, taskId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM task_updates
          WHERE task_id = ? AND kind = 'note' AND body = 'auto: stall nudge'`,
      )
      .get(taskId) as { n: number }
  ).n;
}

function sendKeysCalls(): string[][] {
  return execTmuxMock.mock.calls
    .map((c: unknown[]) => c[0] as string[])
    .filter((args) => args[0] === 'send-keys');
}

describe('pollReviewStalls', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    execTmuxMock.mockReset();
    // Default pane: idle prompt, no in-flight marker.
    execTmuxMock.mockResolvedValue({ stdout: '❯\n⏵⏵ bypass permissions on', stderr: '' });
  });

  it('nudges a stale-active auto-review task and records the note', async () => {
    insertStalledReviewTask(db, 'task-s1');

    await pollReviewStalls();

    const sends = sendKeysCalls();
    expect(sends.length).toBe(2); // message + Enter
    expect(sends[0]).toContain('-l');
    expect(String(sends[0].at(-1))).toContain('close-task task-s1');
    expect(countStallNudges(db, 'task-s1')).toBe(1);
  });

  it('skips when the pane shows an in-flight turn (esc to interrupt)', async () => {
    insertStalledReviewTask(db, 'task-s2');
    execTmuxMock.mockResolvedValue({
      stdout: '✽ Booping… (25m 3s)\nesc to interrupt',
      stderr: '',
    });

    await pollReviewStalls();

    expect(sendKeysCalls().length).toBe(0);
    expect(countStallNudges(db, 'task-s2')).toBe(0);
  });

  it('nudges anyway when pane capture fails (fail open)', async () => {
    insertStalledReviewTask(db, 'task-s3');
    execTmuxMock.mockImplementation((args: string[]) => {
      if (args[0] === 'capture-pane') return Promise.reject(new Error('no such pane'));
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await pollReviewStalls();

    expect(sendKeysCalls().length).toBe(2);
    expect(countStallNudges(db, 'task-s3')).toBe(1);
  });

  const skipped = [
    {
      name: 'non-review task',
      setup: (db: Database) => insertStalledReviewTask(db, 'task-x', { source: null }),
      taskId: 'task-x',
    },
    {
      name: 'recent hook activity',
      setup: (db: Database) => {
        insertStalledReviewTask(db, 'task-x');
        setWorkerActivity(db, 'agent-task-x', 'active', `datetime('now', '-60 seconds')`);
      },
      taskId: 'task-x',
    },
    {
      name: 'nudge cap reached',
      setup: (db: Database) => {
        insertStalledReviewTask(db, 'task-x');
        insertStallNudgeNote(db, 'task-x', 3, `datetime('now', '-7200 seconds')`);
      },
      taskId: 'task-x',
    },
    {
      name: 'nudged within the stall window',
      setup: (db: Database) => {
        insertStalledReviewTask(db, 'task-x');
        insertStallNudgeNote(db, 'task-x', 1, `datetime('now', '-120 seconds')`);
      },
      taskId: 'task-x',
    },
    {
      name: 'pending permission prompt',
      setup: (db: Database) => {
        insertStalledReviewTask(db, 'task-x');
        insertPermissionPrompt(db, {
          id: 'pp-x',
          task_id: 'task-x',
          agent_id: 'agent-task-x',
          session_id: 'sess-x',
          status: 'pending',
        });
      },
      taskId: 'task-x',
    },
    {
      name: 'task not running',
      setup: (db: Database) => insertStalledReviewTask(db, 'task-x', { runtime_state: 'idle' }),
      taskId: 'task-x',
    },
  ];

  it.each(skipped)('does not nudge: $name', async ({ setup }) => {
    setup(db);

    await pollReviewStalls();

    expect(sendKeysCalls().length).toBe(0);
  });

  it('stops nudging after the cap across sweeps', async () => {
    insertStalledReviewTask(db, 'task-cap');
    // Simulate three past nudges older than the stall window.
    insertStallNudgeNote(db, 'task-cap', 3, `datetime('now', '-3600 seconds')`);

    await pollReviewStalls();

    expect(sendKeysCalls().length).toBe(0);
    expect(countStallNudges(db, 'task-cap')).toBe(3);
  });
});
