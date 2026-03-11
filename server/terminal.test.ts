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

// Mock execFile to work naturally with util.promisify (callback-style)
let execFileShouldFail = false;

const mockExecFile = vi.fn(
  (
    _cmd: string,
    _args: string[],
    callback?: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    if (callback) {
      if (execFileShouldFail) {
        process.nextTick(() => callback(new Error('tmux failed'), '', ''));
      } else {
        process.nextTick(() => callback(null, '', ''));
      }
    }
    return { on: vi.fn() };
  },
);

vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(args[0], args[1], args[2]),
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

/** Wait for async handleConnection to complete (grouped session setup) */
function waitForSetup(): Promise<void> {
  return new Promise((r) => setTimeout(r, 50));
}

beforeEach(async () => {
  db = createTestDb();
  vi.clearAllMocks();
  execFileShouldFail = false;

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

  // ─── Grouped session creation ──────────────────────────────────────────────

  it('creates a grouped tmux session for independent window selection', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);
    await waitForSetup();

    // Should create a grouped session linked to the main session
    expect(mockExecFile).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['new-session', '-d', '-t', DEFAULTS.runningTask.tmux_session]),
      expect.any(Function),
    );

    // Should select the correct window in the grouped session
    expect(mockExecFile).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['select-window']),
      expect.any(Function),
    );

    ws.close();
  });

  it('spawns node-pty attaching to the grouped session (not the main session)', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);
    await waitForSetup();

    // Should attach to the linked session, not directly to session:windowIndex
    const spawnCall = vi.mocked(nodePty.spawn).mock.calls[0];
    expect(spawnCall[0]).toBe('tmux');
    expect(spawnCall[1][0]).toBe('attach-session');
    // The target should be the linked session name (contains '-v-'), not session:0
    const target = spawnCall[1][2];
    expect(target).toContain(`${DEFAULTS.runningTask.tmux_session}-v-`);
    expect(target).not.toContain(':');

    ws.close();
  });

  it('selects correct window index for agent 2', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);
    insertAgent(db, { id: 'agent-02', window_index: 1, label: 'Agent 2' });

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/1`);
    await waitForSetup();

    // The select-window call should target windowIndex 1
    const selectCall = mockExecFile.mock.calls.find(
      (c: any[]) => c[0] === 'tmux' && c[1]?.[0] === 'select-window',
    );
    expect(selectCall).toBeDefined();
    const selectTarget = selectCall![1][2] as string;
    expect(selectTarget).toMatch(/:1$/);

    ws.close();
  });

  it('closes with 4005 when grouped session creation fails', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    execFileShouldFail = true;

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });
    expect(code).toBe(4005);
  });

  // ─── Data flow ────────────────────────────────────────────────────────────

  it('forwards PTY data to WebSocket', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);
    await waitForSetup();

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
    await waitForSetup();

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
    await waitForSetup();

    ws.send(JSON.stringify({ type: 'resize', cols: 200, rows: 50 }));

    await new Promise((r) => setTimeout(r, 50));
    expect(mockPty.resize).toHaveBeenCalledWith(200, 50);

    ws.close();
  });

  it('treats non-resize JSON as terminal input', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);
    await waitForSetup();

    ws.send(JSON.stringify({ type: 'other' }));

    await new Promise((r) => setTimeout(r, 50));
    expect(mockPty.resize).not.toHaveBeenCalled();
    expect(mockPty.write).toHaveBeenCalled();

    ws.close();
  });

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  it('kills PTY and linked session when WebSocket closes', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);
    await waitForSetup();

    mockExecFile.mockClear();
    ws.close();

    await new Promise((r) => setTimeout(r, 50));
    expect(mockPty.kill).toHaveBeenCalled();

    // Should kill the linked session on cleanup
    const killCall = mockExecFile.mock.calls.find(
      (c: any[]) => c[0] === 'tmux' && c[1]?.[0] === 'kill-session',
    );
    expect(killCall).toBeDefined();
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

  it('closes WebSocket with 4006 and cleans up linked session when PTY exits', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);
    await waitForSetup();

    mockExecFile.mockClear();

    // Simulate PTY exit
    const onExitCb = mockPty.onExit.mock.calls[0][0];
    onExitCb({ exitCode: 0, signal: 0 });

    const code = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
    });
    expect(code).toBe(4006);

    // Should kill linked session on PTY exit too
    await new Promise((r) => setTimeout(r, 50));
    const killCall = mockExecFile.mock.calls.find(
      (c: any[]) => c[0] === 'tmux' && c[1]?.[0] === 'kill-session',
    );
    expect(killCall).toBeDefined();
  });

  // ─── Connection tracking ───────────────────────────────────────────────────

  it('removes connection from map when WebSocket closes', async () => {
    const { getActiveConnections } = await import('./terminal.js');
    insertTask(db, { ...DEFAULTS.runningTask });
    insertAgent(db);

    const ws = await connectWs(`/ws/terminal/${DEFAULTS.task.id}/0`);
    await waitForSetup();

    // Connection should exist
    const conns = getActiveConnections();
    expect(conns.size).toBeGreaterThan(0);

    ws.close();
    await new Promise((r) => setTimeout(r, 50));

    // After cleanup, the specific connection key should be removed
    expect(conns.has(`${DEFAULTS.task.id}:0`)).toBe(false);
  });
});
