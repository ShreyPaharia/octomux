import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { throttle } from './throttle';

describe('throttle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs the first call immediately and collapses a burst into one trailing run', () => {
    const fn = vi.fn();
    const t = throttle(fn, 500);

    t();
    expect(fn).toHaveBeenCalledTimes(1); // leading edge

    t();
    t();
    t();
    expect(fn).toHaveBeenCalledTimes(1); // burst held

    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(2); // one trailing run for the whole burst

    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2); // nothing pending → no further runs
  });

  it('runs immediately again after the cooldown', () => {
    const fn = vi.fn();
    const t = throttle(fn, 500);

    t();
    vi.advanceTimersByTime(500);
    t();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cancel drops the pending trailing run', () => {
    const fn = vi.fn();
    const t = throttle(fn, 500);

    t();
    t();
    t.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
