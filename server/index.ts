import { createServer, type IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import path from 'path';
import fs from 'fs';
import express from 'express';
import { fileURLToPath } from 'url';
import { createApp } from './app.js';
import {
  setupTerminalWebSocket,
  handleTerminalUpgrade,
  cleanupAllConnections,
} from './terminal.js';
import { setupEventWebSocket, handleEventUpgrade, cleanupEventClients } from './events.js';
import { startPolling, stopPolling } from './poller.js';
import { checkTaskStatus } from './poller.js';
import { resumeTask, cleanupOrphanedViewerSessions } from './task-runner.js';
import { getDb } from './db.js';
import type { Task } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = createApp();
const server = createServer(app);
const PORT = process.env.PORT || 7777;

// WebSocket setup
setupTerminalWebSocket();
setupEventWebSocket();

server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  if (handleTerminalUpgrade(req, socket, head)) return;
  if (handleEventUpgrade(req, socket, head)) return;
  socket.destroy();
});

// ─── Startup Recovery ──────────────────────────────────────────────────────
async function recoverTasks(): Promise<void> {
  const db = getDb();
  const staleTasks = db
    .prepare("SELECT * FROM tasks WHERE status IN ('running', 'setting_up')")
    .all() as Task[];

  for (const task of staleTasks) {
    const status = await checkTaskStatus(task);
    if (status === 'alive') continue;

    // Session is dead
    if (task.worktree && fs.existsSync(task.worktree)) {
      console.warn(`[recovery] Resuming task ${task.id}: ${task.title}`);
      resumeTask(task);
    } else if (task.status === 'setting_up') {
      console.warn(`[recovery] Setup interrupted for task ${task.id}: ${task.title}`);
      db.prepare(
        `UPDATE tasks SET status = 'error', error = 'Setup interrupted', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
    } else {
      console.warn(`[recovery] Worktree missing for task ${task.id}: ${task.title}`);
      db.prepare(
        `UPDATE tasks SET status = 'error', error = 'Worktree missing after restart', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
    }
  }
}

await recoverTasks();
await cleanupOrphanedViewerSessions();

// Background status + PR polling
startPolling();

// Serve SPA in production
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, '..', 'dist');
  app.use(express.static(distPath));
  app.get('/{*path}', (_req, res) => {
    res.sendFile('index.html', { root: distPath });
  });
}

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is in use. Try: octomux start --port 8080`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.warn(`octomux running at http://localhost:${PORT}`);
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
function shutdown() {
  console.warn('[shutdown] Stopping pollers...');
  stopPolling();
  console.warn('[shutdown] Cleaning up connections...');
  cleanupAllConnections();
  cleanupEventClients();
  console.warn('[shutdown] Closing HTTP server...');
  server.close(() => {
    console.warn('[shutdown] Done.');
    process.exit(0);
  });
  // Force exit after 5s if graceful shutdown stalls
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { server, app };
