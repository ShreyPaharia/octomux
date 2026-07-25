import type { HookEnvelope } from '../../hook-types.js';
import type { IntegrationProvider, JsonSchema, ValidationResult } from '../types.js';
import { registerProvider } from '../registry.js';

/**
 * The Slack chat gateway (server/gateway/*), configured through the
 * integrations registry like Jira/Linear instead of env-only. Unlike those
 * providers this one has nothing to do with workflow-status hooks — it's a
 * background service started at boot (server/gateway/boot.ts) that resolves
 * its tokens as: env var override, then this integration's stored config,
 * then disabled. `events: []` means fireHook/fireIntegrationProviders will
 * never invoke `handler` for it.
 */
export interface SlackGatewayConfig {
  bot_token?: string;
  app_token?: string;
  /** Comma-separated Slack user IDs allowed to message the gateway. */
  allow?: string;
}

const CONFIG_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    bot_token: { type: 'string', title: 'Bot token (xoxb-...)', secret: true },
    app_token: {
      type: 'string',
      title: 'App-level token (xapp-..., Socket Mode)',
      secret: true,
    },
    allow: {
      type: 'string',
      title: 'Allowed sender IDs',
      description: 'Comma-separated Slack user IDs allowed to message the gateway.',
    },
  },
};

function validate(config: unknown): ValidationResult {
  if (typeof config !== 'object' || config === null) {
    return { ok: false, errors: ['config must be an object'] };
  }
  const cfg = config as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of ['bot_token', 'app_token', 'allow'] as const) {
    if (cfg[key] !== undefined && typeof cfg[key] !== 'string') {
      errors.push(`${key} must be a string`);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// Never invoked — no events are registered for this provider (see events: [] below).
async function handler(_envelope: HookEnvelope, _config: unknown): Promise<void> {}

export const slackGatewayProvider: IntegrationProvider = {
  kind: 'slack-gateway',
  displayName: 'Slack Gateway',
  configSchema: CONFIG_SCHEMA,
  events: [],
  validate,
  handler,
};

registerProvider(slackGatewayProvider);
