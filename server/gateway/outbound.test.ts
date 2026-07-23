import { describe, it, expect, vi } from 'vitest';
import { OutboundQueue } from './outbound.js';

describe('OutboundQueue', () => {
  it('serializes sends within a thread in FIFO order', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const send = vi.fn(async (_t: string, text: string) => {
      if (text === 'a') await firstGate; // block 'a' until released
      order.push(text);
    });

    const q = new OutboundQueue(send);
    q.enqueue('t1', 'a');
    q.enqueue('t1', 'b');

    // 'b' must wait for 'a' even though 'a' is blocked.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);

    releaseFirst();
    await q.drain();
    expect(order).toEqual(['a', 'b']);
  });

  it('retries a failing send and eventually delivers', async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw new Error('transient network');
    });
    const q = new OutboundQueue(send, { maxRetries: 3 });
    q.enqueue('t1', 'x');
    await q.drain();
    expect(calls).toBe(2);
  });

  it('gives up (does not throw) after exhausting retries', async () => {
    const send = vi.fn(async () => {
      throw new Error('down');
    });
    const q = new OutboundQueue(send, { maxRetries: 2 });
    q.enqueue('t1', 'x');
    await expect(q.drain()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('dedupes the same message within the TTL window, allows it again after', async () => {
    const send = vi.fn(async () => undefined);
    let t = 1000;
    const q = new OutboundQueue(send, { dedupTtlMs: 100, now: () => t });

    q.enqueue('t1', 'same');
    q.enqueue('t1', 'same'); // within window → suppressed
    await q.drain();
    expect(send).toHaveBeenCalledTimes(1);

    t = 2000; // past the window
    q.enqueue('t1', 'same');
    await q.drain();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
