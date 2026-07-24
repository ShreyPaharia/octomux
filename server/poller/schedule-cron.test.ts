import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { createSchedule, listEnabledSchedules } from '../repositories/schedules.js';

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
    const row = createSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
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
    createSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    const now = new Date('2026-07-18T08:00:00Z');

    await pollSchedules(now);

    expect(mockRun).not.toHaveBeenCalled();
    const [updated] = listEnabledSchedules();
    expect(updated.last_run_at).toBeNull();
  });

  it('does not throw when a run handler rejects, and still touches last_run_at', async () => {
    mockRun.mockRejectedValueOnce(new Error('boom'));
    createSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    const now = new Date('2026-07-18T07:00:00Z');

    await expect(pollSchedules(now)).resolves.toBeUndefined();

    const [updated] = listEnabledSchedules();
    expect(updated.last_run_at).not.toBeNull();
  });

  it('passes row.timezone to isCronDue (schedule with timezone fires at local hour)', async () => {
    // "0 7 * * *" in America/New_York (EDT = UTC-4) fires at 11:00 UTC
    createSchedule({
      kind: 'prod-log-triage',
      repoPath: '/repo',
      cron: '0 7 * * *',
      timezone: 'America/New_York',
    });
    const now = new Date('2026-07-18T11:00:00Z'); // 7am EDT

    await pollSchedules(now);

    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('does not fire when tz schedule is not due at UTC equivalent', async () => {
    createSchedule({
      kind: 'prod-log-triage',
      repoPath: '/repo',
      cron: '0 7 * * *',
      timezone: 'America/New_York',
    });
    const now = new Date('2026-07-18T07:00:00Z'); // 3am EDT, not 7am

    await pollSchedules(now);

    expect(mockRun).not.toHaveBeenCalled();
  });

  // ── Same-minute refire guard ─────────────────────────────────────────────────

  it('skips a schedule whose last_run_at is in the same UTC minute as now', async () => {
    const row = createSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    // Simulate the schedule already having fired this minute.
    // last_run_at uses SQLite datetime('now') format: 'YYYY-MM-DD HH:MM:SS'
    const { getDb } = await import('../db.js');
    getDb()
      .prepare(`UPDATE schedules SET last_run_at = ? WHERE id = ?`)
      .run('2026-07-18 07:00:30', row.id); // same minute as now (07:00Z)

    const now = new Date('2026-07-18T07:00:55Z'); // still same minute

    await pollSchedules(now);

    expect(mockRun).not.toHaveBeenCalled();
  });

  it('fires a schedule whose last_run_at is in a different UTC minute', async () => {
    const row = createSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '* * * * *' });
    // last_run_at is one minute earlier — should still fire
    const { getDb } = await import('../db.js');
    getDb()
      .prepare(`UPDATE schedules SET last_run_at = ? WHERE id = ?`)
      .run('2026-07-18 06:59:30', row.id);

    const now = new Date('2026-07-18T07:00:00Z');

    await pollSchedules(now);

    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('fires a schedule with null last_run_at (never run before)', async () => {
    createSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    const now = new Date('2026-07-18T07:00:00Z');

    await pollSchedules(now);

    expect(mockRun).toHaveBeenCalledTimes(1);
  });
});
