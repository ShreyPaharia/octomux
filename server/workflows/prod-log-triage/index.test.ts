import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkflow } from '../registry.js';
import { PROD_LOG_TRIAGE_CONFIG_SCHEMA } from './schema.js';

const mockCreateTriageTaskFromSchedule = vi.fn().mockResolvedValue({ id: 'task1' });

vi.mock('./run.js', () => ({
  createTriageTaskFromSchedule: (...args: unknown[]) => mockCreateTriageTaskFromSchedule(...args),
}));

import './index.js';

/** Build a resolved config with schema defaults applied without going through AJV. */
function defaultConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const props = PROD_LOG_TRIAGE_CONFIG_SCHEMA.properties as Record<string, { default?: unknown }>;
  for (const [key, prop] of Object.entries(props)) {
    if ('default' in prop) defaults[key] = prop.default;
  }
  return { ...defaults, ...overrides };
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

  it('schema includes baseBranch and branchPrefix with format and pattern constraints', () => {
    const props = PROD_LOG_TRIAGE_CONFIG_SCHEMA.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.baseBranch).toBeDefined();
    expect(props.baseBranch.default).toBe('main');
    expect(props.baseBranch.format).toBe('single-line');
    expect(props.baseBranch.pattern).toBe('^[a-zA-Z0-9._/-]{1,80}$');
    expect(props.branchPrefix).toBeDefined();
    expect(props.branchPrefix.default).toBe('triage');
    expect(props.branchPrefix.format).toBe('single-line');
    expect(props.branchPrefix.pattern).toBe('^[a-zA-Z0-9._/-]{1,80}$');
  });

  it('default verify is scoped to the task branch (--head), not repo-wide (--search)', async () => {
    const wf = getWorkflow('prod-log-triage')!;
    await wf.run!({
      repoPath: '/repo',
      config: defaultConfig(),
      scheduleId: 'sched1',
    });

    expect(mockCreateTriageTaskFromSchedule).toHaveBeenCalledTimes(1);
    const call = mockCreateTriageTaskFromSchedule.mock.calls[0][0];
    expect(call.verify).toContain('--head');
    expect(call.verify).not.toContain('--search');
  });

  it('passes the schedule id through as scheduleId', async () => {
    const wf = getWorkflow('prod-log-triage')!;
    await wf.run!({
      repoPath: '/repo',
      config: defaultConfig(),
      scheduleId: 'sched-42',
    });

    const call = mockCreateTriageTaskFromSchedule.mock.calls[0][0];
    expect(call.scheduleId).toBe('sched-42');
  });

  it('applies schema defaults: logCommand, maxIterations=5, baseBranch=main, branchPrefix=triage', async () => {
    const wf = getWorkflow('prod-log-triage')!;
    await wf.run!({
      repoPath: '/repo',
      config: defaultConfig(),
      scheduleId: 'sched1',
    });

    const call = mockCreateTriageTaskFromSchedule.mock.calls[0][0];
    expect(call.logCommand).toBe('gh run list --limit 20 --json databaseId,conclusion,name,url');
    expect(call.maxIterations).toBe(5);
    expect(call.baseBranch).toBe('main');
    expect(call.branchPrefix).toBe('triage');
  });

  it('passes through config overrides for logCommand/verify/maxIterations', async () => {
    const wf = getWorkflow('prod-log-triage')!;
    await wf.run!({
      repoPath: '/repo',
      config: defaultConfig({
        logCommand: 'flyctl logs -a my-app',
        verify: 'bun run test',
        maxIterations: 3,
      }),
      scheduleId: 'sched1',
    });

    const call = mockCreateTriageTaskFromSchedule.mock.calls[0][0];
    expect(call.logCommand).toBe('flyctl logs -a my-app');
    expect(call.verify).toBe('bun run test');
    expect(call.maxIterations).toBe(3);
  });

  it('passes through config overrides for baseBranch and branchPrefix', async () => {
    const wf = getWorkflow('prod-log-triage')!;
    await wf.run!({
      repoPath: '/repo',
      config: defaultConfig({ baseBranch: 'release', branchPrefix: 'ops/triage' }),
      scheduleId: 'sched1',
    });

    const call = mockCreateTriageTaskFromSchedule.mock.calls[0][0];
    expect(call.baseBranch).toBe('release');
    expect(call.branchPrefix).toBe('ops/triage');
  });

  it('threads ctx.model through to the service call', async () => {
    const wf = getWorkflow('prod-log-triage')!;
    await wf.run!({
      repoPath: '/repo',
      config: defaultConfig(),
      scheduleId: 'sched1',
      model: 'claude-sonnet-4-6',
    });

    const call = mockCreateTriageTaskFromSchedule.mock.calls[0][0];
    expect(call.model).toBe('claude-sonnet-4-6');
  });

  it('passes undefined model when ctx.model is not set', async () => {
    const wf = getWorkflow('prod-log-triage')!;
    await wf.run!({
      repoPath: '/repo',
      config: defaultConfig(),
      scheduleId: 'sched1',
    });

    const call = mockCreateTriageTaskFromSchedule.mock.calls[0][0];
    expect(call.model).toBeUndefined();
  });
});
