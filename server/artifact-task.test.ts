/**
 * server/artifact-task.test.ts
 *
 * Unit coverage for the taskId-resolving `ctx.artifacts` wrappers:
 * writeTaskArtifact / listTaskArtifacts / readTaskArtifact.
 */
import { describe, it, expect, beforeEach, afterEach } from './bun-test.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createTestDb, insertTask } from './test-helpers.js';
import { writeTaskArtifact, listTaskArtifacts, readTaskArtifact } from './artifact-task.js';

describe('artifact-task artifacts wrappers', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-artifact-task-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writeTaskArtifact throws for a task with no worktree', () => {
    const db = createTestDb();
    insertTask(db, { id: 'task-no-wt', worktree: null });

    expect(() =>
      writeTaskArtifact('task-no-wt', 'p1', { name: 'a.txt', mime: 'text/plain', body: 'x' }),
    ).toThrow(/no worktree/);
  });

  it('writeTaskArtifact throws for an unknown task id', () => {
    createTestDb();
    expect(() =>
      writeTaskArtifact('does-not-exist', 'p1', { name: 'a.txt', mime: 'text/plain', body: 'x' }),
    ).toThrow(/no worktree/);
  });

  it('writeTaskArtifact writes into the resolved worktree for a task that has one', () => {
    const db = createTestDb();
    insertTask(db, { id: 'task-with-wt', worktree: tmpDir, repo_path: '/tmp/repo' });

    const record = writeTaskArtifact('task-with-wt', 'p1', {
      name: 'report.md',
      mime: 'text/markdown',
      body: '# hi',
    });
    expect(record).toMatchObject({ pluginId: 'p1', name: 'report.md', mime: 'text/markdown' });

    const onDisk = fs.readFileSync(
      path.join(tmpDir, '.octomux', 'artifacts', 'p1', 'report.md'),
      'utf8',
    );
    expect(onDisk).toBe('# hi');
  });

  it('listTaskArtifacts and readTaskArtifact round trip through the resolved worktree', () => {
    const db = createTestDb();
    insertTask(db, { id: 'task-rt', worktree: tmpDir, repo_path: '/tmp/repo' });
    writeTaskArtifact('task-rt', 'p1', { name: 'a.txt', mime: 'text/plain', body: 'aaa' });

    expect(listTaskArtifacts('task-rt')).toHaveLength(1);
    expect(readTaskArtifact('task-rt', 'p1', 'a.txt')?.body).toBe('aaa');
  });

  it('listTaskArtifacts returns [] and readTaskArtifact returns null for a task with no worktree', () => {
    const db = createTestDb();
    insertTask(db, { id: 'task-no-wt-2', worktree: null });

    expect(listTaskArtifacts('task-no-wt-2')).toEqual([]);
    expect(readTaskArtifact('task-no-wt-2', 'p1', 'a.txt')).toBeNull();
  });

  it('listTaskArtifacts returns [] and readTaskArtifact returns null for an unknown task id', () => {
    createTestDb();
    expect(listTaskArtifacts('does-not-exist')).toEqual([]);
    expect(readTaskArtifact('does-not-exist', 'p1', 'a.txt')).toBeNull();
  });
});
