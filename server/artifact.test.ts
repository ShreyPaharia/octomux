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
import {
  getArtifactSummary,
  hasArtifactSummary,
  setArtifactSummary,
  getArtifactActivity,
  setArtifactActivity,
  parseSections,
  serializeSections,
} from './artifact.js';
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

  // ── Preamble preservation (Defect B regression) ──────────────────────────

  it('preserves the # Title + lede preamble above the first heading when writing a Summary', () => {
    fs.mkdirSync(path.join(tmpDir, '.octomux'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.octomux', 'artifact.md'),
      '# SHR-275 — `ctx.example`\n\nSome lede paragraph about the shipped work.\n\n' +
        '## What shipped\n\nDetails here.\n',
    );

    setArtifactSummary(tmpDir, 'in progress');

    const raw = fs.readFileSync(path.join(tmpDir, '.octomux', 'artifact.md'), 'utf8');
    expect(raw).toContain('# SHR-275 — `ctx.example`');
    expect(raw).toContain('Some lede paragraph about the shipped work.');
    expect(raw).toContain('## What shipped');
    expect(raw).toContain('Details here.');
    expect(raw).toContain('in progress');
    // Preamble must still be first, above every heading.
    expect(raw.indexOf('SHR-275')).toBeLessThan(raw.indexOf('## What shipped'));
    expect(raw.indexOf('SHR-275')).toBeLessThan(raw.indexOf('## Summary'));
  });

  it('serializeSections(parseSections(raw)) round-trips a preamble + several sections', () => {
    // Normalisation allowed: trailing-newline count. serializeSections always
    // ends with exactly one trailing '\n'; the fixture below already matches
    // that shape so no normalisation is actually needed here.
    const raw =
      '# Title\n\nA lede paragraph.\n\n' +
      '## What shipped\n\nCommit abc123.\n\n' +
      '## Summary\n\n_Updated 2020-01-01 00:00:00_\n\nfirst pass\n';

    const roundTripped = serializeSections(parseSections(raw));
    expect(roundTripped).toBe(raw);
  });

  it('a file with no preamble serializes byte-identically to before the preamble fix', () => {
    const raw = '## Plan\n\nDo the thing.\n\n## Summary\n\n_Updated 2020-01-01 00:00:00_\n\nx\n';
    expect(serializeSections(parseSections(raw))).toBe(raw);
  });

  // ── Activity section (Defect A) ───────────────────────────────────────────

  it('getArtifactActivity returns null/null on a file with no Activity section', () => {
    expect(getArtifactActivity(null)).toEqual({
      current_activity: null,
      current_activity_updated_at: null,
    });
    expect(getArtifactActivity(tmpDir)).toEqual({
      current_activity: null,
      current_activity_updated_at: null,
    });
    setArtifactSummary(tmpDir, 'a summary, no activity yet');
    expect(getArtifactActivity(tmpDir)).toEqual({
      current_activity: null,
      current_activity_updated_at: null,
    });
  });

  it('setArtifactActivity writes and round-trips with a sqlite-shaped timestamp', () => {
    const { updatedAt } = setArtifactActivity(tmpDir, 'Bash: npm test');
    expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const read = getArtifactActivity(tmpDir);
    expect(read.current_activity).toBe('Bash: npm test');
    expect(read.current_activity_updated_at).toBe(updatedAt);

    const raw = fs.readFileSync(path.join(tmpDir, '.octomux', 'artifact.md'), 'utf8');
    expect(raw).toContain('## Activity');
    expect(raw).toContain('Bash: npm test');
  });

  it('setArtifactActivity does NOT change an existing Summary section, and vice versa', () => {
    setArtifactSummary(tmpDir, 'authored summary', '2020-01-01 00:00:00');
    setArtifactActivity(tmpDir, 'Bash: npm test', '2020-01-01 00:00:05');

    // Activity write left Summary untouched.
    expect(getArtifactSummary(tmpDir)).toEqual({
      current_summary: 'authored summary',
      current_summary_updated_at: '2020-01-01 00:00:00',
    });

    setArtifactSummary(tmpDir, 'authored summary v2', '2020-01-01 00:00:10');

    // Summary write left Activity untouched.
    expect(getArtifactActivity(tmpDir)).toEqual({
      current_activity: 'Bash: npm test',
      current_activity_updated_at: '2020-01-01 00:00:05',
    });
  });

  it('places a newly-created Activity section after an existing Summary, and splices a later Summary before an existing Activity', () => {
    // Case 1: Summary exists first (the common case — most tasks already
    // have an authored/back-filled Summary before any tool use fires).
    setArtifactSummary(tmpDir, 'authored', '2020-01-01 00:00:00');
    setArtifactActivity(tmpDir, 'Bash: npm test', '2020-01-01 00:00:05');
    let raw = fs.readFileSync(path.join(tmpDir, '.octomux', 'artifact.md'), 'utf8');
    expect(raw.indexOf('## Summary')).toBeLessThan(raw.indexOf('## Activity'));

    // Case 2: Activity created first on a brand-new task (no agent has
    // written a Summary yet) — a later Summary must still land BEFORE it.
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-artifact-unit-2-'));
    try {
      setArtifactActivity(tmpDir2, 'Bash: npm test', '2020-01-01 00:00:00');
      setArtifactSummary(tmpDir2, 'authored later', '2020-01-01 00:00:10');
      raw = fs.readFileSync(path.join(tmpDir2, '.octomux', 'artifact.md'), 'utf8');
      expect(raw.indexOf('## Summary')).toBeLessThan(raw.indexOf('## Activity'));
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  it('a summary body containing a line starting with `##` does not corrupt the file', () => {
    fs.mkdirSync(path.join(tmpDir, '.octomux'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.octomux', 'artifact.md'),
      '## Plan\n\nDo the thing.\n\n## Summary\n',
    );

    const tricky = 'line one\n## looks like a heading\nline three';
    setArtifactSummary(tmpDir, tricky);

    // Read back unescaped, exactly as written.
    expect(getArtifactSummary(tmpDir).current_summary).toBe(tricky);

    // The Plan section must survive untouched — a spurious split would have
    // moved "line three" (or worse) into a bogus new section.
    const raw = fs.readFileSync(path.join(tmpDir, '.octomux', 'artifact.md'), 'utf8');
    expect(raw).toContain('## Plan');
    expect(raw).toContain('Do the thing.');

    const sections = parseSections(raw);
    expect(sections.has('looks like a heading')).toBe(false);
  });
});
