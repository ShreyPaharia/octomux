import type { HookEnvelope } from '../../hook-types.js';
import type { IntegrationProvider, JsonSchema, ValidationResult } from '../types.js';
import { registerProvider } from '../registry.js';

/**
 * The Telegram chat gateway (server/gateway/*), configured through the
 * integrations registry like Jira/Linear instead of env-only. See
 * slack-gateway/index.ts for the shared rationale — this one is the
 * Telegram counterpart, resolved as env var override, then this
 * integration's stored config, then disabled.
 */
export interface TelegramGatewayConfig {
  token?: string;
  /** Comma-separated Telegram user IDs allowed to message the gateway. */
  allow?: string;
}

const CONFIG_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    token: { type: 'string', title: 'Bot token', secret: true },
    allow: {
      type: 'string',
      title: 'Allowed sender IDs',
      description: 'Comma-separated Telegram user IDs allowed to message the gateway.',
    },
  },
};

function validate(config: unknown): ValidationResult {
  if (typeof config !== 'object' || config === null) {
    return { ok: false, errors: ['config must be an object'] };
  }
  const cfg = config as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of ['token', 'allow'] as const) {
    if (cfg[key] !== undefined && typeof cfg[key] !== 'string') {
      errors.push(`${key} must be a string`);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// Never invoked — no events are registered for this provider (see events: [] below).
async function handler(_envelope: HookEnvelope, _config: unknown): Promise<void> {}

export const telegramGatewayProvider: IntegrationProvider = {
  kind: 'telegram-gateway',
  displayName: 'Telegram Gateway',
  configSchema: CONFIG_SCHEMA,
  events: [],
  validate,
  handler,
};

registerProvider(telegramGatewayProvider);
