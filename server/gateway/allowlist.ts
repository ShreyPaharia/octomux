import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { childLogger } from '../logger.js';
import { listIntegrations } from '../integrations/store.js';

const logger = childLogger('gateway-allowlist');

export type Channel = 'telegram' | 'slack';

const ENV_KEY: Record<Channel, string> = {
  telegram: 'OCTOMUX_GATEWAY_TELEGRAM_ALLOW',
  slack: 'OCTOMUX_GATEWAY_SLACK_ALLOW',
};

const INTEGRATION_KIND: Record<Channel, string> = {
  telegram: 'telegram-gateway',
  slack: 'slack-gateway',
};

function parseIdList(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function fromEnv(channel: Channel): Set<string> {
  const raw = process.env[ENV_KEY[channel]];
  return raw ? parseIdList(raw) : new Set();
}

function fromFile(channel: Channel): Set<string> {
  try {
    const file = path.join(os.homedir(), '.octomux', 'gateway-allowlist.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const ids = Array.isArray(cfg[channel]) ? (cfg[channel] as unknown[]) : [];
    return new Set(ids.map(String));
  } catch {
    return new Set();
  }
}

/** The `allow` field of the first enabled `<channel>-gateway` integration row. */
function fromIntegration(channel: Channel): Set<string> {
  try {
    const row = listIntegrations().find((i) => i.kind === INTEGRATION_KIND[channel] && i.enabled);
    const raw = (row?.config as Record<string, unknown> | undefined)?.allow;
    return typeof raw === 'string' && raw ? parseIdList(raw) : new Set();
  } catch {
    return new Set();
  }
}

/**
 * Per-message owner authorization for the gateway — DEFAULT DENY.
 *
 * The gateway runs inside octomux's loopback-trusted server, so an inbound chat
 * message would otherwise inherit full internal trust with no credential. This
 * is the one v1 security control that cannot be skipped: an empty or missing
 * allowlist denies everyone.
 *
 * Sources: the env var overrides the stored `<channel>-gateway` integration's
 * `allow` field (same env-first resolution as the gateway tokens); the
 * legacy `~/.octomux/gateway-allowlist.json` file is additive on top of
 * whichever of those two wins, unchanged from its pre-existing behavior.
 */
export function isAllowed(channel: Channel, senderId: string): boolean {
  const envAllow = fromEnv(channel);
  const base = envAllow.size > 0 ? envAllow : fromIntegration(channel);
  const allow = new Set([...base, ...fromFile(channel)]);
  const ok = allow.has(String(senderId));
  if (!ok) {
    logger.warn({ channel, sender_id: senderId }, 'gateway: sender not on allowlist — denied');
  }
  return ok;
}
