import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkflow } from '../registry.js';
import { SCHEDULE_HANDLERS } from '../../schedules/handlers.js';
import type { ScheduleRow } from '../../repositories/schedules.js';

const mockCreateTriageTaskFromSchedule = vi.fn().mockResolvedValue({ id: 'task1' });

vi.mock('../../services/prod-log-triage-service.js', () => ({
  createTriageTaskFromSchedule: (...args: unknown[]) => mockCreateTriageTaskFromSchedule(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import './register.js';

function makeRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched1',
    kind: 'prod-log-triage',
    repo_path: '/repo',
    cron: '0 7 * * *',
    enabled: 1,
    last_run_at: null,
    ...overrides,
  };
}

describe('prod-log-triage workflow registration', () => {
  beforeEach(() => {
    mockCreateTriageTaskFromSchedule.mockClear();
  });

  it('registers the prod-log-triage kind with feed+artifact surfaces and no output/sink', () => {
    const wf = getWorkflow('prod-log-triage');
    expect(wf).toBeDefined();
    expect(wf?.displayName).toBe('Prod Log Triage');
    expect(wf?.surfaces).toEqual(['feed', 'artifact']);
    expect(wf?.output).toBeUndefined();
  });

  it('registers a schedule handler for prod-log-triage', () => {
    expect(typeof SCHEDULE_HANDLERS['prod-log-triage']).toBe('function');
  });

  it('default verify is scoped to the task branch (--head), not repo-wide (--search)', async () => {
    await SCHEDULE_HANDLERS['prod-log-triage'](makeRow());

    expect(mockCreateTriageTaskFromSchedule).toHaveBeenCalledTimes(1);
    const call = mockCreateTriageTaskFromSchedule.mock.calls[0][0];
    expect(call.verify).toContain('--head');
    expect(call.verify).not.toContain('--search');
  });
});
