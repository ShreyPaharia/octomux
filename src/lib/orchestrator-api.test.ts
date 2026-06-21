/**
 * src/lib/orchestrator-api.test.ts
 *
 * Tests for the resilient orchestrator WebSocket client (SHR-162):
 *  - status transitions: connecting → open
 *  - unexpected drop → reconnecting → reconnect attempt → open + onReconnect
 *  - exponential backoff between attempts
 *  - send() returns false when not open, true when open
 *  - close() stops reconnection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  openOrchestratorWs,
  WS_RECONNECT_DELAYS_MS,
  type WsConnectionState,
} from './orchestrator-api';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }
  // ── test helpers ──
  simulateOpen() {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }
  simulateDrop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe('openOrchestratorWs (SHR-162)', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function lastWs() {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  it('transitions connecting → open', () => {
    const states: WsConnectionState[] = [];
    openOrchestratorWs('conv-1', { onMessage: () => {}, onStatusChange: (s) => states.push(s) });

    expect(states).toContain('connecting');
    lastWs().simulateOpen();
    expect(states[states.length - 1]).toBe('open');
  });

  it('send returns false before open, true once open', () => {
    const handle = openOrchestratorWs('conv-1', { onMessage: () => {} });
    expect(handle.send({ type: 'user_turn', text: 'hi' })).toBe(false);
    lastWs().simulateOpen();
    expect(handle.send({ type: 'user_turn', text: 'hi' })).toBe(true);
    expect(lastWs().sent).toHaveLength(1);
  });

  it('reconnects after an unexpected drop and fires onReconnect', () => {
    const states: WsConnectionState[] = [];
    const onReconnect = vi.fn();
    openOrchestratorWs('conv-1', {
      onMessage: () => {},
      onStatusChange: (s) => states.push(s),
      onReconnect,
    });

    lastWs().simulateOpen();
    expect(MockWebSocket.instances).toHaveLength(1);

    // Unexpected drop → reconnecting, then a new socket after the first backoff.
    lastWs().simulateDrop();
    expect(states[states.length - 1]).toBe('reconnecting');
    expect(onReconnect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(WS_RECONNECT_DELAYS_MS[0]);
    expect(MockWebSocket.instances).toHaveLength(2); // reconnect attempt made

    // The reconnected socket opening fires onReconnect (history replay hook).
    lastWs().simulateOpen();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(states[states.length - 1]).toBe('open');
  });

  it('uses escalating backoff across repeated failures', () => {
    openOrchestratorWs('conv-1', { onMessage: () => {} });
    lastWs().simulateOpen();

    // First drop → reconnect after delays[0]
    lastWs().simulateDrop();
    vi.advanceTimersByTime(WS_RECONNECT_DELAYS_MS[0] - 1);
    expect(MockWebSocket.instances).toHaveLength(1); // not yet
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Second consecutive drop (never reopened) → longer delay (delays[1])
    lastWs().simulateDrop();
    vi.advanceTimersByTime(WS_RECONNECT_DELAYS_MS[1] - 1);
    expect(MockWebSocket.instances).toHaveLength(2); // still waiting the longer backoff
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('close() stops reconnection and reports closed', () => {
    const states: WsConnectionState[] = [];
    const handle = openOrchestratorWs('conv-1', {
      onMessage: () => {},
      onStatusChange: (s) => states.push(s),
    });
    lastWs().simulateOpen();

    handle.close();
    expect(states[states.length - 1]).toBe('closed');

    // No reconnection should be scheduled after a user close.
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('delivers parsed messages and ignores malformed frames', () => {
    const received: unknown[] = [];
    openOrchestratorWs('conv-1', { onMessage: (e) => received.push(e) });
    const ws = lastWs();
    ws.simulateOpen();

    ws.onmessage?.({ data: JSON.stringify({ type: 'message', role: 'assistant', text: 'hi' }) });
    ws.onmessage?.({ data: 'not json{' });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'message', text: 'hi' });
  });
});
