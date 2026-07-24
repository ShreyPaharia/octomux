import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkflow, listWorkflows, listCronWorkflowKinds } from '../registry.js';
import { resolveWorkflowConfig } from '../config.js';
import type { ScheduleRow } from '../../repositories/schedules.js';

const mockRunSlackWatcher = vi.fn().mockResolvedValue({ result: {} });

vi.mock('./run.js', () => ({
  runSlackWatcher: (...args: unknown[]) => mockRunSlackWatcher(...args),
}));

import './index.js';

function makeRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched1',
    kind: 'slack-watcher',
    repo_path: '/repo',
    name: null,
    cron: '*/30 3-18 * * *',
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

describe('slack-watcher workflow registration', () => {
  beforeEach(() => {
    mockRunSlackWatcher.mockClear();
  });

  it('registers the kind with an artifact surface, config, output schema, cron trigger', () => {
    const wf = getWorkflow('slack-watcher');
    expect(wf).toBeDefined();
    expect(wf?.displayName).toBe('Slack Watcher');
    expect(wf?.surfaces).toEqual(['artifact']);
    expect(wf?.config).toBeDefined();
    expect(wf?.output).toBeDefined();
    expect(wf?.trigger).toEqual({ kind: 'cron' });
  });

  it('appears in listWorkflows() and listCronWorkflowKinds()', () => {
    expect(listWorkflows().some((w) => w.kind === 'slack-watcher')).toBe(true);
    expect(listCronWorkflowKinds()).toContain('slack-watcher');
  });

  it('fires the run with schedule id and config defaults, without awaiting it', async () => {
    mockRunSlackWatcher.mockReturnValue(new Promise(() => {}));

    const wf = getWorkflow('slack-watcher')!;
    const row = makeRow({ id: 'sched-42', config_json: JSON.stringify({ slackUserId: 'U07X' }) });
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(wf, row.config_json),
      scheduleId: row.id,
    });

    expect(mockRunSlackWatcher).toHaveBeenCalledTimes(1);
    const call = mockRunSlackWatcher.mock.calls[0][0];
    expect(call.repoPath).toBe('/repo');
    expect(call.scheduleId).toBe('sched-42');
    expect(call.slackUserId).toBe('U07X');
    expect(call.digestTarget).toBe('slack');
    expect(call.telegramChatId).toBe('');
    expect(call.digestUserId).toBe('');
    expect(call.lookbackMinutes).toBe(40);
    expect(call.digestChannel).toBe('');
  });

  it('passes through config overrides for digest user, lookback, and digest channel', async () => {
    const wf = getWorkflow('slack-watcher')!;
    const row = makeRow({
      config_json: JSON.stringify({
        slackUserId: 'U07X',
        digestTarget: 'telegram',
        telegramChatId: '555123',
        digestUserId: 'U0PERSONAL',
        lookbackMinutes: 20,
        digestChannel: 'C9',
      }),
    });
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(wf, row.config_json),
      scheduleId: row.id,
    });

    const call = mockRunSlackWatcher.mock.calls[0][0];
    expect(call.digestTarget).toBe('telegram');
    expect(call.telegramChatId).toBe('555123');
    expect(call.digestUserId).toBe('U0PERSONAL');
    expect(call.lookbackMinutes).toBe(20);
    expect(call.digestChannel).toBe('C9');
  });

  it('threads ctx.model and ctx.timeoutMs into runSlackWatcher', async () => {
    const wf = getWorkflow('slack-watcher')!;
    const row = makeRow({ config_json: JSON.stringify({ slackUserId: 'U07X' }) });
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(wf, row.config_json),
      scheduleId: row.id,
      model: 'claude-haiku-4-5-20251001',
      timeoutMs: 60000,
    });

    const call = mockRunSlackWatcher.mock.calls[0][0];
    expect(call.model).toBe('claude-haiku-4-5-20251001');
    expect(call.timeoutMs).toBe(60000);
  });

  it('passes null model/timeoutMs through when ctx has none', async () => {
    const wf = getWorkflow('slack-watcher')!;
    const row = makeRow({ config_json: JSON.stringify({ slackUserId: 'U07X' }) });
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(wf, row.config_json),
      scheduleId: row.id,
    });

    const call = mockRunSlackWatcher.mock.calls[0][0];
    expect(call.model).toBeUndefined();
    expect(call.timeoutMs).toBeUndefined();
  });
});
