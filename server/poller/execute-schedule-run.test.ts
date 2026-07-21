import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { upsertSchedule } from '../repositories/schedules.js';
import { insertRun, listRunsForSchedule } from '../repositories/runs.js';

const mockRun = vi.fn().mockResolvedValue(undefined);

vi.mock('../workflows/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workflows/registry.js')>();
  return {
    ...actual,
    getWorkflow: (kind: string) =>
      kind === 'weekly-update'
        ? { kind, run: (...args: unknown[]) => mockRun(...args) }
        : actual.getWorkflow(kind),
  };
});

import { executeScheduleRun } from './execute-schedule-run.js';

describe('executeScheduleRun', () => {
  beforeEach(() => {
    createTestDb();
    mockRun.mockClear();
  });

  it('calls wf.run with the same context shape as the cron poller', async () => {
    const row = upsertSchedule({
      kind: 'weekly-update',
      repoPath: '/repo',
      cron: '0 7 * * *',
    });

    await executeScheduleRun(row.id, { trigger: 'manual' });

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/repo',
        scheduleId: row.id,
        trigger: 'manual',
      }),
    );
  });

  it('creates a runs row when the workflow handler inserts one', async () => {
    const row = upsertSchedule({
      kind: 'weekly-update',
      repoPath: '/repo',
      cron: '0 7 * * *',
    });

    mockRun.mockImplementationOnce(async (ctx: { scheduleId?: string }) => {
      insertRun({
        workflowKind: 'weekly-update',
        trigger: 'manual',
        scheduleId: ctx.scheduleId,
      });
    });

    await executeScheduleRun(row.id, { trigger: 'manual' });

    const runs = listRunsForSchedule(row.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].workflow_kind).toBe('weekly-update');
    expect(runs[0].trigger).toBe('manual');
  });
});
