import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkflow } from '../registry.js';
import { SCHEDULE_HANDLERS } from '../../schedules/handlers.js';
import type { ScheduleRow } from '../../repositories/schedules.js';

const mockCreateDocDriftTaskFromSchedule = vi.fn().mockResolvedValue({ id: 'task1' });

vi.mock('../../services/doc-drift-service.js', () => ({
  createDocDriftTaskFromSchedule: (...args: unknown[]) =>
    mockCreateDocDriftTaskFromSchedule(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import './register.js';

function makeRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched1',
    kind: 'doc-drift',
    repo_path: '/repo',
    cron: '0 7 * * *',
    enabled: 1,
    last_run_at: null,
    config_json: null,
    ...overrides,
  };
}

describe('doc-drift workflow registration', () => {
  beforeEach(() => {
    mockCreateDocDriftTaskFromSchedule.mockClear();
  });

  it('registers the doc-drift kind with feed+artifact surfaces and no output/sink', () => {
    const wf = getWorkflow('doc-drift');
    expect(wf).toBeDefined();
    expect(wf?.displayName).toBe('Doc Drift');
    expect(wf?.surfaces).toEqual(['feed', 'artifact']);
    expect(wf?.output).toBeUndefined();
    expect(wf?.trigger).toEqual({ kind: 'cron' });
  });

  it('registers a schedule handler for doc-drift', () => {
    expect(typeof SCHEDULE_HANDLERS['doc-drift']).toBe('function');
  });

  it('default verify is scoped to the task branch (--head), not repo-wide', async () => {
    await SCHEDULE_HANDLERS['doc-drift'](makeRow());

    expect(mockCreateDocDriftTaskFromSchedule).toHaveBeenCalledTimes(1);
    const call = mockCreateDocDriftTaskFromSchedule.mock.calls[0][0];
    expect(call.verify).toContain('--head');
    expect(call.verify).not.toContain('--search');
  });

  it('passes the schedule id through as scheduleId', async () => {
    await SCHEDULE_HANDLERS['doc-drift'](makeRow({ id: 'sched-42' }));

    const call = mockCreateDocDriftTaskFromSchedule.mock.calls[0][0];
    expect(call.scheduleId).toBe('sched-42');
  });

  it('falls back to defaults when the row has no config_json', async () => {
    await SCHEDULE_HANDLERS['doc-drift'](makeRow({ config_json: null }));

    const call = mockCreateDocDriftTaskFromSchedule.mock.calls[0][0];
    expect(call.maxIterations).toBe(4);
    expect(call.verify).toContain('origin/HEAD');
  });

  it('passes through config_json overrides for verify/maxIterations', async () => {
    const config = {
      verify: 'bun run test',
      maxIterations: 2,
    };
    await SCHEDULE_HANDLERS['doc-drift'](makeRow({ config_json: JSON.stringify(config) }));

    const call = mockCreateDocDriftTaskFromSchedule.mock.calls[0][0];
    expect(call.verify).toBe('bun run test');
    expect(call.maxIterations).toBe(2);
  });
});
