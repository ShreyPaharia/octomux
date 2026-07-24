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

  it("threads the previous done run's items into {{previousItems}}", async () => {
    const items = [{ channel: '#x', from: 'Priya', about: 'deploy', urgency: 'high' }];
    const run = insertRun({ workflowKind: 'slack-watcher', trigger: 'cron' });
    finishRun(run.id, {
      status: 'done',
      result: { outcome: 'done', window: '40m', summary: '1', digestSent: true, items },
    });

    expect(previousItemsJson()).toBe(JSON.stringify(items));

    await runSlackWatcher({
      repoPath: '/repos/octomux',
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
    expect(previousItemsJson()).toBe('[]');

    const running = insertRun({ workflowKind: 'slack-watcher', trigger: 'cron' });
    expect(previousItemsJson()).toBe('[]'); // running run has no result yet

    finishRun(running.id, { status: 'failed', error: 'boom' });
    expect(previousItemsJson()).toBe('[]'); // failed run is not dedup memory
  });
});
