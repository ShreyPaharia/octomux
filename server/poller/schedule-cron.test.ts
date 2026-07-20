import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { upsertSchedule, listEnabledSchedules } from '../repositories/schedules.js';

const mockRun = vi.fn().mockResolvedValue(undefined);

vi.mock('../workflows/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workflows/registry.js')>();
  return {
    ...actual,
    getWorkflow: (kind: string) =>
      kind === 'prod-log-triage'
        ? { kind, run: (...args: unknown[]) => mockRun(...args) }
        : actual.getWorkflow(kind),
  };
});

import { pollSchedules } from './schedule-cron.js';

describe('pollSchedules', () => {
  beforeEach(() => {
    createTestDb();
    mockRun.mockClear();
  });

  it('calls the matching run handler and touches last_run_at when a schedule is due now', async () => {
    const row = upsertSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    const now = new Date('2026-07-18T07:00:00Z');

    await pollSchedules(now);

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/repo', scheduleId: row.id }),
    );

    const [updated] = listEnabledSchedules();
    expect(updated.last_run_at).not.toBeNull();
  });

  it('does not call the run handler when the schedule is not due', async () => {
    upsertSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    const now = new Date('2026-07-18T08:00:00Z');

    await pollSchedules(now);

    expect(mockRun).not.toHaveBeenCalled();
    const [updated] = listEnabledSchedules();
    expect(updated.last_run_at).toBeNull();
  });

  it('does not throw when a run handler rejects, and still touches last_run_at', async () => {
    mockRun.mockRejectedValueOnce(new Error('boom'));
    upsertSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    const now = new Date('2026-07-18T07:00:00Z');

    await expect(pollSchedules(now)).resolves.toBeUndefined();

    const [updated] = listEnabledSchedules();
    expect(updated.last_run_at).not.toBeNull();
  });
});
