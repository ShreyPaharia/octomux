import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkflow, listWorkflows } from '../registry.js';
import { SCHEDULE_HANDLERS, listScheduleKinds } from '../../schedules/handlers.js';
import type { ScheduleRow } from '../../repositories/schedules.js';

const mockRunOvernightLogSummary = vi.fn().mockResolvedValue({ result: {} });

vi.mock('../../services/overnight-log-summary-service.js', () => ({
  runOvernightLogSummary: (...args: unknown[]) => mockRunOvernightLogSummary(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import './register.js';

function makeRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched1',
    kind: 'overnight-log-summary',
    repo_path: '/repo',
    cron: '0 6 * * *',
    enabled: 1,
    last_run_at: null,
    config_json: null,
    ...overrides,
  };
}

describe('overnight-log-summary workflow registration', () => {
  beforeEach(() => {
    mockRunOvernightLogSummary.mockClear();
  });

  it('registers the overnight-log-summary kind with an artifact surface, output schema, cron trigger', () => {
    const wf = getWorkflow('overnight-log-summary');
    expect(wf).toBeDefined();
    expect(wf?.displayName).toBe('Overnight Log Summary');
    expect(wf?.surfaces).toEqual(['artifact']);
    expect(wf?.output).toBeDefined();
    expect(wf?.trigger).toEqual({ kind: 'cron' });
  });

  it('appears in listWorkflows()', () => {
    expect(listWorkflows().some((w) => w.kind === 'overnight-log-summary')).toBe(true);
  });

  it('registers a schedule handler for overnight-log-summary', () => {
    expect(typeof SCHEDULE_HANDLERS['overnight-log-summary']).toBe('function');
    expect(listScheduleKinds()).toContain('overnight-log-summary');
  });

  it('fires the run with the schedule id and default log command, without awaiting it', async () => {
    // Never resolves — if the handler awaited this internally, the test would
    // hang and fail on timeout instead of resolving cleanly.
    mockRunOvernightLogSummary.mockReturnValue(new Promise(() => {}));

    await SCHEDULE_HANDLERS['overnight-log-summary'](makeRow({ id: 'sched-42' }));

    expect(mockRunOvernightLogSummary).toHaveBeenCalledTimes(1);
    const call = mockRunOvernightLogSummary.mock.calls[0][0];
    expect(call.repoPath).toBe('/repo');
    expect(call.scheduleId).toBe('sched-42');
    expect(call.logCommand).toBe('gh run list --limit 30 --json databaseId,conclusion,name,url');
  });

  it('passes through config_json overrides for logCommand', async () => {
    await SCHEDULE_HANDLERS['overnight-log-summary'](
      makeRow({ config_json: JSON.stringify({ logCommand: 'flyctl logs -a my-app' }) }),
    );

    const call = mockRunOvernightLogSummary.mock.calls[0][0];
    expect(call.logCommand).toBe('flyctl logs -a my-app');
  });
});
