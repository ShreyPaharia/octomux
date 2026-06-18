/**
 * Electron main process for octomux.
 *
 * Lifecycle:
 *  1. Acquire single-instance lock (quit if another instance is running).
 *  2. Fix GUI PATH (Finder/Dock launch strips Homebrew dirs) via fix-path.
 *  3. Find a free TCP port, set OCTOMUX_PORT.
 *  4. Import the built server bundle (dist-server/index.js) — it self-starts listen().
 *  5. Poll until port accepts a connection, then open BrowserWindow.
 */

import { app, BrowserWindow } from 'electron';
import path from 'path';
import net from 'net';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Single-instance lock ─────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ─── GUI PATH fix (git / claude resolve when launched from Finder/Dock) ───────

try {
  // fix-path patches process.env.PATH with the shell-resolved PATH so binaries
  // in /opt/homebrew/bin, /usr/local/bin, ~/.nvm, etc. are found.
  const { default: fixPath } = await import('fix-path');
  fixPath();
} catch {
  // Non-fatal: path may already be correct (e.g. launched from terminal).
}

// ─── Free-port discovery ──────────────────────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not determine free port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

// ─── Wait until port accepts a connection ─────────────────────────────────────

function waitForPort(port: number, maxWaitMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + maxWaitMs;

    function attempt() {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.on('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Server did not start within ${maxWaitMs}ms on port ${port}`));
          return;
        }
        setTimeout(attempt, 100);
      });
    }

    attempt();
  });
}

// ─── Window management ────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

function createWindow(port: number): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.on('second-instance', () => {
  // Focus the existing window when a second instance is attempted.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  // On macOS, keep the app alive unless explicitly quit.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On macOS, recreate the window when the dock icon is clicked and no windows are open.
  if (mainWindow === null && _serverPort !== null) {
    createWindow(_serverPort);
  }
});

let _serverPort: number | null = null;

app.whenReady().then(async () => {
  // 0. Isolate the desktop app from the CLI BEFORE importing the server.
  //    Its own data dir → own SQLite DB, own tmux socket, own logs — so it never
  //    collides with the CLI's ~/.octomux (which also avoids the bundled-tmux vs
  //    system-tmux version clash on a shared socket). NODE_ENV=production is
  //    required for the server to honor OCTOMUX_DATA_DIR (the dev branch ignores
  //    it). HOME can be empty under a GUI/Finder launch, which broke ~/.claude
  //    paths (mkdir '/.claude') — pin it.
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
  if (!process.env.OCTOMUX_DATA_DIR) {
    process.env.OCTOMUX_DATA_DIR = path.join(app.getPath('userData'), 'data');
  }
  if (!process.env.HOME) process.env.HOME = os.homedir();

  // 1. Pick a free port and tell the server to use it.
  const port = await findFreePort();
  _serverPort = port;
  process.env.OCTOMUX_PORT = String(port);

  // 2. Boot the server (self-starts listener inside index.js).
  // dist-server/ is a build artifact (not present at typecheck time).
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  await import('../dist-server/index.js');

  // 3. Wait until the HTTP server is actually accepting connections.
  await waitForPort(port);

  // 4. Open the browser window.
  createWindow(port);
});
