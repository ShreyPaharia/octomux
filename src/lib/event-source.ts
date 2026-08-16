/**
 * Shared WebSocket connection to /ws/events for real-time server events.
 * Lazily connects on first subscriber, disconnects when all unsubscribe.
 * Reconnects with exponential backoff on unexpected disconnects.
 */

import type { ReceivedServerEvent, ServerEventType } from '@octomux/types';

const MAX_RECONNECT_DELAY = 10_000;
const INITIAL_RECONNECT_DELAY = 1_000;

/**
 * The consumer-side event shape lives in `@octomux/types` alongside the
 * server's producer union, so any surface (dashboard, CLI, a future TUI) types
 * this stream from one definition. Re-exported as `ServerEvent` because that's
 * what every consumer in this app already imports.
 */
export type ServerEvent = ReceivedServerEvent;
export type { ServerEventType };

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = INITIAL_RECONNECT_DELAY;
let connectedState = true;
const subscribers = new Set<(event: ServerEvent) => void>();
const stateSubscribers = new Set<(connected: boolean) => void>();

function setConnected(v: boolean) {
  if (connectedState === v) return;
  connectedState = v;
  for (const cb of stateSubscribers) cb(v);
}

export function subscribeConnectionState(cb: (connected: boolean) => void): () => void {
  stateSubscribers.add(cb);
  cb(connectedState);
  return () => {
    stateSubscribers.delete(cb);
  };
}

function getWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/events`;
}

function connect(): void {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {
    reconnectDelay = INITIAL_RECONNECT_DELAY;
    setConnected(true);
  };

  ws.onmessage = (event) => {
    let parsed: ServerEvent;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return; // Ignore malformed messages
    }
    for (const cb of subscribers) cb(parsed);
  };

  ws.onclose = (event) => {
    ws = null;
    if (event.code !== 1000 && subscribers.size > 0) {
      setConnected(false);
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

export function subscribe(callback: (event: ServerEvent) => void): () => void {
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
