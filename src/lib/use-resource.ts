/**
 * src/lib/use-resource.ts
 *
 * A ~per-mount data-fetching primitive: `useState` + key-driven fetch + optional
 * WS-refresh, with the content-dedup (`lastJsonRef`) that the hand-rolled hooks
 * used to carry individually. Folds the three inconsistent fetch patterns into
 * one shape:
 *
 *   const { data, loading, error, refresh } = useResource(key, fetcher, { events });
 *
 * - `key` identifies the resource. Changing it triggers a refetch; passing
 *   `null` disables fetching entirely (e.g. an id that isn't ready yet).
 * - `fetcher` is called to load the data. Its latest identity is always used, so
 *   inline closures are fine — only `key` drives refetches.
 * - `opts.events` is an optional predicate over `/ws/events` events; when it
 *   returns true the resource refetches. Omit it for resources with no live
 *   updates (the socket is then never opened for this hook).
 *
 * There is intentionally NO cross-component cache: each mount owns its own state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useServerEvents } from './use-server-events';
import type { ServerEvent } from './event-source';
import { throttle } from './throttle';

// Agents broadcast task:updated per tool call, so event bursts are common.
// Throttle event-driven refetches (leading edge immediate) so a burst costs
// one refetch + one trailing catch-up instead of one refetch per event.
export const REFETCH_THROTTLE_MS = 500;

export interface UseResourceResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useResource<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  opts?: { events?: (event: ServerEvent) => boolean },
): UseResourceResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(key !== null);
  const [error, setError] = useState<string | null>(null);

  // Latest fetcher identity, so inline closures don't churn the effect.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Content-dedup: skip the state update (and the re-render it would cause) when
  // the freshly-fetched payload is byte-identical to what we already hold.
  const lastJsonRef = useRef<string>('');

  const refresh = useCallback(async () => {
    if (key === null) return;
    try {
      const result = await fetcherRef.current();
      const json = JSON.stringify(result);
      if (json !== lastJsonRef.current) {
        lastJsonRef.current = json;
        setData(result);
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    if (key === null) {
      setLoading(false);
      return;
    }
    // Reset the dedup baseline so switching resources always commits the first
    // payload, even if it happens to stringify identically to the previous one.
    lastJsonRef.current = '';
    setLoading(true);
    refresh();
  }, [key, refresh]);

  const throttledRefresh = useMemo(
    () => throttle(() => void refresh(), REFETCH_THROTTLE_MS),
    [refresh],
  );
  useEffect(() => () => throttledRefresh.cancel(), [throttledRefresh]);
  useServerEvents(key !== null && opts?.events ? throttledRefresh : null, opts?.events);

  return { data, loading, error, refresh };
}
