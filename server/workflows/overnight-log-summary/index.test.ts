import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkflow, listWorkflows, listCronWorkflowKinds } from '../registry.js';
import { resolveWorkflowConfig } from '../config.js';
import type { ScheduleRow } from '../../repositories/schedules.js';

const mockRunSession = vi.fn().mockResolvedValue(undefined);

vi.mock('../session-runner.js', () => ({
  runSession: (...args: unknown[]) => mockRunSession(...args),
}));

import './index.js';

function makeRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched1',
    kind: 'overnight-log-summary',
    repo_path: '/repo',
    name: null,
    cron: '0 6 * * *',
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

describe('overnight-log-summary workflow registration', () => {
  beforeEach(() => {
    mockRunSession.mockClear();
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

  it('fires the generic session runner with the schedule id, repo path, and kind, without awaiting it', async () => {
    mockRunSession.mockReturnValue(new Promise(() => {}));

    const row = makeRow({ id: 'sched-42' });
    const wf = getWorkflow('overnight-log-summary')!;
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(row.config_json),
      scheduleId: row.id,
    });

    expect(mockRunSession).toHaveBeenCalledTimes(1);
    const call = mockRunSession.mock.calls[0][0];
    expect(call.repoPath).toBe('/repo');
    expect(call.scheduleId).toBe('sched-42');
    expect(call.kind).toBe('overnight-log-summary');
  });

  it('passes config_json through to the session runner verbatim (defaults are write-time, not read-time)', async () => {
    const wf = getWorkflow('overnight-log-summary')!;
    const row = makeRow({ config_json: JSON.stringify({ logCommand: 'flyctl logs -a my-app' }) });
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(row.config_json),
      scheduleId: row.id,
    });

    const call = mockRunSession.mock.calls[0][0];
    expect(call.config).toEqual({ logCommand: 'flyctl logs -a my-app' });
  });

  it('threads ctx.model and ctx.timeoutMs into runSession', async () => {
    const wf = getWorkflow('overnight-log-summary')!;
    const row = makeRow({ id: 'sched-99' });
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(row.config_json),
      scheduleId: row.id,
      model: 'claude-sonnet-4-6',
      timeoutMs: 450000,
    });

    const call = mockRunSession.mock.calls[0][0];
    expect(call.model).toBe('claude-sonnet-4-6');
    expect(call.timeoutMs).toBe(450000);
  });

  it('passes undefined model/timeoutMs when ctx has none', async () => {
    const wf = getWorkflow('overnight-log-summary')!;
    const row = makeRow({ id: 'sched-100' });
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(row.config_json),
      scheduleId: row.id,
    });

    const call = mockRunSession.mock.calls[0][0];
    expect(call.model).toBeUndefined();
    expect(call.timeoutMs).toBeUndefined();
  });
});
