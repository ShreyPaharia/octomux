import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { createTestDb, insertTask, insertAgent, DEFAULTS } from './test-helpers.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPty = {
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
};

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockPty),
}));

const { setupTerminalWebSocket } = await import('./terminal.js');
const nodePty = await import('node-pty');

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: Database.Database;
let server: Server;
let port: number;

function wsUrl(path: string): string {
  return `ws://localhost:${port}${path}`;
}

function connectWs(path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(path));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

beforeEach(async () => {
  db = createTestDb();
  vi.clearAllMocks();

  // Reset mock callbacks
  mockPty.onData.mockReset();
  mockPty.onExit.mockReset();

  server = createServer();
  setupTerminalWebSocket(server);

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterEach(async () => {
  db.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ─── Connection Tests ─────────────────────────────────────────────────────────

describe('terminal WebSocket', () => {
  // ─── URL matching (table-driven) ──────────────────────────────────────────

  const invalidUrls = [
    { name: 'no path', path: '/ws' },
    { name: 'wrong prefix', path: '/api/terminal/abc/0' },
    { name: 'missing window index', path: '/ws/terminal/abc' },
    { name: 'non-numeric window', path: '/ws/terminal/abc/xyz' },
  ];

  it.each(invalidUrls)('rejects connection for $name ($path)', async ({ path }) => {
    await expect(connectWs(path)).rejects.toThrow();
  });

  // ─── Task validation ─────────────────────────────────────────────────────

  it('closes with 4004 when task not found', async () => {
    const ws = await connectWs('/ws/terminal/nonexistent/0');
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });
    expect(code).toBe(4004);
  });

  it('closes with 4004 when task has no tmux session', async () => {
    insertTask(db);
    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });
    expect(code).toBe(4004);
  });

  // ─── Successful connection ────────────────────────────────────────────────

  it('spawns node-pty with tmux attach on valid connection', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);

    expect(nodePty.spawn).toHaveBeenCalledWith(
      'tmux',
      ['attach-session', '-t', `${DEFAULTS.runningTask.tmux_session}:0`],
      expect.objectContaining({ name: 'xterm-256color' }),
    );

    ws.close();
  });

  it('uses correct tmux target for window index', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);
    insertAgent(db, { id: 'agent-02', window_index: 1, label: 'Agent 2' });

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/1`);

    expect(nodePty.spawn).toHaveBeenCalledWith(
      'tmux',
      ['attach-session', '-t', `${DEFAULTS.runningTask.tmux_session}:1`],
      expect.any(Object),
    );

    ws.close();
  });

  // ─── Data flow ────────────────────────────────────────────────────────────

  it('forwards PTY data to WebSocket', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);

    // Simulate PTY sending data
    const onDataCb = mockPty.onData.mock.calls[0][0];
    const received = new Promise<string>((resolve) => {
      ws.on('message', (data) => resolve(data.toString()));
    });

    onDataCb('hello terminal');

    expect(await received).toBe('hello terminal');
    ws.close();
  });

  it('forwards WebSocket input to PTY', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);

    ws.send('user input');

    // Wait for message to propagate
    await new Promise((r) => setTimeout(r, 50));
    expect(mockPty.write).toHaveBeenCalledWith('user input');

    ws.close();
  });

  // ─── Resize handling ──────────────────────────────────────────────────────

  it('handles resize messages', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);

    ws.send(JSON.stringify({ type: 'resize', cols: 200, rows: 50 }));

    await new Promise((r) => setTimeout(r, 50));
    expect(mockPty.resize).toHaveBeenCalledWith(200, 50);

    ws.close();
  });

  it('treats non-resize JSON as terminal input', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);

    ws.send(JSON.stringify({ type: 'other' }));

    await new Promise((r) => setTimeout(r, 50));
    expect(mockPty.resize).not.toHaveBeenCalled();
    expect(mockPty.write).toHaveBeenCalled();

    ws.close();
  });

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  it('kills PTY when WebSocket closes', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);
    ws.close();

    await new Promise((r) => setTimeout(r, 50));
    expect(mockPty.kill).toHaveBeenCalled();
  });

  // ─── PTY spawn failure ─────────────────────────────────────────────────────

  it('closes with 4005 when node-pty spawn fails', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    vi.mocked(nodePty.spawn).mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });
    expect(code).toBe(4005);
  });

  // ─── PTY exit ──────────────────────────────────────────────────────────────

  it('closes WebSocket with 4006 when PTY exits', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);

    // Simulate PTY exit
    const onExitCb = mockPty.onExit.mock.calls[0][0];
    onExitCb({ exitCode: 0, signal: 0 });

    const code = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });
    expect(code).toBe(4006);
  });

  // ─── Connection tracking ───────────────────────────────────────────────────

  it('removes connection from map when WebSocket closes', async () => {
    const { getActiveConnections } = await import('./terminal.js');
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);

    // Connection should exist
    const conns = getActiveConnections();
    expect(conns.size).toBeGreaterThan(0);

    ws.close();
    await new Promise((r) => setTimeout(r, 50));

    // After cleanup, the specific connection key should be removed
    expect(conns.has(`${DEFAULTS.task.id}:0`)).toBe(false);
  });
});
