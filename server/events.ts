import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

export interface ServerEvent {
  type: 'task:updated' | 'task:created' | 'task:deleted';
  payload: { taskId: string };
}

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

export function broadcast(event: ServerEvent): void {
  const message = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
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
