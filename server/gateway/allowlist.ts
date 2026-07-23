import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { childLogger } from '../logger.js';

const logger = childLogger('gateway-allowlist');

export type Channel = 'telegram' | 'slack';

const ENV_KEY: Record<Channel, string> = {
  telegram: 'OCTOMUX_GATEWAY_TELEGRAM_ALLOW',
  slack: 'OCTOMUX_GATEWAY_SLACK_ALLOW',
};

function fromEnv(channel: Channel): Set<string> {
  const raw = process.env[ENV_KEY[channel]];
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
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

/**
 * Per-message owner authorization for the gateway — DEFAULT DENY.
 *
 * The gateway runs inside octomux's loopback-trusted server, so an inbound chat
 * message would otherwise inherit full internal trust with no credential. This
 * is the one v1 security control that cannot be skipped: an empty or missing
 * allowlist denies everyone.
 */
export function isAllowed(channel: Channel, senderId: string): boolean {
  const allow = new Set([...fromEnv(channel), ...fromFile(channel)]);
  const ok = allow.has(String(senderId));
  if (!ok) {
    logger.warn({ channel, sender_id: senderId }, 'gateway: sender not on allowlist — denied');
  }
  return ok;
}
