import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { SLACK_WATCHER_CONFIG_SCHEMA, SLACK_WATCHER_SCHEMA } from './schema.js';

describe('SLACK_WATCHER_SCHEMA', () => {
  it('requires the run-result envelope alongside kind-specific fields', () => {
    const validate = new Ajv({ useDefaults: true }).compile(SLACK_WATCHER_SCHEMA);

    expect(validate({ window: '40m', summary: 'ok', digestSent: false, items: [] })).toBe(false);
    expect(
      validate({ outcome: 'done', window: '40m', summary: 'ok', digestSent: false, items: [] }),
    ).toBe(true);
  });

  it('accepts a full digest item and rejects an unknown urgency', () => {
    const validate = new Ajv().compile(SLACK_WATCHER_SCHEMA);
    const base = { outcome: 'done', window: '40m', summary: '1 item', digestSent: true };

    expect(
      validate({
        ...base,
        items: [
          {
            channel: '#deploys',
            from: 'Priya',
            about: 'Blocked on the deploy config',
            urgency: 'high',
            suggestedReply: 'Use the staging override for now.',
            permalink: 'https://slack.com/archives/C1/p1',
            replyChannel: 'D0ASZE1MVJS',
            replyTs: '1784893312.104219',
          },
        ],
      }),
    ).toBe(true);
    expect(
      validate({
        ...base,
        items: [{ channel: '#x', from: 'a', about: 'b', urgency: 'urgent' }],
      }),
    ).toBe(false);
  });

  it('accepts items without reply targeting fields', () => {
    const validate = new Ajv().compile(SLACK_WATCHER_SCHEMA);
    expect(
      validate({
        outcome: 'done',
        window: '40m',
        summary: '1 item',
        digestSent: true,
        items: [{ channel: '#x', from: 'a', about: 'b', urgency: 'low' }],
      }),
    ).toBe(true);
  });

  it('applies config defaults for digestTarget, telegramChatId, digestUserId, lookbackMinutes, and digestChannel', () => {
    const validate = new Ajv({ useDefaults: true }).compile(SLACK_WATCHER_CONFIG_SCHEMA);
    const cfg: Record<string, unknown> = { slackUserId: 'U01ABCDEF' };

    expect(validate(cfg)).toBe(true);
    expect(cfg.digestTarget).toBe('slack');
    expect(cfg.telegramChatId).toBe('');
    expect(cfg.digestUserId).toBe('');
    expect(cfg.lookbackMinutes).toBe(40);
    expect(cfg.digestChannel).toBe('');
  });

  it('rejects an unknown digestTarget and accepts self-dm', () => {
    const validate = new Ajv().compile(SLACK_WATCHER_CONFIG_SCHEMA);
    expect(validate({ slackUserId: 'U01ABCDEF', digestTarget: 'email' })).toBe(false);
    expect(validate({ slackUserId: 'U01ABCDEF', digestTarget: 'self-dm' })).toBe(true);
  });
});
