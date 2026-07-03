import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { Task } from '@octomux/types';
import { taskApi } from './api/taskApi';
import { subscribe as subscribeEvents } from './event-source';

/**
 * Lightweight external store for inbox data. Keeping it outside React's
 * context tree is deliberate: `SessionsInbox` is the only consumer, so an
 * isolated store means unrelated components (sidebar, task list) never
 * re-render when inbox state changes — even though they share the same
 * underlying WebSocket stream.
 */

export interface InboxState {
  needsYou: Task[];
  activity: Task[];
  loading: boolean;
  error: string | null;
}

type Listener = () => void;

let state: InboxState = {
  needsYou: [],
  activity: [],
  loading: true,
  error: null,
};

const listeners = new Set<Listener>();

function setState(next: Partial<InboxState>): void {
  state = { ...state, ...next };
  for (const cb of listeners) cb();
}

function getState(): InboxState {
  return state;
}

function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Reset for tests. */
export function _resetInboxStore(): void {
  state = { needsYou: [], activity: [], loading: true, error: null };
  listeners.clear();
  mountCount = 0;
  if (wsUnsub) {
    try {
      wsUnsub();
    } catch {
      // ignore
    }
    wsUnsub = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

/** Fetch inbox data from the server and update the shared store. */
export async function refreshInbox(): Promise<void> {
  try {
    const data = await taskApi.getInbox();
    setState({
      needsYou: data.needs_you,
      activity: data.activity,
      loading: false,
      error: null,
    });
  } catch (err) {
    setState({ loading: false, error: (err as Error).message });
  }
}

/** Mark all tasks as viewed and refresh. */
export async function markAllInboxRead(): Promise<void> {
  await taskApi.markAllTasksViewed();
  await refreshInbox();
}

// ─── WebSocket wiring (module-scoped, shared across all hook instances) ─────

const DEBOUNCE_MS = 250;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let wsUnsub: (() => void) | null = null;
let mountCount = 0;

function scheduleRefresh(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void refreshInbox();
  }, DEBOUNCE_MS);
}

function attachWs(): void {
  if (wsUnsub) return;
  wsUnsub = subscribeEvents((event) => {
    if (event.type.startsWith('task:')) scheduleRefresh();
  });
}

function detachWs(): void {
  if (!wsUnsub) return;
  wsUnsub();
  wsUnsub = null;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

/** Flush pending debounced refresh (for tests). */
export function _flushInboxDebounce(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    void refreshInbox();
  }
}

export interface UseInboxResult {
  needsYou: Task[];
  activity: Task[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  markAllRead: () => Promise<void>;
}

export function useInbox(): UseInboxResult {
  const snapshot = useSyncExternalStore(subscribe, getState, getState);

  useEffect(() => {
    mountCount++;
    if (mountCount === 1) {
      attachWs();
      void refreshInbox();
    }
    return () => {
      mountCount--;
      if (mountCount === 0) detachWs();
    };
  }, []);

  const refresh = useCallback(() => refreshInbox(), []);
  const markAllRead = useCallback(() => markAllInboxRead(), []);

  return {
    needsYou: snapshot.needsYou,
    activity: snapshot.activity,
    loading: snapshot.loading,
    error: snapshot.error,
    refresh,
    markAllRead,
  };
}
