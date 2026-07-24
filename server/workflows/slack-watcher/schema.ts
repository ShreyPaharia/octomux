/** JSON Schemas for the slack-watcher vertical. Split out from index.ts so
 * run.ts can import them without a circular dependency.
 *
 * `outcome` + `links` are the universal run-result envelope (see
 * `RUN_RESULT_SCHEMA` in @octomux/types, spec/workflow-consolidation.md §5).
 *
 * Cross-field requirements (telegram target → telegramChatId, slack target →
 * digestUserId/digestChannel) are intentionally NOT schema-enforced: the skill
 * validates at runtime and submits a `blocked` result, so the /schedules form
 * stays simple. Don't add if/then deps here. */
export const SLACK_WATCHER_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    slackUserId: {
      type: 'string',
      title: 'Watched member id',
      description:
        "The owner's member id in the watched workspace (e.g. U01ABCDEF) — whose inbox to search.",
      default: '',
    },
    digestTarget: {
      type: 'string',
      enum: ['slack', 'telegram'],
      title: 'Digest destination',
      description: 'Where the digest goes: a Slack DM/channel via the bot, or Telegram.',
      default: 'slack',
    },
    telegramChatId: {
      type: 'string',
      title: 'Telegram chat id',
      description:
        "Numeric Telegram chat id (the gateway allowlist id). Required for the 'telegram' target.",
      default: '',
    },
    digestUserId: {
      type: 'string',
      title: 'Digest member id',
      description:
        "The owner's member id in the bot's workspace — whom the bot DMs. Same as the watched id when both halves share a workspace.",
      default: '',
    },
    lookbackMinutes: {
      type: 'number',
      title: 'Lookback minutes',
      description: 'How far back each run scans — cron interval plus overlap so nothing is missed.',
      default: 40,
    },
    digestChannel: {
      type: 'string',
      title: 'Digest channel id',
      description: 'Channel for the digest. Empty = the bot opens a DM with the owner.',
      default: '',
    },
  },
  additionalProperties: false,
};

export const SLACK_WATCHER_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['done', 'blocked', 'failed'] },
    window: { type: 'string' },
    summary: { type: 'string' },
    digestSent: { type: 'boolean' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          from: { type: 'string' },
          about: { type: 'string' },
          urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
          suggestedReply: { type: 'string' },
          permalink: { type: 'string' },
          replyChannel: { type: 'string' },
          replyTs: { type: 'string' },
        },
        required: ['channel', 'from', 'about', 'urgency'],
        additionalProperties: false,
      },
    },
    links: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'url'],
        properties: { label: { type: 'string' }, url: { type: 'string' } },
        additionalProperties: false,
      },
    },
  },
  required: ['outcome', 'window', 'summary', 'digestSent', 'items'],
  additionalProperties: false,
};
