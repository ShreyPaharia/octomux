/**
 * server/services/run-detail.test.ts
 *
 * Covers the `artifacts` field added to `RunDetail` for SHR-269 — a run whose
 * task wrote `ctx.artifacts` files must surface them; a taskless run gets `[]`.
 * The rest of `getRunDetail`'s loop/loopGroup behavior is exercised via the
 * `runs`/`loops` route test suites, not duplicated here.
 */
import { describe, it, expect, beforeEach } from '../bun-test.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createTestDb, insertTask } from '../test-helpers.js';
import { getDb } from '../db.js';
import { insertRun } from '../repositories/runs.js';
import { writeTaskArtifact } from '../artifact-task.js';
import { getRunDetail } from './run-detail.js';

describe('getRunDetail artifacts', () => {
  let tmpDir: string;

  beforeEach(() => {
    createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-run-detail-artifacts-'));
  });

  it('includes a task’s ctx.artifacts files, mapped with their url', () => {
    const db = getDb();
    insertTask(db, { id: 'rd-task-1', title: 'T', description: 'd', worktree: tmpDir });
    writeTaskArtifact('rd-task-1', 'my-plugin', {
      name: 'report.md',
      mime: 'text/markdown',
      body: '# report',
    });

    const run = insertRun({ workflowKind: 'loop', trigger: 'manual', taskId: 'rd-task-1' });
    const detail = getRunDetail(run.id);

    expect(detail).toBeDefined();
    expect(detail!.artifacts).toHaveLength(1);
    expect(detail!.artifacts[0]).toMatchObject({
      pluginId: 'my-plugin',
      name: 'report.md',
      mime: 'text/markdown',
      url: '/api/tasks/rd-task-1/artifacts/my-plugin/report.md',
    });
  });

  it('returns an empty array for a run with no task_id', () => {
    const run = insertRun({ workflowKind: 'chat', trigger: 'manual', taskId: null });
    const detail = getRunDetail(run.id);

    expect(detail).toBeDefined();
    expect(detail!.artifacts).toEqual([]);
  });

  it('returns an empty array for a run whose task has no worktree', () => {
    const db = getDb();
    insertTask(db, { id: 'rd-task-2', title: 'T', description: 'd', worktree: null });
    const run = insertRun({ workflowKind: 'loop', trigger: 'manual', taskId: 'rd-task-2' });
    const detail = getRunDetail(run.id);

    expect(detail).toBeDefined();
    expect(detail!.artifacts).toEqual([]);
  });
});
