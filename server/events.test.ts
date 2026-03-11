import { describe, it, expect, beforeEach } from 'vitest';
import {
  setupEventWebSocket,
  broadcast,
  getEventClientCount,
  cleanupEventClients,
  handleEventUpgrade,
} from './events.js';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

describe('events', () => {
  beforeEach(() => {
    cleanupEventClients();
    setupEventWebSocket();
  });

  it('handleEventUpgrade returns false for non-event URLs', () => {
    const req = { url: '/ws/terminal/foo/0' } as IncomingMessage;
    const result = handleEventUpgrade(req, {} as Duplex, Buffer.alloc(0));
    expect(result).toBe(false);
  });

  it('starts with zero clients', () => {
    expect(getEventClientCount()).toBe(0);
  });

  it('broadcast is a no-op with no clients', () => {
    // Should not throw
    broadcast({ type: 'task:updated', payload: { taskId: 't1' } });
    expect(getEventClientCount()).toBe(0);
  });

  it('cleanupEventClients resets to zero', () => {
    cleanupEventClients();
    expect(getEventClientCount()).toBe(0);
  });
});
