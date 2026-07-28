/**
 * src/lib/use-ticker.ts
 *
 * A shared 1-second ticker backed by a single setInterval. All components that
 * call `useTicker()` share the same interval, so N running BoardCards cost one
 * timer instead of N. Components that are inactive (isActive=false) do not
 * subscribe and therefore do not trigger re-renders.
 */
import { useEffect, useState } from 'react';

let tickerRefCount = 0;
let tickerInterval: ReturnType<typeof setInterval> | null = null;
const tickerSubscribers = new Set<(now: number) => void>();

function startTicker() {
  if (tickerInterval !== null) return;
  tickerInterval = setInterval(() => {
    const now = Date.now();
    for (const cb of tickerSubscribers) cb(now);
  }, 1_000);
}

function stopTicker() {
  if (tickerInterval === null) return;
  clearInterval(tickerInterval);
  tickerInterval = null;
}

/**
 * Returns the current timestamp (ms) updated every second.
 * When `active` is false, returns a stable `Date.now()` snapshot and does not
 * subscribe to the shared ticker — zero overhead for idle components.
 */
export function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;

    const cb = (t: number) => setNow(t);
    tickerSubscribers.add(cb);
    tickerRefCount += 1;
    startTicker();

    return () => {
      tickerSubscribers.delete(cb);
      tickerRefCount -= 1;
      if (tickerRefCount === 0) stopTicker();
    };
  }, [active]);

  return now;
}
