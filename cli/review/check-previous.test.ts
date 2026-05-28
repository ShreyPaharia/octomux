import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../../server/test-helpers.js';
import { runCheckPrevious } from './check-previous.js';
import { getDb } from '../../server/db.js';

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
});

function seed(): void {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source, pr_head_sha)
     VALUES ('t1', 'x', '', 'running', 'backlog', 'auto_review', 'sha')`,
  ).run();
  db.prepare(`INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES ('r1', 't1', 'sha')`).run();
  db.prepare(
    `INSERT INTO inline_comments
       (id, task_id, file_path, line, side, original_commit_sha, body, status, kind)
     VALUES ('p1', 't1', 'a.ts', 5, 'new', 'sha-prev', 'b', 'published', 'comment')`,
  ).run();
}

describe('octomux review check-previous', () => {
  it('records resolved status', async () => {
    seed();
    await runCheckPrevious(['--comment', 'p1', '--status', 'resolved']);
    const row = getDb()
      .prepare(`SELECT last_check_status, last_check_run_id FROM inline_comments WHERE id = 'p1'`)
      .get() as { last_check_status: string; last_check_run_id: string };
    expect(row.last_check_status).toBe('resolved');
    expect(row.last_check_run_id).toBe('r1');
  });

  it('with status=still_applies and --reflag-body, inserts a fresh re_flag_of draft', async () => {
    seed();
    await runCheckPrevious([
      '--comment',
      'p1',
      '--status',
      'still_applies',
      '--reflag-body',
      'still not handling null',
    ]);
    const drafts = getDb()
      .prepare(`SELECT * FROM inline_comments WHERE re_flag_of = 'p1'`)
      .all() as Record<string, unknown>[];
    expect(drafts).toHaveLength(1);
    expect(drafts[0].body).toBe('still not handling null');
    expect(drafts[0].status).toBe('draft');
    expect(drafts[0].review_run_id).toBe('r1');
  });

  it('without --reflag-body, no draft is created even for still_applies', async () => {
    seed();
    await runCheckPrevious(['--comment', 'p1', '--status', 'still_applies']);
    const drafts = getDb()
      .prepare(`SELECT * FROM inline_comments WHERE re_flag_of = 'p1'`)
      .all() as Record<string, unknown>[];
    expect(drafts).toHaveLength(0);
  });

  it('does not flag stderr on the happy path', async () => {
    seed();
    await runCheckPrevious(['--comment', 'p1', '--status', 'resolved']);
    expect(stderrBuf).toBe('');
  });
});
