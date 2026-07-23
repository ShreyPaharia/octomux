// Load .env from the launch cwd BEFORE any other module reads process.env. Kept
// as the first import so dotenv runs before the imports below are evaluated.
// Real environment variables always win — dotenv never overrides an already-set
// var, so `export FOO=…; octomux start` still takes precedence over .env.
import 'dotenv/config';
import { createServer, type IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import { createApp } from './app.js';
import { getBindHost, isRemoteMode, isUpgradeAuthorized, ensureToken } from './remote-auth.js';
import {
  setupTerminalWebSocket,
  handleTerminalUpgrade,
  cleanupAllConnections,
} from './terminal.js';
import {
  setupEventWebSocket,
  handleEventUpgrade,
  cleanupEventClients,
  subscribeServerEvents,
} from './events.js';
import {
  setupOrchestratorWebSocket,
  handleOrchestratorUpgrade,
  cleanupOrchestratorClients,
} from './orchestrator/stream.js';
import { createSupervisor } from './orchestrator/supervisor.js';
import { rehydrateConversations } from './orchestrator/runner.js';
import { rehydratePendingCards } from './orchestrator/gate.js';
import { startPolling, stopPolling } from './poller.js';
import {
  cleanupOrphanedViewerSessions,
  reconcileOrphanSettingUp,
  gcScratchDirs,
  recoverTasks,
} from './task-engine/index.js';
import { ensureTmuxRuntimeDir } from './tmux-bin.js';
import { ensureGithubLogin } from './github-login.js';
import { acquireInstanceLock } from './single-instance.js';
import { childLogger } from './logger.js';
import { wireReviewerRunFinisher } from './workflows/reviewer/finish-run.js';
import { startGatewayIfConfigured } from './gateway/boot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = childLogger('index');

// Refuse to boot a second server against the same database (see incident: a
// stale dev build kept re-closing a resumed task via the merged-PR poller).
acquireInstanceLock();

const app = createApp();
const server = createServer(app);
const PORT = process.env.OCTOMUX_PORT || process.env.PORT || 7777;

// WebSocket setup
setupTerminalWebSocket();
setupEventWebSocket();
setupOrchestratorWebSocket();

server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  if (!isUpgradeAuthorized(req)) {
    socket.destroy();
    return;
  }
  if (handleTerminalUpgrade(req, socket, head)) return;
  if (handleEventUpgrade(req, socket, head)) return;
  if (handleOrchestratorUpgrade(req, socket, head)) return;
  socket.destroy();
});

// Create the run/ dir holding the private tmux socket before any tmux call.
ensureTmuxRuntimeDir();

await reconcileOrphanSettingUp();
await recoverTasks();
await cleanupOrphanedViewerSessions();
await gcScratchDirs();

// Resolve owner's GitHub login for reviewer-request polling (non-blocking)
ensureGithubLogin().catch((err) => {
  logger.warn({ err }, 'ensureGithubLogin failed — reviewer polling disabled');
});

// Finish reviewer workflow runs when drafting completes (not on publish).
wireReviewerRunFinisher();

// ─── Orchestrator supervisor ───────────────────────────────────────────────
// The supervisor is the single in-process subscriber to the durable events log.
// It routes each task event to the owning orchestrator conversation and runs the
// phase-complete relay (plan → approval card → implement). Without this wiring
// the orchestrator's close-the-loop machinery never runs.
const supervisor = createSupervisor();
subscribeServerEvents((event, seq) => {
  if (seq === undefined) return; // only durable task events carry a seq
  const taskId = (event.payload as { taskId?: string }).taskId;
  if (!taskId) return;
  void supervisor
    .processEvent({
      seq,
      task_id: taskId,
      type: event.type,
      payload: JSON.stringify(event.payload),
    })
    .catch((err: unknown) => {
      logger.error({ err, task_id: taskId, type: event.type }, 'supervisor.processEvent failed');
    });
});

// Restart recovery: replay missed events for each active conversation and log
// any pending approval cards that survived the restart (the UI re-renders them
// from the DB on load).
for (const conv of rehydrateConversations()) {
  void supervisor.replay(conv.conversationId).catch((err: unknown) => {
    logger.error({ err, conversation_id: conv.conversationId }, 'supervisor.replay failed on boot');
  });
}
const pendingCards = rehydratePendingCards();
if (pendingCards.length > 0) {
  logger.info({ count: pendingCards.length }, 'orchestrator: pending approval cards rehydrated');
}

// Background status + PR polling
startPolling();

// Telegram gateway — opt-in, only starts if OCTOMUX_GATEWAY_TELEGRAM_TOKEN is set.
void startGatewayIfConfigured();

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
    try {
      ensureToken(); // generate + log the token file path on first remote start
    } catch (err) {
      logger.error(
        { err },
        'remote mode: failed to read/create remote-access token — set OCTOMUX_REMOTE_TOKEN or fix permissions on the token dir',
      );
      process.exit(1);
    }
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
  cleanupOrchestratorClients();
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
