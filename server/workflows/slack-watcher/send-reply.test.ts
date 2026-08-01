import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRunSessionVertical = vi.fn();

vi.mock('../../services/session-vertical-service.js', () => ({
  runSessionVertical: (...args: unknown[]) => mockRunSessionVertical(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { sendWatcherReply, SEND_REPLY_SCHEMA } from './send-reply.js';
import { getWorkflow, listCronWorkflowKinds } from '../registry.js';

describe('sendWatcherReply', () => {
  beforeEach(() => {
    mockRunSessionVertical.mockReset();
  });

  it('runs a slack-watcher-reply vertical with a verbatim-send prompt', async () => {
    mockRunSessionVertical.mockResolvedValue({ result: { outcome: 'done' } });

    const result = await sendWatcherReply({
      workspaceDir: '/repos/octomux',
      channel: 'D0ASZE1MVJS',
      threadTs: '1784893312.104219',
      text: 'taking a look now, will approve if all good',
    });

    expect(result).toEqual({ outcome: 'done' });
    const call = mockRunSessionVertical.mock.calls[0][0];
    expect(call.kind).toBe('slack-watcher-reply');
    expect(call.workspaceDir).toBe('/repos/octomux');
    expect(call.outputSchema).toBe(SEND_REPLY_SCHEMA);
    expect(call.trigger).toBe('manual');
    expect(call.input).toContain('D0ASZE1MVJS');
    expect(call.input).toContain('1784893312.104219');
    expect(call.input).toContain('taking a look now, will approve if all good');
    expect(call.input).toContain('EXACTLY');
  });

  it('maps a vertical failure to a failed outcome instead of throwing', async () => {
    mockRunSessionVertical.mockRejectedValue(new Error('session died'));

    const result = await sendWatcherReply({
      workspaceDir: '/repos/octomux',
      channel: 'C1',
      threadTs: '1.2',
      text: 'ok',
    });

    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('session died');
  });

  it('registers slack-watcher-reply as a feed-only kind (not cron-schedulable)', () => {
    const wf = getWorkflow('slack-watcher-reply');
    expect(wf).toBeDefined();
    expect(wf?.surfaces).toEqual(['feed']);
    expect(listCronWorkflowKinds()).not.toContain('slack-watcher-reply');
  });
});
