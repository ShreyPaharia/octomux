import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkflow } from '../registry.js';
import { DOC_DRIFT_CONFIG_SCHEMA } from './schema.js';

const mockCreateDocDriftTaskFromSchedule = vi.fn().mockResolvedValue({ id: 'task1' });

vi.mock('./run.js', () => ({
  createDocDriftTaskFromSchedule: (...args: unknown[]) =>
    mockCreateDocDriftTaskFromSchedule(...args),
}));

import './index.js';

/** Build a resolved config with schema defaults applied without going through AJV. */
function defaultConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const props = DOC_DRIFT_CONFIG_SCHEMA.properties as Record<string, { default?: unknown }>;
  for (const [key, prop] of Object.entries(props)) {
    if ('default' in prop) defaults[key] = prop.default;
  }
  return { ...defaults, ...overrides };
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

  it('schema includes baseBranch and branchPrefix with format and pattern constraints', () => {
    const props = DOC_DRIFT_CONFIG_SCHEMA.properties as Record<string, Record<string, unknown>>;
    expect(props.baseBranch).toBeDefined();
    expect(props.baseBranch.default).toBe('main');
    expect(props.baseBranch.format).toBe('single-line');
    expect(props.baseBranch.pattern).toBe('^[a-zA-Z0-9._/-]{1,80}$');
    expect(props.branchPrefix).toBeDefined();
    expect(props.branchPrefix.default).toBe('doc-drift');
    expect(props.branchPrefix.format).toBe('single-line');
    expect(props.branchPrefix.pattern).toBe('^[a-zA-Z0-9._/-]{1,80}$');
  });

  it('default verify is scoped to the task branch (--head), not repo-wide', async () => {
    const wf = getWorkflow('doc-drift')!;
    await wf.run!({
      repoPath: '/repo',
      config: defaultConfig(),
      scheduleId: 'sched1',
    });

    expect(mockCreateDocDriftTaskFromSchedule).toHaveBeenCalledTimes(1);
    const call = mockCreateDocDriftTaskFromSchedule.mock.calls[0][0];
    expect(call.verify).toContain('--head');
    expect(call.verify).not.toContain('--search');
  });

  it('passes the schedule id through as scheduleId', async () => {
    const wf = getWorkflow('doc-drift')!;
    await wf.run!({
      repoPath: '/repo',
      config: defaultConfig(),
      scheduleId: 'sched-42',
    });

    const call = mockCreateDocDriftTaskFromSchedule.mock.calls[0][0];
    expect(call.scheduleId).toBe('sched-42');
  });

  it('applies schema defaults: maxIterations=4, baseBranch=main, branchPrefix=doc-drift', async () => {
    const wf = getWorkflow('doc-drift')!;
    await wf.run!({
      repoPath: '/repo',
      config: defaultConfig(),
      scheduleId: 'sched1',
    });

    const call = mockCreateDocDriftTaskFromSchedule.mock.calls[0][0];
    expect(call.maxIterations).toBe(4);
    expect(call.verify).toContain('origin/HEAD');
    expect(call.baseBranch).toBe('main');
    expect(call.branchPrefix).toBe('doc-drift');
  });

  it('passes through config overrides for verify/maxIterations', async () => {
    const wf = getWorkflow('doc-drift')!;
    await wf.run!({
      repoPath: '/repo',
      config: defaultConfig({ verify: 'bun run test', maxIterations: 2 }),
      scheduleId: 'sched1',
    });

    const call = mockCreateDocDriftTaskFromSchedule.mock.calls[0][0];
    expect(call.verify).toBe('bun run test');
    expect(call.maxIterations).toBe(2);
  });

  it('passes through config overrides for baseBranch and branchPrefix', async () => {
    const wf = getWorkflow('doc-drift')!;
    await wf.run!({
      repoPath: '/repo',
      config: defaultConfig({ baseBranch: 'develop', branchPrefix: 'docs/fix' }),
      scheduleId: 'sched1',
    });

    const call = mockCreateDocDriftTaskFromSchedule.mock.calls[0][0];
    expect(call.baseBranch).toBe('develop');
    expect(call.branchPrefix).toBe('docs/fix');
  });

  it('threads ctx.model through to the service call', async () => {
    const wf = getWorkflow('doc-drift')!;
    await wf.run!({
      repoPath: '/repo',
      config: defaultConfig(),
      scheduleId: 'sched1',
      model: 'claude-opus-4-8',
    });

    const call = mockCreateDocDriftTaskFromSchedule.mock.calls[0][0];
    expect(call.model).toBe('claude-opus-4-8');
  });

  it('passes null model when ctx.model is not set', async () => {
    const wf = getWorkflow('doc-drift')!;
    await wf.run!({
      repoPath: '/repo',
      config: defaultConfig(),
      scheduleId: 'sched1',
    });

    const call = mockCreateDocDriftTaskFromSchedule.mock.calls[0][0];
    expect(call.model).toBeUndefined();
  });
});
