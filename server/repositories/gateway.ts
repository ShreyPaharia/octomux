import { getDb } from '../db.js';
import { childLogger } from '../logger.js';

const logger = childLogger('gateway-repo');

export function getThreadConv(channel: string, threadKey: string): string | undefined {
  const row = getDb()
    .prepare(`SELECT conv_id FROM channel_threads WHERE channel = ? AND thread_key = ?`)
    .get(channel, threadKey) as { conv_id: string } | undefined;
  return row?.conv_id;
}

export function setThreadConv(channel: string, threadKey: string, convId: string): void {
  getDb()
    .prepare(
      `INSERT INTO channel_threads (channel, thread_key, conv_id)
       VALUES (?, ?, ?)
       ON CONFLICT(channel, thread_key) DO UPDATE SET conv_id = excluded.conv_id`,
    )
    .run(channel, threadKey, convId);
  logger.info({ channel, thread_key: threadKey, conv_id: convId }, 'thread conv mapped');
}

export function seenInbound(channel: string, externalId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM gateway_inbound WHERE channel = ? AND external_id = ?`)
    .get(channel, externalId);
  return row !== undefined;
}

export function markInbound(channel: string, externalId: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO gateway_inbound (channel, external_id) VALUES (?, ?)`)
    .run(channel, externalId);
}
