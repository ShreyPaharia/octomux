import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkflow, listWorkflows, listCronWorkflowKinds } from '../registry.js';
import { resolveWorkflowConfig } from '../config.js';
import type { ScheduleRow } from '../../repositories/schedules.js';

const mockRunOvernightLogSummary = vi.fn().mockResolvedValue({ result: {} });

vi.mock('./run.js', () => ({
  runOvernightLogSummary: (...args: unknown[]) => mockRunOvernightLogSummary(...args),
}));

import './index.js';

function makeRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched1',
    kind: 'overnight-log-summary',
    repo_path: '/repo',
    cron: '0 6 * * *',
    enabled: 1,
    last_run_at: null,
    config_json: null,
    prompt: null,
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
    expect(wf?.config).toBeDefined();
    expect(wf?.trigger).toEqual({ kind: 'cron' });
  });

  it('appears in listWorkflows() and listCronWorkflowKinds()', () => {
    expect(listWorkflows().some((w) => w.kind === 'overnight-log-summary')).toBe(true);
    expect(listCronWorkflowKinds()).toContain('overnight-log-summary');
  });

  it('fires the run with the schedule id and default log command, without awaiting it', async () => {
    mockRunOvernightLogSummary.mockReturnValue(new Promise(() => {}));

    const wf = getWorkflow('overnight-log-summary')!;
    const row = makeRow({ id: 'sched-42' });
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(wf, row.config_json),
      scheduleId: row.id,
    });

    expect(mockRunOvernightLogSummary).toHaveBeenCalledTimes(1);
    const call = mockRunOvernightLogSummary.mock.calls[0][0];
    expect(call.repoPath).toBe('/repo');
    expect(call.scheduleId).toBe('sched-42');
    expect(call.logCommand).toBe('gh run list --limit 30 --json databaseId,conclusion,name,url');
  });

  it('passes through config_json overrides for logCommand', async () => {
    const wf = getWorkflow('overnight-log-summary')!;
    const row = makeRow({ config_json: JSON.stringify({ logCommand: 'flyctl logs -a my-app' }) });
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(wf, row.config_json),
      scheduleId: row.id,
    });

    const call = mockRunOvernightLogSummary.mock.calls[0][0];
    expect(call.logCommand).toBe('flyctl logs -a my-app');
  });
});
