import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { getThreadConv, setThreadConv, seenInbound, markInbound } from './gateway.js';

describe('gateway repository', () => {
  beforeEach(() => createTestDb());

  it('returns undefined for an unmapped thread, then the stored conv_id after set', () => {
    expect(getThreadConv('telegram', 'chat:1')).toBeUndefined();
    setThreadConv('telegram', 'chat:1', 'conv-123');
    expect(getThreadConv('telegram', 'chat:1')).toBe('conv-123');
  });

  it('upserts — setting a new conv_id for the same (channel, thread_key) overwrites', () => {
    setThreadConv('telegram', 'chat:1', 'conv-123');
    setThreadConv('telegram', 'chat:1', 'conv-456');
    expect(getThreadConv('telegram', 'chat:1')).toBe('conv-456');
  });

  it('seenInbound is false, then true after markInbound', () => {
    expect(seenInbound('telegram', 'update-1')).toBe(false);
    markInbound('telegram', 'update-1');
    expect(seenInbound('telegram', 'update-1')).toBe(true);
  });

  it('markInbound is idempotent (INSERT OR IGNORE — no throw on repeat)', () => {
    markInbound('telegram', 'update-1');
    expect(() => markInbound('telegram', 'update-1')).not.toThrow();
    expect(seenInbound('telegram', 'update-1')).toBe(true);
  });

  it('distinct channels do not collide on the same thread_key/external_id', () => {
    setThreadConv('telegram', 'chat:1', 'conv-telegram');
    setThreadConv('slack', 'chat:1', 'conv-slack');
    expect(getThreadConv('telegram', 'chat:1')).toBe('conv-telegram');
    expect(getThreadConv('slack', 'chat:1')).toBe('conv-slack');

    markInbound('telegram', 'update-1');
    expect(seenInbound('telegram', 'update-1')).toBe(true);
    expect(seenInbound('slack', 'update-1')).toBe(false);
  });
});
