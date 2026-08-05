import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { WebSocketServer, WebSocket } from 'ws';
import { installHeartbeat } from './ws-heartbeat.js';

class FakeWs extends EventEmitter {
  ping = vi.fn();
  terminate = vi.fn();
}

class FakeWss extends EventEmitter {
  clients = new Set<FakeWs>();
  connect(): FakeWs {
    const ws = new FakeWs();
    this.clients.add(ws);
    this.emit('connection', ws);
    return ws;
  }
}

describe('installHeartbeat', () => {
  let wss: FakeWss;

  beforeEach(() => {
    vi.useFakeTimers();
    wss = new FakeWss();
    installHeartbeat(wss as unknown as WebSocketServer, 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pings connected clients on each interval', () => {
    const ws = wss.connect();
    vi.advanceTimersByTime(1000);
    expect(ws.ping).toHaveBeenCalledTimes(1);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('keeps clients that answer pings alive', () => {
    const ws = wss.connect();
    vi.advanceTimersByTime(1000);
    (ws as unknown as WebSocket).emit('pong');
    vi.advanceTimersByTime(1000);
    expect(ws.ping).toHaveBeenCalledTimes(2);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('terminates clients that miss a pong', () => {
    const ws = wss.connect();
    vi.advanceTimersByTime(1000); // ping sent, no pong comes back
    vi.advanceTimersByTime(1000); // missed pong detected
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(ws.ping).toHaveBeenCalledTimes(1);
  });

  it('stops pinging after the server closes', () => {
    const ws = wss.connect();
    wss.emit('close');
    vi.advanceTimersByTime(5000);
    expect(ws.ping).not.toHaveBeenCalled();
  });
});
