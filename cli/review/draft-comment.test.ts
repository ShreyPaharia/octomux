import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createTestDb } from '../../server/test-helpers.js';
import { runDraftComment } from './draft-comment.js';
import { getDb } from '../../server/db.js';

let tmpDir: string;
let stdoutBuf = '';
let stderrBuf = '';

vi.mock('../../server/inline-comments-outdated.js', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    isAnchorOutdated: vi.fn(async () => false),
  };
});

vi.mock('../../server/diff.js', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    showFileAtSha: vi.fn(async () => 'line1\nline2\nline3\nline4\nline5\n'),
  };
});

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-dc-'));
});

function seed(): void {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, base_sha, mode, status)
     VALUES ('wt1', ?, '/repos/foo', 'review/x', 'main', 'sha-base', 'new', 'available')`,
  ).run(tmpDir);
  db.prepare(
    `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source, worktree_id, pr_head_sha)
     VALUES ('t1', 'x', '', 'running', 'backlog', 'auto_review', 'wt1', 'sha-head')`,
  ).run();
  db.prepare(
    `INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES ('r1', 't1', 'sha-head')`,
  ).run();
}

describe('octomux review draft-comment (kind=comment)', () => {
  it('inserts a draft inline comment and prints its id', async () => {
    seed();
    await runDraftComment([
      '--task',
      't1',
      '--file',
      'server/db.ts',
      '--line',
      '3',
      '--side',
      'new',
      '--severity',
      'issue',
      '--bucket',
      'actionable',
      '--body',
      'Consider X.',
    ]);
    const out = JSON.parse(stdoutBuf);
    expect(out.id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
    expect(out.status).toBe('draft');

    const row = getDb().prepare(`SELECT * FROM inline_comments WHERE id = ?`).get(out.id) as Record<
      string,
      unknown
    >;
    expect(row.kind).toBe('comment');
    expect(row.severity).toBe('issue');
    expect(row.bucket).toBe('actionable');
    expect(row.body).toBe('Consider X.');
    expect(row.review_run_id).toBe('r1');
    expect(row.original_commit_sha).toBe('sha-head');
  });

  it('inserts a suggestion when existing_code matches the file verbatim', async () => {
    seed();
    await runDraftComment([
      '--task',
      't1',
      '--file',
      'server/db.ts',
      '--line',
      '3',
      '--side',
      'new',
      '--severity',
      'nit',
      '--bucket',
      'actionable',
      '--kind',
      'suggestion',
      '--existing-code',
      'line3',
      '--suggested-code',
      'line3-improved',
      '--body',
      'cleaner.',
    ]);
    const out = JSON.parse(stdoutBuf);
    expect(out.id).toBeTruthy();
    const row = getDb().prepare('SELECT * FROM inline_comments WHERE id = ?').get(out.id) as Record<
      string,
      unknown
    >;
    expect(row.kind).toBe('suggestion');
    expect(row.existing_code).toBe('line3');
    expect(row.suggested_code).toBe('line3-improved');
  });

  it('rejects suggestion when existing_code does not match the file at the line range', async () => {
    seed();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    await expect(
      runDraftComment([
        '--task',
        't1',
        '--file',
        'server/db.ts',
        '--line',
        '3',
        '--side',
        'new',
        '--severity',
        'nit',
        '--bucket',
        'actionable',
        '--kind',
        'suggestion',
        '--existing-code',
        'wrong content',
        '--suggested-code',
        'whatever',
        '--body',
        'x',
      ]),
    ).rejects.toThrow(/exit 2/);
    expect(stderrBuf).toMatch(/existing_code mismatch/);
    expect(stderrBuf).toMatch(/-line3/);
    exitSpy.mockRestore();
  });

  it('validates multi-line suggestion against the start-line..line range', async () => {
    seed();
    await runDraftComment([
      '--task',
      't1',
      '--file',
      'server/db.ts',
      '--start-line',
      '2',
      '--line',
      '4',
      '--side',
      'new',
      '--severity',
      'nit',
      '--bucket',
      'actionable',
      '--kind',
      'suggestion',
      '--existing-code',
      'line2\nline3\nline4',
      '--suggested-code',
      'replacement',
      '--body',
      'x',
    ]);
    const out = JSON.parse(stdoutBuf);
    expect(out.id).toBeTruthy();
  });

  it('rejects an out-of-range line', async () => {
    seed();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    await expect(
      runDraftComment([
        '--task',
        't1',
        '--file',
        'server/db.ts',
        '--line',
        '99',
        '--side',
        'new',
        '--severity',
        'nit',
        '--bucket',
        'actionable',
        '--body',
        'x',
      ]),
    ).rejects.toThrow(/exit 2/);
    expect(stderrBuf).toMatch(/line 99 is out of range/);
    exitSpy.mockRestore();
  });
});
