import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, insertTask } from '../test-helpers.js';
import { getDb } from '../db.js';
import {
  insertRun,
  finishRun,
  getRun,
  listRunsForWorkflow,
  listRunsForSchedule,
  countRunsForWorkflow,
} from './runs.js';

describe('runs repo', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('insertRun / getRun round-trip', () => {
    const row = insertRun({ workflowKind: 'pr-extract', trigger: 'github' });

    expect(row.workflow_kind).toBe('pr-extract');
    expect(row.trigger).toBe('github');
    expect(row.status).toBe('running');
    expect(row.result_json).toBeNull();
    expect(row.ended_at).toBeNull();

    const fetched = getRun(row.id);
    expect(fetched).toEqual(row);
  });

  it('finishRun sets status, result_json, and ended_at', () => {
    const row = insertRun({ workflowKind: 'pr-extract', trigger: 'github' });

    finishRun(row.id, { status: 'done', result: { ok: true } });

    const fetched = getRun(row.id);
    expect(fetched?.status).toBe('done');
    expect(fetched?.result_json).toBe(JSON.stringify({ ok: true }));
    expect(fetched?.error).toBeNull();
    expect(fetched?.ended_at).not.toBeNull();
  });

  it('finishRun sets error on failure', () => {
    const row = insertRun({ workflowKind: 'reviewer', trigger: 'github' });

    finishRun(row.id, { status: 'failed', error: 'boom' });

    const fetched = getRun(row.id);
    expect(fetched?.status).toBe('failed');
    expect(fetched?.error).toBe('boom');
    expect(fetched?.result_json).toBeNull();
  });

  it('listRunsForWorkflow returns effective_status from a linked task runtime_state', () => {
    const db = getDb();
    const task = insertTask(db, { id: 'task-1', runtime_state: 'running' } as any);

    const linked = insertRun({ workflowKind: 'prod-log-triage', trigger: 'cron', taskId: task.id });
    // A session run with no linked task: effective_status falls back to runs.status.
    insertRun({ workflowKind: 'prod-log-triage', trigger: 'cron' });

    const rows = listRunsForWorkflow('prod-log-triage');
    expect(rows).toHaveLength(2);

    const linkedRow = rows.find((r) => r.id === linked.id);
    expect(linkedRow?.effective_status).toBe('running');

    const unlinkedRow = rows.find((r) => r.id !== linked.id);
    expect(unlinkedRow?.effective_status).toBe('running'); // runs.status default
  });

  it('listRunsForWorkflow effective_status tracks task runtime_state after task updates', () => {
    const db = getDb();
    const task = insertTask(db, { id: 'task-2', runtime_state: 'running' } as any);
    const run = insertRun({ workflowKind: 'reviewer', trigger: 'github', taskId: task.id });

    db.prepare(`UPDATE tasks SET runtime_state = 'error' WHERE id = ?`).run(task.id);

    const rows = listRunsForWorkflow('reviewer');
    expect(rows.find((r) => r.id === run.id)?.effective_status).toBe('error');
  });

  it('listRunsForSchedule filters by schedule_id', () => {
    const first = insertRun({
      workflowKind: 'prod-log-triage',
      trigger: 'cron',
      scheduleId: 'sched-1',
    });
    const second = insertRun({
      workflowKind: 'prod-log-triage',
      trigger: 'cron',
      scheduleId: 'sched-1',
    });
    insertRun({ workflowKind: 'prod-log-triage', trigger: 'cron', scheduleId: 'sched-2' });

    const rows = listRunsForSchedule('sched-1');
    expect(rows.map((r) => r.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('countRunsForWorkflow counts only runs for the given kind', () => {
    insertRun({ workflowKind: 'pr-extract', trigger: 'github' });
    insertRun({ workflowKind: 'pr-extract', trigger: 'github' });
    insertRun({ workflowKind: 'reviewer', trigger: 'github' });

    expect(countRunsForWorkflow('pr-extract')).toBe(2);
    expect(countRunsForWorkflow('reviewer')).toBe(1);
    expect(countRunsForWorkflow('loops')).toBe(0);
  });
});
