import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers.js';
import { getDb } from './db.js';
import { buildPrExtractPrompt, insertExtractTask } from './pr-extract-tasks.js';

describe('buildPrExtractPrompt', () => {
  it('pins the extract task id and the octomux CLI command shape', () => {
    const prompt = buildPrExtractPrompt({
      extractTaskId: 'extract-1',
      title: 'Add feature X',
      number: 42,
      url: 'https://github.com/org/repo/pull/42',
      headRefOid: 'sha-abc',
      repoShort: 'octomux-agents',
    });
    expect(prompt).toContain('extract-1');
    expect(prompt).toContain('octomux pr-extract emit');
    expect(prompt).toContain('#42');
  });
});

describe('insertExtractTask', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('inserts a task with source=pr_extract and the given PR fields', () => {
    const id = insertExtractTask({
      id: 'extract-1',
      repoPath: '/repo',
      branch: 'extract/repo-pr-42',
      baseBranch: 'main',
      title: 'Extract: Add feature X (#42)',
      description: 'Extract task for merged PR #42',
      initialPrompt: 'do the thing',
      prUrl: 'https://github.com/org/repo/pull/42',
      prNumber: 42,
      prHeadSha: 'sha-abc',
    });
    expect(id).toBe('extract-1');
    const row = getDb()
      .prepare('SELECT source, pr_number, pr_head_sha FROM tasks WHERE id = ?')
      .get(id);
    expect(row).toEqual({ source: 'pr_extract', pr_number: 42, pr_head_sha: 'sha-abc' });
  });
});
