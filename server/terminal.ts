import { WebSocketServer, WebSocket } from 'ws';
import { createDeflateRaw, constants as zlibConstants, deflateRawSync } from 'zlib';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { nanoid } from 'nanoid';
import { getTask, getChatAgentTmuxSession } from './repositories/index.js';
import { tmuxSpawnSpec } from './tmux-bin.js';
import { shellQuoteSingle } from './shell-quote.js';
import { sessionFor, localSession } from './compute/index.js';
import type { ComputeSession } from './compute/types.js';
import type { ProcessHandle } from './agent-session/substrate.js';
import { installHeartbeat } from './ws-heartbeat.js';

interface TerminalConnection {
  ws: WebSocket;
  pty: ProcessHandle;
}

const connections = new Map<string, TerminalConnection[]>();
let wss: WebSocketServer;

export function setupTerminalWebSocket(): void {
  // No perMessageDeflate here: Bun's ws shim accepts the option but never
  // negotiates the extension (explicit TODO in the shim), so it was a silent
  // no-op. Compression is app-level instead — see makeFrameSender().
  wss = new WebSocketServer({ noServer: true });
  installHeartbeat(wss);
}

// App-layer replacement for permessage-deflate (a silent no-op under Bun's ws
// shim). Two negotiated modes, picked by the client's `?deflate=` param:
//
//   2 — one deflate context per connection with context takeover. Consecutive
//       TUI repaints are near-identical, so each frame deflates against the
//       previous one: measured ~62x on a repaint vs ~2.8x compressing the same
//       frame standalone. Every output frame rides the stream as binary; the
//       client feeds them into a single DecompressionStream in arrival order.
//   1 — legacy per-message mode kept for tabs still running the previous
//       bundle: frames >= 1KB are deflated standalone, smaller stay text.
//
// The empty pong reply bypasses compression in both modes — any traffic
// proves the link, and an empty text frame is a no-op for xterm.
const DEFLATE_THRESHOLD = 1024;

interface FrameSender {
  send(text: string): void;
  close(): void;
}

function makeFrameSender(ws: WebSocket, mode: number): FrameSender {
  if (mode !== 2) {
    return {
      send(text) {
        if (mode === 1 && text.length >= DEFLATE_THRESHOLD) {
          ws.send(deflateRawSync(Buffer.from(text)));
        } else {
          ws.send(text);
        }
      },
      close() {},
    };
  }

  const deflate = createDeflateRaw();
  let chunks: Buffer[] = [];
  deflate.on('data', (c: Buffer) => chunks.push(c));
  // write+flush is async; the chain keeps frames FIFO so the client's inflate
  // stream always sees bytes in generation order.
  let chain = Promise.resolve();
  let closed = false;
  return {
    send(text) {
      chain = chain.then(
        () =>
          new Promise<void>((resolve) => {
            if (closed) return resolve();
            deflate.write(Buffer.from(text));
            deflate.flush(zlibConstants.Z_SYNC_FLUSH, () => {
              if (!closed && ws.readyState === WebSocket.OPEN && chunks.length > 0) {
                ws.send(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
              }
              chunks = [];
              resolve();
            });
          }),
      );
    },
    close() {
      closed = true;
      deflate.close();
    },
  };
}

export function handleTerminalUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const [path = '', query = ''] = (req.url ?? '').split('?');
  const deflateParam = new URLSearchParams(query).get('deflate');
  const deflateMode = deflateParam === '2' ? 2 : deflateParam === '1' ? 1 : 0;

  // Match /ws/terminal/chat/:id (standalone agent tmux session)
  const chatMatch = path.match(/^\/ws\/terminal\/chat\/([^/]+)$/);
  if (chatMatch) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleChatConnection(ws, chatMatch[1], deflateMode);
    });
    return true;
  }

  // Match /ws/terminal/:taskId/:windowIndex
  const match = path.match(/^\/ws\/terminal\/([^/]+)\/(\d+)$/);
  if (!match) return false;

  wss.handleUpgrade(req, socket, head, (ws) => {
    const taskId = match[1];
    const windowIndex = parseInt(match[2], 10);
    handleConnection(ws, taskId, windowIndex, deflateMode);
  });
  return true;
}

