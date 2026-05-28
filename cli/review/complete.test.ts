import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../../server/test-helpers.js';
import { runComplete } from './complete.js';
import { getDb } from '../../server/db.js';
import { broadcast } from '../../server/events.js';

vi.mock('../../server/events.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../server/review-staleness.js', () => ({
  autoResolvePublished: vi.fn(async () => undefined),
  markStaleDrafts: vi.fn(async () => undefined),
}));

let stdoutBuf = '';
let stderrBuf = '';

beforeEach(() => {
  stdoutBuf = '';
  stderrBuf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdoutBuf += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderrBuf += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  vi.mocked(broadcast).mockReset();
});

function seed(): void {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source)
     VALUES ('t1', 'x', '', 'running', 'backlog', 'auto_review')`,
  ).run();
  db.prepare(`INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES ('r1', 't1', 'sha')`).run();
}

describe('octomux review complete', () => {
  it('marks the run completed, runs auto-resolve, broadcasts drafts-ready', async () => {
    seed();
    await runComplete(['--task', 't1']);
    const row = getDb()
      .prepare(`SELECT status, completed_at FROM review_runs WHERE id = 'r1'`)
      .get() as { status: string; completed_at: string | null };
    expect(row.status).toBe('completed');
    expect(row.completed_at).not.toBeNull();
    expect(broadcast).toHaveBeenCalledWith({
      type: 'review:drafts-ready',
      payload: { taskId: 't1', reviewRunId: 'r1' },
    });
    expect(stdoutBuf).toMatch(/"ok":true/);
  });

  it('refuses to complete a run that has no walkthrough when --require-walkthrough is set', async () => {
    seed();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error('exit ' + code);
    }) as typeof process.exit);
    await expect(runComplete(['--task', 't1', '--require-walkthrough'])).rejects.toThrow(/exit 2/);
    expect(stderrBuf).toMatch(/walkthrough has not been written/);
    exitSpy.mockRestore();
  });
});
