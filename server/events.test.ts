import { describe, it, expect, beforeEach } from 'vitest';
import {
  setupEventWebSocket,
  broadcast,
  getEventClientCount,
  cleanupEventClients,
  handleEventUpgrade,
  replayEventsSince,
} from './events.js';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { createTestDb } from './test-helpers.js';
import { eventsSince } from './orchestrator/store.js';

describe('events', () => {
  beforeEach(() => {
    createTestDb();
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

  it('broadcast is a no-op with no clients (does not throw)', () => {
    // Should not throw
    broadcast({ type: 'task:updated', payload: { taskId: 't1' } });
    expect(getEventClientCount()).toBe(0);
  });

  it('cleanupEventClients resets to zero', () => {
    cleanupEventClients();
    expect(getEventClientCount()).toBe(0);
  });

  describe('persist-then-emit (durable events log)', () => {
    it('broadcast persists a task:updated event row with seq > 0', () => {
      broadcast({ type: 'task:updated', payload: { taskId: 'task-abc' } });
      const events = eventsSince(0);
      expect(events.length).toBeGreaterThanOrEqual(1);
      const ev = events.find((e) => e.type === 'task:updated' && e.task_id === 'task-abc');
      expect(ev).toBeDefined();
      expect(ev!.seq).toBeGreaterThan(0);
    });

    it('broadcast persists task:phase_complete event with correct task_id', () => {
      broadcast({ type: 'task:phase_complete', payload: { taskId: 'task-pc', phase: 'planning' } });
      const events = eventsSince(0);
      const ev = events.find((e) => e.type === 'task:phase_complete');
      expect(ev).toBeDefined();
      expect(ev!.task_id).toBe('task-pc');
    });

    it('broadcast persists task:stuck event with correct task_id', () => {
      broadcast({ type: 'task:stuck', payload: { taskId: 'task-st', reason: 'timeout' } });
      const events = eventsSince(0);
      const ev = events.find((e) => e.type === 'task:stuck');
      expect(ev).toBeDefined();
      expect(ev!.task_id).toBe('task-st');
    });

    it('seq is monotone increasing across multiple broadcasts', () => {
      broadcast({ type: 'task:updated', payload: { taskId: 'task-1' } });
      broadcast({ type: 'task:created', payload: { taskId: 'task-2' } });
      broadcast({ type: 'task:updated', payload: { taskId: 'task-1' } });
      const events = eventsSince(0);
      const seqs = events.map((e) => e.seq);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      }
    });

    it('broadcast persists the payload as valid JSON', () => {
      const payload = { taskId: 'task-p', phase: 'planning' };
      broadcast({ type: 'task:phase_complete', payload });
      const events = eventsSince(0);
      const ev = events.find((e) => e.type === 'task:phase_complete' && e.task_id === 'task-p');
      expect(ev).toBeDefined();
      expect(() => JSON.parse(ev!.payload)).not.toThrow();
      const parsed = JSON.parse(ev!.payload);
      expect(parsed.taskId).toBe('task-p');
    });
  });

  describe('replayEventsSince', () => {
    it('sends events after the given seq to the send function', () => {
      broadcast({ type: 'task:updated', payload: { taskId: 'r-task-1' } });
      broadcast({ type: 'task:created', payload: { taskId: 'r-task-2' } });
      const allEvents = eventsSince(0);
      const firstSeq = allEvents[0]!.seq;

      const sent: string[] = [];
      replayEventsSince(firstSeq, (msg) => sent.push(msg));

      // Should have sent all events with seq > firstSeq
      expect(sent.length).toBeGreaterThanOrEqual(1);
      const parsed = sent.map((s) => JSON.parse(s));
      expect(parsed.every((p: any) => p.seq > firstSeq)).toBe(true);
    });

    it('sends zero events when nothing is after seq', () => {
      broadcast({ type: 'task:updated', payload: { taskId: 'r-only' } });
      const events = eventsSince(0);
      const lastSeq = events[events.length - 1]!.seq;

      const sent: string[] = [];
      replayEventsSince(lastSeq, (msg) => sent.push(msg));
      expect(sent).toHaveLength(0);
    });

    it('sends events as JSON strings with seq, type, and payload', () => {
      broadcast({ type: 'task:updated', payload: { taskId: 'j-task' } });
      const sent: string[] = [];
      replayEventsSince(0, (msg) => sent.push(msg));
      expect(sent.length).toBeGreaterThanOrEqual(1);
      const first = JSON.parse(sent[0]!);
      expect(first).toHaveProperty('seq');
      expect(first).toHaveProperty('type');
      expect(first).toHaveProperty('payload');
    });
  });

  describe('new ServerEvent types type-check', () => {
    it('task:phase_complete event broadcasts without error', () => {
      expect(() =>
        broadcast({ type: 'task:phase_complete', payload: { taskId: 'x', phase: 'planning' } }),
      ).not.toThrow();
    });

    it('task:stuck event broadcasts without error', () => {
      expect(() =>
        broadcast({ type: 'task:stuck', payload: { taskId: 'x', reason: 'inactive' } }),
      ).not.toThrow();
    });
  });
});