async function attachToTmuxSession(
  ws: WebSocket,
  compute: ComputeSession,
  tmuxTarget: string,
  connKey: string,
  closeReason: string,
  sender: FrameSender,
  linkedSession?: string,
  pendingMessages?: (Buffer | string)[],
): Promise<void> {
  // The provider owns tmux binary + socket resolution in general, but the
  // interactive pty attach only has a shell-command spawn surface
  // (`compute.spawn`), not an argv one — so build the attach argv the same
  // way `compute.tmux` would resolve it locally and quote it into a command
  // string. For `local` this ends up running the exact same tmux binary,
  // socket, and env that `tmuxSpawnSpec` produced before this migration.
  const spec = tmuxSpawnSpec(['attach-session', '-t', tmuxTarget]);
  const command = [spec.file, ...spec.args].map(shellQuoteSingle).join(' ');

  let pty: ProcessHandle;
  try {
    pty = await compute.spawn({
      command,
      cwd: compute.repoPath,
      env: spec.env as Record<string, string>,
      cols: 120,
      rows: 30,
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

  // PTY → WebSocket (microtask batching + backpressure coalescing)
  // Collect chunks arriving in the same event loop tick and send as one frame.
  // While the socket is congested (slow remote link), keep merging chunks
  // instead of queueing frames: consecutive TUI repaints are near-identical,
  // so the merged frame deflates to almost nothing and the client jumps to
  // the latest state instead of replaying stale repaints one by one.
  // ponytail: pendingOutput is unbounded during a long stall; add a cap +
  // capture-pane resync if it ever matters.
  const BACKPRESSURE_LIMIT = 64 * 1024;
  const BACKPRESSURE_RETRY_MS = 16;
  let pendingOutput = '';
  let outputScheduled = false;
  let retryTimer: NodeJS.Timeout | null = null;
  // Hidden viewers (inactive tabs in the terminal LRU) send {type:'pause'} —
  // output is discarded rather than streamed to a terminal nobody can see.
  // On resume, refresh-client forces a full repaint so the screen is current.
  // Discarding (vs pty.pause()) means a stalled viewer can never backpressure
  // tmux and stall the agent's pane.
  let paused = false;
  // Client xterm flow control ({type:'flow'}): the viewer's write buffer is
  // past its high watermark, so stop forwarding until it drains. Same
  // discard-and-repaint choice as the visibility pause above, and deliberately
  // NOT buffering: buffering would replay the very flood that overwhelmed the
  // client (and pendingOutput is unbounded) — the repaint on resume jumps the
  // viewer straight to the current screen instead. Independent of `paused` so
  // a flow resume can't unhide a hidden tab's stream (and vice versa).
  let flowPaused = false;

  const forceRepaint = () => {
    compute
      .tmux(['list-clients', '-t', tmuxTarget, '-F', '#{client_name}'])
      .then(({ stdout }) => {
        const client = stdout.trim().split('\n')[0];
        if (client) return compute.tmux(['refresh-client', '-t', client]);
      })
      .catch(() => {});
  };

  const flushOutput = () => {
    retryTimer = null;
    if (ws.readyState !== WebSocket.OPEN || !pendingOutput) {
      pendingOutput = '';
      outputScheduled = false;
      return;
    }
    if (ws.bufferedAmount > BACKPRESSURE_LIMIT) {
      retryTimer = setTimeout(flushOutput, BACKPRESSURE_RETRY_MS);
      return;
    }
    sender.send(pendingOutput);
    pendingOutput = '';
    outputScheduled = false;
  };

  pty.onData((data: string) => {
    if (paused || flowPaused || ws.readyState !== WebSocket.OPEN) return;
    pendingOutput += data;
    if (!outputScheduled) {
      outputScheduled = true;
      queueMicrotask(flushOutput);
    }
  });

  const handleMessage = (data: Buffer | string) => {
    if (ptyExited) return;
    const msg = typeof data === 'string' ? data : data.toString();

    // Only attempt JSON parse for messages that look like JSON objects (resize messages).
    // Raw terminal input (keystrokes) never starts with '{', so skip the expensive try/catch.
    if (msg.charCodeAt(0) === 123) {
      // 123 = '{'
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
          pty.resize?.(parsed.cols, parsed.rows);
          return;
        }
        if (parsed.type === 'pause') {
          paused = true;
          pendingOutput = '';
          return;
        }
        if (parsed.type === 'resume') {
          if (paused) {
            paused = false;
            if (!flowPaused) forceRepaint();
          }
          return;
        }
        if (parsed.type === 'flow') {
          if (parsed.state === 'pause' && !flowPaused) {
            flowPaused = true;
            pendingOutput = '';
          } else if (parsed.state === 'resume' && flowPaused) {
            flowPaused = false;
            if (!paused) forceRepaint();
          }
          return;
        }
        if (parsed.type === 'ping') {
          // Client liveness watchdog probing for a half-open socket. Reply
          // with an empty frame — any traffic proves the link, and xterm
          // treats an empty write as a no-op so the client needn't filter it.
          ws.send('');
          return;
        }
      } catch {
        // Not valid JSON, fall through to write as terminal input
      }
    }

    try {
      pty.write(msg);
    } catch {
      // PTY already exited
    }
  };

  // Replace any buffering handler with the real one
  ws.removeAllListeners('message');
  ws.on('message', handleMessage);

  // Replay any messages that arrived before the PTY was ready
  if (pendingMessages) {
    for (const msg of pendingMessages) {
      handleMessage(msg);
    }
  }

  const cleanupLinkedSession = () => {
    if (linkedSession) {
      compute.tmux(['kill-session', '-t', linkedSession]).catch(() => {});
    }
  };

  // Cleanup on WebSocket close
  ws.on('close', () => {
    if (retryTimer) clearTimeout(retryTimer);
    if (!ptyExited) {
      pty.dispose();
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

async function handleConnection(
  ws: WebSocket,
  taskId: string,
  windowIndex: number,
  deflateMode: number,
): Promise<void> {
  // Buffer messages that arrive while we set up the tmux session.
  // Without this, the client's initial resize message (sent on WS open) would be
  // lost because the message handler isn't registered until after the async tmux
  // setup completes — Node.js EventEmitter discards events with no listeners.
  const pendingMessages: (Buffer | string)[] = [];
  ws.on('message', (data: Buffer | string) => {
    pendingMessages.push(data);
  });

  const task = getTask(taskId);

  if (!task || !task.tmux_session) {
    ws.close(4004, 'Task not found or no tmux session');
    return;
  }

  const compute = await sessionFor(task);

  // Created before the snapshot so the first frame already rides the deflate
  // context; closed on socket close (mode 2 holds a zlib stream).
  const sender = makeFrameSender(ws, deflateMode);
  ws.on('close', () => sender.close());

  // Create a grouped session so each viewer has independent window selection.
  // Without this, all clients attached to the same session share the active window,
  // meaning switching tabs in one browser would affect all other viewers.
  //
  // `;` separates commands within a single tmux argv, so session creation and
  // window selection cost one process spawn instead of two sequential
  // round-trips (~10ms each) on the path to first paint.
  const linkedSession = `${task.tmux_session}-v-${nanoid(6)}`;
  // `tmux attach` takes 100-300ms to emit its first frame — a blank terminal for
  // the whole switch. Snapshot the pane concurrently with the setup above and
  // paint it into the alternate screen first; tmux's attach opens with
  // `\e[?1049h\e[H\e[J` + a full repaint of the same content, so the handoff is
  // a same-frame overwrite rather than a flash of empty screen.
  const snapshot = compute
    .tmux(['capture-pane', '-p', '-e', '-t', `${task.tmux_session}:${windowIndex}`])
    .then(
      ({ stdout }) => stdout,
      () => null,
    );

  let pane: string | null;
  try {
    [, pane] = await Promise.all([
      compute.tmux([
        'new-session',
        '-d',
        '-t',
        task.tmux_session,
        '-s',
        linkedSession,
        ';',
        'select-window',
        '-t',
        `${linkedSession}:${windowIndex}`,
      ]),
      snapshot,
    ]);
  } catch {
    ws.close(4005, 'Failed to create terminal view session');
    return;
  }

  // Best-effort and deliberately off the critical path: without it a grouped
  // session clamps window size to the smallest client. Kept out of the chain
  // above because `aggressive-resize` is a window option and a tmux build that
  // rejects it on a session target would abort the commands that do matter.
  compute.tmux(['set-option', '-t', linkedSession, 'aggressive-resize', 'on']).catch(() => {});

  if (pane && ws.readyState === WebSocket.OPEN) {
    sender.send(`\x1b[?1049h\x1b[H\x1b[J${pane.replace(/\n/g, '\r\n')}`);
  }

  const connKey = `${taskId}:${windowIndex}`;
  attachToTmuxSession(
    ws,
    compute,
    linkedSession,
    connKey,
    'Failed to attach to tmux session',
    sender,
    linkedSession,
    pendingMessages,
  );
}

function handleChatConnection(ws: WebSocket, chatId: string, deflateMode: number): void {
  const row = getChatAgentTmuxSession(chatId);
  if (!row || !row.tmux_session) {
    ws.close(4004, 'Chat not found');
    return;
  }
  const sender = makeFrameSender(ws, deflateMode);
  ws.on('close', () => sender.close());
  // Chats have no Task by design (they're not task-backed sessions), so this
  // always stays on the local machine's own compute — never `sessionFor`.
  attachToTmuxSession(
    ws,
    localSession,
    row.tmux_session,
    `chat:${chatId}`,
    `Failed to attach to chat session`,
    sender,
  );
}

export function getActiveConnections(): Map<string, TerminalConnection[]> {
  return connections;
}

export function cleanupAllConnections(): void {
  for (const [, conns] of connections) {
    for (const { ws, pty } of conns) {
      try {
        pty.dispose();
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
