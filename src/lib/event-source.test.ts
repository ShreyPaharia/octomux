import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { subscribe } from './event-source';

// ─── Mock WebSocket ─────────────────────────────────────────────────────────

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    // Simulate async open
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  close(code = 1000) {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.onclose?.({ code });
  }

  send(_data: string) {}

  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }

  simulateClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  static instances: MockWebSocket[] = [];
  static reset() {
    MockWebSocket.instances = [];
  }
}

beforeEach(() => {
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('event-source', () => {
  it('connects on first subscriber', async () => {
    const cb = vi.fn();
    const unsub = subscribe(cb);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain('/ws/events');

    unsub();
  });

  it('calls subscriber with parsed event on message', async () => {
    const cb = vi.fn();
    const unsub = subscribe(cb);

    await vi.waitFor(() => expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.OPEN));

    MockWebSocket.instances[0].simulateMessage('{"type":"task:updated","payload":{"taskId":"t1"}}');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ type: 'task:updated', payload: { taskId: 't1' } });

    unsub();
  });

  it('disconnects when last subscriber unsubscribes', async () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const unsub1 = subscribe(cb1);
    const unsub2 = subscribe(cb2);

    // Should reuse the same connection
    expect(MockWebSocket.instances).toHaveLength(1);

    unsub1();
    expect(MockWebSocket.instances[0].closed).toBe(false);

    unsub2();
    expect(MockWebSocket.instances[0].closed).toBe(true);
  });

  it('reconnects on unexpected close', async () => {
    vi.useFakeTimers();
    const cb = vi.fn();
    const unsub = subscribe(cb);

    await vi.advanceTimersByTimeAsync(0); // let onopen fire
    expect(MockWebSocket.instances).toHaveLength(1);

    // Simulate unexpected disconnect
    MockWebSocket.instances[0].simulateClose(1006);

    // After reconnect delay
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    unsub();
    vi.useRealTimers();
  });
});
