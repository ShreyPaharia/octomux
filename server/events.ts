import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { appendEvent, eventsSince } from './orchestrator/store.js';

export type ServerEvent =
  | { type: 'task:updated' | 'task:created' | 'task:deleted'; payload: { taskId: string } }
  | { type: 'chat:updated' | 'chat:deleted'; payload: { chatId: string } }
  | {
      type: 'review:drafts-ready' | 'review:run-failed';
      payload: { taskId: string; reviewRunId: string };
    }
  | {
      type: 'review:published';
      payload: { taskId: string; github_review_url: string | null };
    }
  | {
      type: 'review:head-advanced';
      payload: { taskId: string; newHeadSha: string };
    }
  | {
      type: 'task:phase_complete';
      payload: { taskId: string; phase: string; [key: string]: unknown };
    }
  | {
      type: 'task:stuck';
      payload: { taskId: string; reason?: string; [key: string]: unknown };
    };

/** Event types that carry a taskId and should be persisted to the durable events log. */
const TASK_EVENT_TYPES = new Set([
  'task:updated',
  'task:created',
  'task:deleted',
  'task:phase_complete',
  'task:stuck',
]);

const clients = new Set<WebSocket>();
let wss: WebSocketServer;

export function setupEventWebSocket(): void {
  wss = new WebSocketServer({ noServer: true });
}

export function handleEventUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  if (req.url !== '/ws/events') return false;

  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
  return true;
}

/**
 * Persist the event to the durable `events` log (if it carries a taskId),
 * then emit to all connected WebSocket clients.
 *
 * The `seq` assigned by the DB is included in the emitted message so
 * subscribers can track their replay cursor.
 */
export function broadcast(event: ServerEvent): void {
  let seq: number | undefined;

  // Persist-then-emit for task events that have a taskId in their payload.
  if (TASK_EVENT_TYPES.has(event.type) && 'taskId' in event.payload) {
    const taskId = (event.payload as { taskId: string }).taskId;
    seq = appendEvent({
      task_id: taskId,
      type: event.type,
      payload: JSON.stringify(event.payload),
    });
  }

  // Emit to live clients (attach seq when available so clients track the cursor).
  const message = seq !== undefined ? JSON.stringify({ ...event, seq }) : JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

/**
 * Replay all persisted events with seq > sinceSeq by calling `send` for each.
 * Used by supervisors on (re)connect to catch up on missed events.
 * Each call to `send` receives a JSON string with `seq`, `type`, and `payload`.
 */
export function replayEventsSince(sinceSeq: number, send: (msg: string) => void): void {
  const events = eventsSince(sinceSeq);
  for (const ev of events) {
    const payload = (() => {
      try {
        return JSON.parse(ev.payload);
      } catch {
        return ev.payload;
      }
    })();
    send(JSON.stringify({ seq: ev.seq, type: ev.type, payload, task_id: ev.task_id }));
  }
}

export function getEventClientCount(): number {
  return clients.size;
}

export function cleanupEventClients(): void {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1001, 'Server shutting down');
    }
  }
  clients.clear();
}
