/**
 * Shared WebSocket connection to /ws/events for real-time server events.
 * Lazily connects on first subscriber, disconnects when all unsubscribe.
 * Reconnects with exponential backoff on unexpected disconnects.
 */

const MAX_RECONNECT_DELAY = 10_000;
const INITIAL_RECONNECT_DELAY = 1_000;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = INITIAL_RECONNECT_DELAY;
const subscribers = new Set<() => void>();

function getWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/events`;
}

function connect(): void {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {
    reconnectDelay = INITIAL_RECONNECT_DELAY;
  };

  ws.onmessage = () => {
    for (const cb of subscribers) cb();
  };

  ws.onclose = (event) => {
    ws = null;
    if (event.code !== 1000 && subscribers.size > 0) {
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        connect();
      }, reconnectDelay);
    }
  };

  ws.onerror = () => {
    // onclose handles reconnection
  };
}

export function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  connect();
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close(1000);
      ws = null;
      reconnectDelay = INITIAL_RECONNECT_DELAY;
    }
  };
}
