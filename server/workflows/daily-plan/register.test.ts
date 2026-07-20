import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkflow, listWorkflows } from '../registry.js';
import { SCHEDULE_HANDLERS, listScheduleKinds } from '../../schedules/handlers.js';
import type { ScheduleRow } from '../../repositories/schedules.js';

const mockRunDailyPlanFromSchedule = vi.fn().mockResolvedValue(undefined);

vi.mock('../../services/daily-plan-service.js', () => ({
  runDailyPlanFromSchedule: (...args: unknown[]) => mockRunDailyPlanFromSchedule(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import './register.js';

function makeRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched1',
    kind: 'daily-plan',
    repo_path: '/repo',
    cron: '0 7 * * 1-5',
    enabled: 1,
    last_run_at: null,
    config_json: null,
    ...overrides,
  };
}

describe('daily-plan workflow registration', () => {
  beforeEach(() => {
    mockRunDailyPlanFromSchedule.mockClear();
  });

  it('registers the daily-plan kind with a session surface, no output schema, cron trigger', () => {
    const wf = getWorkflow('daily-plan');
    expect(wf).toBeDefined();
    expect(wf?.displayName).toBe('Daily Plan');
    expect(wf?.surfaces).toEqual(['session']);
    expect(wf?.output).toBeUndefined();
    expect(wf?.trigger).toEqual({ kind: 'cron' });
  });

  it('appears in listWorkflows()', () => {
    expect(listWorkflows().some((w) => w.kind === 'daily-plan')).toBe(true);
  });

  it('registers a schedule handler for daily-plan', () => {
    expect(typeof SCHEDULE_HANDLERS['daily-plan']).toBe('function');
    expect(listScheduleKinds()).toContain('daily-plan');
  });

  it('fires the run with the schedule id', async () => {
    await SCHEDULE_HANDLERS['daily-plan'](makeRow({ id: 'sched-42' }));

    expect(mockRunDailyPlanFromSchedule).toHaveBeenCalledTimes(1);
    expect(mockRunDailyPlanFromSchedule).toHaveBeenCalledWith({ scheduleId: 'sched-42' });
  });
});
