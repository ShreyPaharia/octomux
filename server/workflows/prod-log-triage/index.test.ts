import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkflow } from '../registry.js';
import { resolveWorkflowConfig } from '../config.js';
import type { ScheduleRow } from '../../repositories/schedules.js';

const mockCreateTriageTaskFromSchedule = vi.fn().mockResolvedValue({ id: 'task1' });

vi.mock('./run.js', () => ({
  createTriageTaskFromSchedule: (...args: unknown[]) => mockCreateTriageTaskFromSchedule(...args),
}));

import './index.js';

function makeRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched1',
    kind: 'prod-log-triage',
    repo_path: '/repo',
    cron: '0 7 * * *',
    enabled: 1,
    last_run_at: null,
    config_json: null,
    ...overrides,
  };
}

describe('prod-log-triage workflow registration', () => {
  beforeEach(() => {
    mockCreateTriageTaskFromSchedule.mockClear();
  });

  it('registers the prod-log-triage kind with feed+artifact surfaces and config schema', () => {
    const wf = getWorkflow('prod-log-triage');
    expect(wf).toBeDefined();
    expect(wf?.displayName).toBe('Prod Log Triage');
    expect(wf?.surfaces).toEqual(['feed', 'artifact']);
    expect(wf?.output).toBeUndefined();
    expect(wf?.trigger).toEqual({ kind: 'cron' });
    expect(wf?.config).toBeDefined();
    expect(wf?.run).toBeTypeOf('function');
  });

  it('default verify is scoped to the task branch (--head), not repo-wide (--search)', async () => {
    const wf = getWorkflow('prod-log-triage')!;
    const row = makeRow();
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(wf, row.config_json),
      scheduleId: row.id,
    });

    expect(mockCreateTriageTaskFromSchedule).toHaveBeenCalledTimes(1);
    const call = mockCreateTriageTaskFromSchedule.mock.calls[0][0];
    expect(call.verify).toContain('--head');
    expect(call.verify).not.toContain('--search');
  });

  it('passes the schedule id through as scheduleId', async () => {
    const wf = getWorkflow('prod-log-triage')!;
    const row = makeRow({ id: 'sched-42' });
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(wf, row.config_json),
      scheduleId: row.id,
    });

    const call = mockCreateTriageTaskFromSchedule.mock.calls[0][0];
    expect(call.scheduleId).toBe('sched-42');
  });

  it('applies schema defaults when the row has no config_json', async () => {
    const wf = getWorkflow('prod-log-triage')!;
    const row = makeRow({ config_json: null });
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(wf, row.config_json),
      scheduleId: row.id,
    });

    const call = mockCreateTriageTaskFromSchedule.mock.calls[0][0];
    expect(call.logCommand).toBe('gh run list --limit 20 --json databaseId,conclusion,name,url');
    expect(call.maxIterations).toBe(5);
  });

  it('passes through config_json overrides for logCommand/verify/maxIterations', async () => {
    const wf = getWorkflow('prod-log-triage')!;
    const config = {
      logCommand: 'flyctl logs -a my-app',
      verify: 'bun run test',
      maxIterations: 3,
    };
    const row = makeRow({ config_json: JSON.stringify(config) });
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(wf, row.config_json),
      scheduleId: row.id,
    });

    const call = mockCreateTriageTaskFromSchedule.mock.calls[0][0];
    expect(call.logCommand).toBe('flyctl logs -a my-app');
    expect(call.verify).toBe('bun run test');
    expect(call.maxIterations).toBe(3);
  });
});
