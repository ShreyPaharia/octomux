import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPoller } from './base.js';

describe('createPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not schedule when interval is 0', () => {
    const tick = vi.fn();
    const poller = createPoller(tick, 0);
    poller.start();
    vi.advanceTimersByTime(60_000);
    expect(tick).not.toHaveBeenCalled();
    poller.stop();
  });

  it('invokes tick on interval and stops cleanly', async () => {
    const tick = vi.fn();
    const poller = createPoller(tick, 1000);
    poller.start();
    await vi.advanceTimersByTimeAsync(2500);
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2);
    poller.stop();
    const callsAfterStop = tick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick.mock.calls.length).toBe(callsAfterStop);
  });
});
