import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { upsertSchedule, listEnabledSchedules } from '../repositories/schedules.js';

const mockHandler = vi.fn().mockResolvedValue(undefined);

vi.mock('../schedules/handlers.js', () => ({
  SCHEDULE_HANDLERS: { 'prod-log-triage': (...args: unknown[]) => mockHandler(...args) },
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { pollSchedules } from './schedule-cron.js';

describe('pollSchedules', () => {
  beforeEach(() => {
    createTestDb();
    mockHandler.mockClear();
  });

  it('calls the matching handler and touches last_run_at when a schedule is due now', async () => {
    const row = upsertSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    const now = new Date('2026-07-18T07:00:00Z');

    await pollSchedules(now);

    expect(mockHandler).toHaveBeenCalledTimes(1);
    expect(mockHandler).toHaveBeenCalledWith(expect.objectContaining({ id: row.id }));

    const [updated] = listEnabledSchedules();
    expect(updated.last_run_at).not.toBeNull();
  });

  it('does not call the handler when the schedule is not due', async () => {
    upsertSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    const now = new Date('2026-07-18T08:00:00Z');

    await pollSchedules(now);

    expect(mockHandler).not.toHaveBeenCalled();
    const [updated] = listEnabledSchedules();
    expect(updated.last_run_at).toBeNull();
  });

  it('does not throw when a handler rejects, and still touches last_run_at', async () => {
    mockHandler.mockRejectedValueOnce(new Error('boom'));
    upsertSchedule({ kind: 'prod-log-triage', repoPath: '/repo', cron: '0 7 * * *' });
    const now = new Date('2026-07-18T07:00:00Z');

    await expect(pollSchedules(now)).resolves.toBeUndefined();

    const [updated] = listEnabledSchedules();
    expect(updated.last_run_at).not.toBeNull();
  });
});
