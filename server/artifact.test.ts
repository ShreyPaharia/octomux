/**
 * server/artifact.test.ts
 *
 * Unit coverage for the `.octomux/artifact.md` Summary section — the
 * read/write path that replaces `tasks.current_summary` (+`_updated_at`).
 */
import { describe, it, expect, beforeEach, afterEach } from './bun-test.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createTestDb, insertTask } from './test-helpers.js';
import { getDb } from './db.js';
import { getArtifactSummary, hasArtifactSummary, setArtifactSummary } from './artifact.js';
import { setTaskSummary } from './artifact-task.js';

describe('artifact Summary section', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-artifact-unit-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns nulls when no worktree or no artifact file exists', () => {
    expect(getArtifactSummary(null)).toEqual({
      current_summary: null,
      current_summary_updated_at: null,
    });
    expect(getArtifactSummary(tmpDir)).toEqual({
      current_summary: null,
      current_summary_updated_at: null,
    });
  });

  it('writes and round-trips a summary with a sqlite-shaped timestamp', () => {
    const { updatedAt } = setArtifactSummary(tmpDir, 'Agent fixed the thing');
    expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const read = getArtifactSummary(tmpDir);
    expect(read.current_summary).toBe('Agent fixed the thing');
    expect(read.current_summary_updated_at).toBe(updatedAt);

    const raw = fs.readFileSync(path.join(tmpDir, '.octomux', 'artifact.md'), 'utf8');
    expect(raw).toContain('## Summary');
    expect(raw).toContain('Agent fixed the thing');
  });

  it('overwriting the summary replaces the old text and timestamp', () => {
    setArtifactSummary(tmpDir, 'first');
    const { updatedAt: t2 } = setArtifactSummary(tmpDir, 'second');
    const read = getArtifactSummary(tmpDir);
    expect(read.current_summary).toBe('second');
    expect(read.current_summary_updated_at).toBe(t2);
  });

  it('preserves other hand-written sections untouched', () => {
    fs.mkdirSync(path.join(tmpDir, '.octomux'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.octomux', 'artifact.md'),
      '## Plan\n\nDo the thing.\n\n## Summary\n',
    );
    setArtifactSummary(tmpDir, 'in progress');
    const raw = fs.readFileSync(path.join(tmpDir, '.octomux', 'artifact.md'), 'utf8');
    expect(raw).toContain('## Plan');
    expect(raw).toContain('Do the thing.');
    expect(raw).toContain('in progress');
  });

  it('setTaskSummary resolves the worktree by task id and writes there', () => {
    const db = createTestDb();
    insertTask(db, { id: 'task-art-1', worktree: tmpDir, repo_path: '/tmp/repo' });

    setTaskSummary('task-art-1', 'wrote via task id');

    const found = getDb()
      .prepare(
        `SELECT w.path AS worktree FROM tasks t JOIN worktrees w ON t.worktree_id = w.id WHERE t.id = ?`,
      )
      .get('task-art-1') as { worktree: string };
    expect(getArtifactSummary(found.worktree).current_summary).toBe('wrote via task id');
  });

  it('setTaskSummary is a no-op (does not throw) when the task has no worktree', () => {
    const db = createTestDb();
    insertTask(db, { id: 'task-no-wt', worktree: null });
    expect(() => setTaskSummary('task-no-wt', 'unreachable')).not.toThrow();
  });

  it('setArtifactSummary preserves an explicit timestamp instead of restamping to now', () => {
    // The back-fill relies on this: a migrated summary must keep its original
    // updated_at, or every stale summary looks freshly written on upgrade and
    // BoardCard's staleness indicator silently lies.
    setArtifactSummary(tmpDir, 'migrated body', '2020-01-02 03:04:05');
    const got = getArtifactSummary(tmpDir);
    expect(got.current_summary).toBe('migrated body');
    expect(got.current_summary_updated_at).toBe('2020-01-02 03:04:05');
  });

  it('hasArtifactSummary distinguishes an absent artifact from one with a Summary', () => {
    expect(hasArtifactSummary(tmpDir)).toBe(false);
    setArtifactSummary(tmpDir, 'now present');
    expect(hasArtifactSummary(tmpDir)).toBe(true);
  });

  it('back-fill is idempotent: a second pass does not clobber an edited Summary', () => {
    // runMigrations re-runs on every startup, so the guard that skips tasks
    // whose artifact already has a Summary is what stops a restart from
    // reverting post-migration edits back to the retired column's text.
    setArtifactSummary(tmpDir, 'original from column', '2020-01-02 03:04:05');
    if (!hasArtifactSummary(tmpDir)) setArtifactSummary(tmpDir, 'would overwrite');
    expect(getArtifactSummary(tmpDir).current_summary).toBe('original from column');
  });
});
