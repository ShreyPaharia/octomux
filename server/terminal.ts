import type { Server } from 'http';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn, type IPty } from 'node-pty';
import type { IncomingMessage } from 'http';
import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import type { Task } from './types.js';
import { getOrchestratorSession } from './orchestrator.js';

const execFile = promisify(execFileCb);

interface TerminalConnection {
  ws: WebSocket;
  pty: IPty;
}

const connections = new Map<string, TerminalConnection[]>();

export function setupTerminalWebSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    // Match /ws/terminal/orchestrator
    const orchMatch = req.url?.match(/^\/ws\/terminal\/orchestrator$/);
    if (orchMatch) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleOrchestratorConnection(ws);
      });
      return;
    }

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

function attachToTmuxSession(
  ws: WebSocket,
  tmuxTarget: string,
  connKey: string,
  closeReason: string,
  linkedSession?: string,
): void {
  let pty: IPty;
  try {
    pty = spawn('tmux', ['attach-session', '-t', tmuxTarget], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      env: process.env as Record<string, string>,
    });
  } catch {
    ws.close(4005, closeReason);
    return;
  }

  let ptyExited = false;

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
    if (ptyExited) return;
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

    try {
      pty.write(msg);
    } catch {
      // PTY already exited
    }
  });

  const cleanupLinkedSession = () => {
    if (linkedSession) {
      execFile('tmux', ['kill-session', '-t', linkedSession]).catch(() => {});
    }
  };

  // Cleanup on WebSocket close
  ws.on('close', () => {
    if (!ptyExited) {
      pty.kill();
    }
    cleanupLinkedSession();
    const conns = connections.get(connKey);
    if (conns) {
      const idx = conns.findIndex((c) => c.ws === ws);
      if (idx >= 0) conns.splice(idx, 1);
      if (conns.length === 0) connections.delete(connKey);
    }
  });

  // Cleanup on PTY exit
  pty.onExit(() => {
    ptyExited = true;
    cleanupLinkedSession();
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(4006, 'Terminal process exited');
    }
  });
}

async function handleConnection(ws: WebSocket, taskId: string, windowIndex: number): Promise<void> {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;

  if (!task || !task.tmux_session) {
    ws.close(4004, 'Task not found or no tmux session');
    return;
  }

  // Create a grouped session so each viewer has independent window selection.
  // Without this, all clients attached to the same session share the active window,
  // meaning switching tabs in one browser would affect all other viewers.
  const linkedSession = `${task.tmux_session}-v-${nanoid(6)}`;
  try {
    await execFile('tmux', ['new-session', '-d', '-t', task.tmux_session, '-s', linkedSession]);
    await execFile('tmux', ['select-window', '-t', `${linkedSession}:${windowIndex}`]);
  } catch {
    ws.close(4005, 'Failed to create terminal view session');
    return;
  }

  const connKey = `${taskId}:${windowIndex}`;
  attachToTmuxSession(
    ws,
    linkedSession,
    connKey,
    'Failed to attach to tmux session',
    linkedSession,
  );
}

function handleOrchestratorConnection(ws: WebSocket): void {
  const session = getOrchestratorSession();
  attachToTmuxSession(ws, session, 'orchestrator', 'Failed to attach to orchestrator session');
}

export function getActiveConnections(): Map<string, TerminalConnection[]> {
  return connections;
}

export function cleanupAllConnections(): void {
  for (const [, conns] of connections) {
    for (const { ws, pty } of conns) {
      try {
        pty.kill();
      } catch {
        // already dead
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1001, 'Server shutting down');
      }
    }
  }
  connections.clear();
}
