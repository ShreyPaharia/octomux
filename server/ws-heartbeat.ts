import type { WebSocketServer, WebSocket } from 'ws';

export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Ping every connected client on an interval and terminate ones that miss a pong.
 *
 * An idle terminal/event socket carries zero traffic, so NAT gateways and tunnel
 * proxies silently drop the connection after a few minutes of silence. The browser
 * never learns (its half-open socket still reports OPEN), so reconnect logic never
 * fires and the user has to refresh. The ping traffic keeps intermediary connection
 * state alive; the missed-pong terminate reaps server-side resources (viewer ptys)
 * for peers that vanished without a FIN. Browsers answer protocol-level pings
 * automatically — no client code involved.
 */
export function installHeartbeat(
  wss: WebSocketServer,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): void {
  const alive = new WeakSet<WebSocket>();
  wss.on('connection', (ws) => {
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, intervalMs);
  timer.unref();
  wss.on('close', () => clearInterval(timer));
}
