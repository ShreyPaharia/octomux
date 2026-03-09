import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn, type IPty } from 'node-pty';
import type { IncomingMessage } from 'http';
import { getDb } from './db.js';
import type { Task } from './types.js';

interface TerminalConnection {
  ws: WebSocket;
  pty: IPty;
}

const connections = new Map<string, TerminalConnection[]>();

export function setupTerminalWebSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    // Match /ws/terminal/:taskId/:windowIndex
    const match = req.url?.match(/^\/ws\/terminal\/([^/]+)\/(\d+)$/);
    if (!match) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const taskId = match[1];
      const windowIndex = parseInt(match[2], 10);
      handleConnection(ws, taskId, windowIndex);
    });
  });
}

function handleConnection(ws: WebSocket, taskId: string, windowIndex: number): void {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;

  if (!task || !task.tmux_session) {
    ws.close(4004, 'Task not found or no tmux session');
    return;
  }

  const target = `${task.tmux_session}:${windowIndex}`;

  let pty: IPty;
  try {
    pty = spawn('tmux', ['attach-session', '-t', target], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      env: process.env as Record<string, string>,
    });
  } catch {
    ws.close(4005, 'Failed to attach to tmux session');
    return;
  }

  const connKey = `${taskId}:${windowIndex}`;
  if (!connections.has(connKey)) {
    connections.set(connKey, []);
  }
  connections.get(connKey)!.push({ ws, pty });

  // PTY → WebSocket
  pty.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  // WebSocket → PTY
  ws.on('message', (data: Buffer | string) => {
    const msg = typeof data === 'string' ? data : data.toString();

    // Handle resize messages
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
        pty.resize(parsed.cols, parsed.rows);
        return;
      }
    } catch {
      // Not JSON, treat as terminal input
    }

    pty.write(msg);
  });

  // Cleanup on WebSocket close
  ws.on('close', () => {
    pty.kill();
    const conns = connections.get(connKey);
    if (conns) {
      const idx = conns.findIndex((c) => c.ws === ws);
      if (idx >= 0) conns.splice(idx, 1);
      if (conns.length === 0) connections.delete(connKey);
    }
  });

  // Cleanup on PTY exit
  pty.onExit(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(4006, 'Terminal process exited');
    }
  });
}

export function getActiveConnections(): Map<string, TerminalConnection[]> {
  return connections;
}
