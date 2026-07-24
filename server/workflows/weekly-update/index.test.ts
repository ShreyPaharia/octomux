import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkflow, listWorkflows, listCronWorkflowKinds } from '../registry.js';
import type { ScheduleRow } from '../../repositories/schedules.js';

const mockRunWeeklyUpdate = vi.fn().mockResolvedValue({ result: {} });

vi.mock('./run.js', () => ({
  runWeeklyUpdate: (...args: unknown[]) => mockRunWeeklyUpdate(...args),
}));

import './index.js';

function makeRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched1',
    kind: 'weekly-update',
    repo_path: '/repo',
    name: null,
    cron: '0 9 * * 1',
    timezone: null,
    enabled: 1,
    model: null,
    timeout_ms: null,
    last_run_at: null,
    config_json: null,
    prompt: null,
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
    expect(wf?.run).toBeTypeOf('function');
  });

  it('appears in listWorkflows() and listCronWorkflowKinds()', () => {
    expect(listWorkflows().some((w) => w.kind === 'weekly-update')).toBe(true);
    expect(listCronWorkflowKinds()).toContain('weekly-update');
  });

  it('fires the run with the schedule id and repo path, without awaiting it', async () => {
    mockRunWeeklyUpdate.mockReturnValue(new Promise(() => {}));

    const wf = getWorkflow('weekly-update')!;
    const row = makeRow({ id: 'sched-42' });
    await wf.run!({
      repoPath: row.repo_path,
      config: {},
      scheduleId: row.id,
    });

    expect(mockRunWeeklyUpdate).toHaveBeenCalledTimes(1);
    const call = mockRunWeeklyUpdate.mock.calls[0][0];
    expect(call.repoPath).toBe('/repo');
    expect(call.scheduleId).toBe('sched-42');
  });

  it('threads ctx.model and ctx.timeoutMs into runWeeklyUpdate', async () => {
    const wf = getWorkflow('weekly-update')!;
    const row = makeRow({ id: 'sched-99' });
    await wf.run!({
      repoPath: row.repo_path,
      config: {},
      scheduleId: row.id,
      model: 'claude-sonnet-4-6',
      timeoutMs: 180000,
    });

    const call = mockRunWeeklyUpdate.mock.calls[0][0];
    expect(call.model).toBe('claude-sonnet-4-6');
    expect(call.timeoutMs).toBe(180000);
  });

  it('passes undefined model/timeoutMs when ctx has none', async () => {
    const wf = getWorkflow('weekly-update')!;
    const row = makeRow({ id: 'sched-100' });
    await wf.run!({
      repoPath: row.repo_path,
      config: {},
      scheduleId: row.id,
    });

    const call = mockRunWeeklyUpdate.mock.calls[0][0];
    expect(call.model).toBeUndefined();
    expect(call.timeoutMs).toBeUndefined();
  });
});
