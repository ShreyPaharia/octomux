import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkflow, listWorkflows, listCronWorkflowKinds } from '../registry.js';

const mockRunDailyPlanFromSchedule = vi.fn().mockResolvedValue(undefined);

vi.mock('./run.js', () => ({
  runDailyPlanFromSchedule: (...args: unknown[]) => mockRunDailyPlanFromSchedule(...args),
}));

import './index.js';

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
    expect(wf?.run).toBeTypeOf('function');
  });

  it('appears in listWorkflows() and listCronWorkflowKinds()', () => {
    expect(listWorkflows().some((w) => w.kind === 'daily-plan')).toBe(true);
    expect(listCronWorkflowKinds()).toContain('daily-plan');
  });

  it('fires the run with the schedule id', async () => {
    const wf = getWorkflow('daily-plan')!;
    await wf.run!({
      repoPath: '/repo',
      config: {},
      scheduleId: 'sched-42',
    });

    expect(mockRunDailyPlanFromSchedule).toHaveBeenCalledTimes(1);
    const call = mockRunDailyPlanFromSchedule.mock.calls[0][0];
    expect(call.scheduleId).toBe('sched-42');
  });

  it('threads ctx.model into runDailyPlanFromSchedule', async () => {
    const wf = getWorkflow('daily-plan')!;
    await wf.run!({
      repoPath: '/repo',
      config: {},
      scheduleId: 'sched-99',
      model: 'claude-opus-4-8',
    });

    const call = mockRunDailyPlanFromSchedule.mock.calls[0][0];
    expect(call.scheduleId).toBe('sched-99');
    expect(call.model).toBe('claude-opus-4-8');
  });

  it('passes undefined model when ctx has none', async () => {
    const wf = getWorkflow('daily-plan')!;
    await wf.run!({
      repoPath: '/repo',
      config: {},
      scheduleId: 'sched-100',
    });

    const call = mockRunDailyPlanFromSchedule.mock.calls[0][0];
    expect(call.model).toBeUndefined();
  });
});
