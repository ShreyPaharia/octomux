import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkflow, listWorkflows } from '../registry.js';
import { SCHEDULE_HANDLERS, listScheduleKinds } from '../../schedules/handlers.js';
import type { ScheduleRow } from '../../repositories/schedules.js';

const mockRunWeeklyUpdate = vi.fn().mockResolvedValue({ result: {} });

vi.mock('../../services/weekly-update-service.js', () => ({
  runWeeklyUpdate: (...args: unknown[]) => mockRunWeeklyUpdate(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import './register.js';

function makeRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched1',
    kind: 'weekly-update',
    repo_path: '/repo',
    cron: '0 9 * * 1',
    enabled: 1,
    last_run_at: null,
    config_json: null,
    ...overrides,
  };
}

describe('weekly-update workflow registration', () => {
  beforeEach(() => {
    mockRunWeeklyUpdate.mockClear();
  });

  it('registers the weekly-update kind with an artifact surface, output schema, cron trigger', () => {
    const wf = getWorkflow('weekly-update');
    expect(wf).toBeDefined();
    expect(wf?.displayName).toBe('Weekly Update');
    expect(wf?.surfaces).toEqual(['artifact']);
    expect(wf?.output).toBeDefined();
    expect(wf?.trigger).toEqual({ kind: 'cron' });
  });

  it('appears in listWorkflows()', () => {
    expect(listWorkflows().some((w) => w.kind === 'weekly-update')).toBe(true);
  });

  it('registers a schedule handler for weekly-update', () => {
    expect(typeof SCHEDULE_HANDLERS['weekly-update']).toBe('function');
    expect(listScheduleKinds()).toContain('weekly-update');
  });

  it('fires the run with the schedule id and repo path, without awaiting it', async () => {
    // Never resolves — if the handler awaited this internally, the test would
    // hang and fail on timeout instead of resolving cleanly.
    mockRunWeeklyUpdate.mockReturnValue(new Promise(() => {}));

    await SCHEDULE_HANDLERS['weekly-update'](makeRow({ id: 'sched-42' }));

    expect(mockRunWeeklyUpdate).toHaveBeenCalledTimes(1);
    const call = mockRunWeeklyUpdate.mock.calls[0][0];
    expect(call.repoPath).toBe('/repo');
    expect(call.scheduleId).toBe('sched-42');
  });
});
