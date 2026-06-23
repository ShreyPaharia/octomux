/**
 * src/lib/use-server-events.ts
 *
 * A tiny React primitive over the shared `/ws/events` WebSocket. Subscribes on
 * mount and unsubscribes on unmount, invoking `onEvent` for every event that
 * passes the optional `filter`. The callbacks are held in refs so the
 * subscription is established exactly once per mount and never torn down/rebuilt
 * when `onEvent` or `filter` change identity between renders.
 *
 * This wraps the `/ws/events` channel ONLY. The orchestrator socket
 * (`/ws/orchestrator/:id`) is incompatibly shaped and stays separate
 * (`openOrchestratorWs`).
 */

import { useEffect, useRef } from 'react';
import { subscribe, type ServerEvent } from './event-source';

export function useServerEvents(
  onEvent: ((event: ServerEvent) => void) | null | undefined,
  filter?: (event: ServerEvent) => boolean,
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  // `enabled` gates the subscription: when there is no handler there is nothing
  // to deliver to, so we avoid opening the shared socket at all.
  const enabled = onEvent != null;

  useEffect(() => {
    if (!enabled) return;
    return subscribe((event) => {
      if (filterRef.current && !filterRef.current(event)) return;
      onEventRef.current?.(event);
    });
  }, [enabled]);
}
