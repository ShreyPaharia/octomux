export interface PollerHandle {
  start(): void;
  stop(): void;
}

/**
 * Owns the interval/timer lifecycle for a single poll loop.
 * Skips scheduling when intervalMs is 0 (test env).
 */
export function createPoller(tick: () => void | Promise<void>, intervalMs: number): PollerHandle {
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    start() {
      if (intervalMs > 0) {
        timer = setInterval(() => void tick(), intervalMs);
      }
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
