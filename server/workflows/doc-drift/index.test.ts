import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkflow } from '../registry.js';
import { resolveWorkflowConfig } from '../config.js';
import type { ScheduleRow } from '../../repositories/schedules.js';

const mockCreateDocDriftTaskFromSchedule = vi.fn().mockResolvedValue({ id: 'task1' });

vi.mock('./run.js', () => ({
  createDocDriftTaskFromSchedule: (...args: unknown[]) =>
    mockCreateDocDriftTaskFromSchedule(...args),
}));

import './index.js';

function makeRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched1',
    kind: 'doc-drift',
    repo_path: '/repo',
    cron: '0 7 * * *',
    enabled: 1,
    last_run_at: null,
    config_json: null,
    prompt: null,
    ...overrides,
  };
}

describe('doc-drift workflow registration', () => {
  beforeEach(() => {
    mockCreateDocDriftTaskFromSchedule.mockClear();
  });

  it('registers the doc-drift kind with feed+artifact surfaces and config schema', () => {
    const wf = getWorkflow('doc-drift');
    expect(wf).toBeDefined();
    expect(wf?.displayName).toBe('Doc Drift');
    expect(wf?.surfaces).toEqual(['feed', 'artifact']);
    expect(wf?.output).toBeUndefined();
    expect(wf?.trigger).toEqual({ kind: 'cron' });
    expect(wf?.config).toBeDefined();
    expect(wf?.run).toBeTypeOf('function');
  });

  it('default verify is scoped to the task branch (--head), not repo-wide', async () => {
    const wf = getWorkflow('doc-drift')!;
    const row = makeRow();
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(wf, row.config_json),
      scheduleId: row.id,
    });

    expect(mockCreateDocDriftTaskFromSchedule).toHaveBeenCalledTimes(1);
    const call = mockCreateDocDriftTaskFromSchedule.mock.calls[0][0];
    expect(call.verify).toContain('--head');
    expect(call.verify).not.toContain('--search');
  });

  it('passes the schedule id through as scheduleId', async () => {
    const wf = getWorkflow('doc-drift')!;
    const row = makeRow({ id: 'sched-42' });
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(wf, row.config_json),
      scheduleId: row.id,
    });

    const call = mockCreateDocDriftTaskFromSchedule.mock.calls[0][0];
    expect(call.scheduleId).toBe('sched-42');
  });

  it('applies schema defaults when the row has no config_json', async () => {
    const wf = getWorkflow('doc-drift')!;
    const row = makeRow({ config_json: null });
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(wf, row.config_json),
      scheduleId: row.id,
    });

    const call = mockCreateDocDriftTaskFromSchedule.mock.calls[0][0];
    expect(call.maxIterations).toBe(4);
    expect(call.verify).toContain('origin/HEAD');
  });

  it('passes through config_json overrides for verify/maxIterations', async () => {
    const wf = getWorkflow('doc-drift')!;
    const config = {
      verify: 'bun run test',
      maxIterations: 2,
    };
    const row = makeRow({ config_json: JSON.stringify(config) });
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(wf, row.config_json),
      scheduleId: row.id,
    });

    const call = mockCreateDocDriftTaskFromSchedule.mock.calls[0][0];
    expect(call.verify).toBe('bun run test');
    expect(call.maxIterations).toBe(2);
  });
});
