import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '../../test-helpers.js';
import { insertRun, finishRun } from '../../repositories/runs.js';

const mockGetSkill = vi.fn();
const mockRunSessionVertical = vi.fn();

vi.mock('../../skills.js', () => ({
  getSkill: (...args: unknown[]) => mockGetSkill(...args),
}));
vi.mock('../../services/session-vertical-service.js', () => ({
  runSessionVertical: (...args: unknown[]) => mockRunSessionVertical(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { runSlackWatcher, previousItemsJson } from './run.js';
import { SLACK_WATCHER_SCHEMA } from './schema.js';

const SKILL_BODY =
  'Watch {{slackUserId}} back {{lookbackMinutes}}m, via {{digestTarget}} tg:{{telegramChatId}} DM {{digestUserId}} at "{{digestChannel}}", skip {{previousItems}}.';

describe('runSlackWatcher', () => {
  beforeEach(() => {
    createTestDb();
    mockGetSkill.mockReset();
    mockRunSessionVertical.mockReset();
    mockGetSkill.mockResolvedValue({ name: 'slack-watcher', content: SKILL_BODY });
    mockRunSessionVertical.mockResolvedValue({ result: { summary: 'ok' } });
  });

  it('interpolates config placeholders and calls runSessionVertical', async () => {
    const { result } = await runSlackWatcher({
      repoPath: '/repos/octomux',
      scheduleId: 'sched-1',
      slackUserId: 'U01ABCDEF',
      digestTarget: 'slack',
      telegramChatId: '',
      digestUserId: 'U0PERSONAL',
      lookbackMinutes: 40,
      digestChannel: '',
    });

    expect(result).toEqual({ summary: 'ok' });
    expect(mockGetSkill).toHaveBeenCalledWith('slack-watcher');
    const call = mockRunSessionVertical.mock.calls[0][0];
    expect(call.kind).toBe('slack-watcher');
    expect(call.scheduleId).toBe('sched-1');
    expect(call.workspaceDir).toBe('/repos/octomux');
    expect(call.input).toBe(
      'Watch U01ABCDEF back 40m, via slack tg: DM U0PERSONAL at "", skip [].',
    );
    expect(call.outputSchema).toBe(SLACK_WATCHER_SCHEMA);
  });

  it('passes model and timeoutMs through to runSessionVertical', async () => {
    await runSlackWatcher({
      repoPath: '/repos/octomux',
      scheduleId: 'sched-1',
      slackUserId: 'U01',
      digestTarget: 'slack',
      telegramChatId: '',
      digestUserId: 'U0P',
      lookbackMinutes: 40,
      digestChannel: '',
      model: 'claude-haiku-4-5-20251001',
      timeoutMs: 120000,
    });

    const call = mockRunSessionVertical.mock.calls[0][0];
    expect(call.model).toBe('claude-haiku-4-5-20251001');
    expect(call.timeoutMs).toBe(120000);
  });

  it('passes null model and timeoutMs through to runSessionVertical when omitted', async () => {
    await runSlackWatcher({
      repoPath: '/repos/octomux',
      slackUserId: 'U01',
      digestTarget: 'slack',
      telegramChatId: '',
      digestUserId: 'U0P',
      lookbackMinutes: 40,
      digestChannel: '',
    });

    const call = mockRunSessionVertical.mock.calls[0][0];
    expect(call.model).toBeUndefined();
    expect(call.timeoutMs).toBeUndefined();
  });

  it("threads the previous done run's items into {{previousItems}}", async () => {
    const items = [{ channel: '#x', from: 'Priya', about: 'deploy', urgency: 'high' }];
    const run = insertRun({
      workflowKind: 'slack-watcher',
      trigger: 'cron',
      scheduleId: 'sched-x',
    });
    finishRun(run.id, {
      status: 'done',
      result: { outcome: 'done', window: '40m', summary: '1', digestSent: true, items },
    });

    expect(previousItemsJson('sched-x')).toBe(JSON.stringify(items));

    await runSlackWatcher({
      repoPath: '/repos/octomux',
      scheduleId: 'sched-x',
      slackUserId: 'U01ABCDEF',
      digestTarget: 'telegram',
      telegramChatId: '555123',
      digestUserId: 'U0PERSONAL',
      lookbackMinutes: 40,
      digestChannel: 'C123',
    });
    const call = mockRunSessionVertical.mock.calls[0][0];
    expect(call.input).toContain(JSON.stringify(items));
    expect(call.input).toContain('via telegram tg:555123 DM U0PERSONAL at "C123"');
  });

  it('falls back to [] for missing, unfinished, or malformed previous runs', () => {
    expect(previousItemsJson('sched-empty')).toBe('[]');

    const running = insertRun({
      workflowKind: 'slack-watcher',
      trigger: 'cron',
      scheduleId: 'sched-empty',
    });
    expect(previousItemsJson('sched-empty')).toBe('[]'); // running run has no result yet

    finishRun(running.id, { status: 'failed', error: 'boom' });
    expect(previousItemsJson('sched-empty')).toBe('[]'); // failed run is not dedup memory
  });

  it('falls back to [] when scheduleId is null/undefined', () => {
    expect(previousItemsJson(null)).toBe('[]');
    expect(previousItemsJson(undefined)).toBe('[]');
    expect(previousItemsJson()).toBe('[]');
  });

  it('previousItems is passed as a string scalar — a value containing {{tokens}} stays literal', async () => {
    // Insert a run whose items JSON happens to contain curly-brace text
    const items = [{ channel: '#x', from: 'bot', about: '{{slackUserId}}', urgency: 'low' }];
    const run = insertRun({
      workflowKind: 'slack-watcher',
      trigger: 'cron',
      scheduleId: 'sched-lit',
    });
    finishRun(run.id, {
      status: 'done',
      result: { outcome: 'done', window: '40m', summary: '1', digestSent: false, items },
    });

    await runSlackWatcher({
      repoPath: '/repos/octomux',
      scheduleId: 'sched-lit',
      slackUserId: 'REAL_USER',
      digestTarget: 'slack',
      telegramChatId: '',
      digestUserId: 'U0P',
      lookbackMinutes: 40,
      digestChannel: '',
    });

    const call = mockRunSessionVertical.mock.calls[0][0];
    // {{slackUserId}} inside the previousItems JSON must NOT be substituted —
    // interpolatePrompt is single-pass, so the already-substituted previousItems
    // string is not re-scanned.
    expect(call.input).toContain('{{slackUserId}}');
    // But the top-level {{slackUserId}} placeholder IS substituted
    expect(call.input).toContain('Watch REAL_USER');
  });

  describe('previousItemsJson schedule isolation', () => {
    it("two schedules' runs don't cross-contaminate each other's dedup memory", () => {
      const itemsA = [{ channel: '#a', from: 'Alice', about: 'ping', urgency: 'low' }];
      const itemsB = [{ channel: '#b', from: 'Bob', about: 'pong', urgency: 'high' }];

      const runA = insertRun({
        workflowKind: 'slack-watcher',
        trigger: 'cron',
        scheduleId: 'sched-A',
      });
      finishRun(runA.id, {
        status: 'done',
        result: { outcome: 'done', window: '40m', summary: 'a', digestSent: true, items: itemsA },
      });

      const runB = insertRun({
        workflowKind: 'slack-watcher',
        trigger: 'cron',
        scheduleId: 'sched-B',
      });
      finishRun(runB.id, {
        status: 'done',
        result: { outcome: 'done', window: '40m', summary: 'b', digestSent: true, items: itemsB },
      });

      expect(previousItemsJson('sched-A')).toBe(JSON.stringify(itemsA));
      expect(previousItemsJson('sched-B')).toBe(JSON.stringify(itemsB));
      // sched-A must not see sched-B's items and vice-versa
      expect(previousItemsJson('sched-A')).not.toBe(JSON.stringify(itemsB));
      expect(previousItemsJson('sched-B')).not.toBe(JSON.stringify(itemsA));
    });
  });
});
