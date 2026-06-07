import { createServer, type IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import path from 'path';
import fs from 'fs';
import express from 'express';
import { fileURLToPath } from 'url';
import { createApp } from './app.js';
import { getBindHost, isRemoteMode, isUpgradeAuthorized, ensureToken } from './remote-auth.js';
import {
  setupTerminalWebSocket,
  handleTerminalUpgrade,
  cleanupAllConnections,
} from './terminal.js';
import { setupEventWebSocket, handleEventUpgrade, cleanupEventClients } from './events.js';
import { startPolling, stopPolling } from './poller.js';
import { checkTaskStatus } from './poller.js';
import {
  resumeTask,
  cleanupOrphanedViewerSessions,
  reconcileOrphanSettingUp,
  gcScratchDirs,
} from './task-runner.js';
import { getDb } from './db.js';
import { syncAgents } from './agents.js';
import { ensureGithubLogin } from './github-login.js';
import { childLogger } from './logger.js';
import type { Task } from './types.js';
import { SELECT_TASK_SQL } from './task-select.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = childLogger('index');
const app = createApp();
const server = createServer(app);
const PORT = process.env.OCTOMUX_PORT || process.env.PORT || 7777;

// WebSocket setup
setupTerminalWebSocket();
setupEventWebSocket();

server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  if (!isUpgradeAuthorized(req)) {
    socket.destroy();
    return;
  }
  if (handleTerminalUpgrade(req, socket, head)) return;
  if (handleEventUpgrade(req, socket, head)) return;
  socket.destroy();
});

// ─── Startup Recovery ──────────────────────────────────────────────────────
async function recoverTasks(): Promise<void> {
  const db = getDb();
  const staleTasks = db
    .prepare(`${SELECT_TASK_SQL} WHERE t.runtime_state IN ('running', 'setting_up')`)
    .all() as Task[];

  for (const task of staleTasks) {
    const status = await checkTaskStatus(task);
    if (status === 'alive') continue;

    // Session is dead. Require tmux_session too — without it the task never
    // reached the new-session step, so there's nothing for resumeTask to
    // re-attach to; treat it as an interrupted setup instead.
    if (task.worktree && fs.existsSync(task.worktree) && task.tmux_session) {
      logger.warn({ task_id: task.id, title: task.title }, 'Recovery: resuming task');
      resumeTask(task).catch((err) => {
        logger.error({ task_id: task.id, err }, 'Recovery: resumeTask failed');
      });
    } else if (task.runtime_state === 'setting_up') {
      logger.warn({ task_id: task.id, title: task.title }, 'Recovery: setup was interrupted');
      db.prepare(
        `UPDATE tasks SET runtime_state = 'error', error = 'Setup interrupted', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
    } else {
      logger.warn({ task_id: task.id, title: task.title }, 'Recovery: worktree missing');
      db.prepare(
        `UPDATE tasks SET runtime_state = 'error', error = 'Worktree missing after restart', updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
    }
  }
}

await reconcileOrphanSettingUp();
await recoverTasks();
await cleanupOrphanedViewerSessions();
await gcScratchDirs();

// Sync built-in agent definitions to .claude/agents/
await syncAgents().catch((err: unknown) => {
  logger.error({ err }, 'Failed to sync agents');
});

// Resolve owner's GitHub login for reviewer-request polling (non-blocking)
ensureGithubLogin().catch((err) => {
  logger.warn({ err }, 'ensureGithubLogin failed — reviewer polling disabled');
});

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
    logger.error({ port: PORT }, `Port ${PORT} is in use — try: octomux start --port 8080`);
    process.exit(1);
  }
  throw err;
});

const HOST = getBindHost();
server.listen(Number(PORT), HOST, () => {
  logger.info({ port: PORT, host: HOST }, `octomux listening on ${HOST}`);
  if (isRemoteMode()) {
    ensureToken(); // generate + log the token file path on first remote start
    logger.warn(
      { host: HOST },
      'remote access ENABLED — clients must present the token at /login (see remote-token file or OCTOMUX_REMOTE_TOKEN)',
    );
  }
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
function shutdown() {
  logger.info('Shutdown: stopping pollers');
  stopPolling();
  logger.info('Shutdown: cleaning up connections');
  cleanupAllConnections();
  cleanupEventClients();
  logger.info('Shutdown: closing HTTP server');
  server.close(() => {
    logger.info('Shutdown: done');
    process.exit(0);
  });
  // Force exit after 5s if graceful shutdown stalls
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { server, app };
