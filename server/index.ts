import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import express from 'express';
import { fileURLToPath } from 'url';
import { createApp } from './app.js';
import { setupTerminalWebSocket } from './terminal.js';
import { startPolling } from './poller.js';
import { checkTaskStatus } from './poller.js';
import { resumeTask } from './task-runner.js';
import { getDb } from './db.js';
import type { Task } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = createApp();
const server = createServer(app);
const PORT = process.env.PORT || 7777;

// WebSocket for terminal streaming
setupTerminalWebSocket(server);

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

// Background status + PR polling
startPolling();

// Serve SPA in production
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, '..', 'dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

server.listen(PORT, () => {
  console.warn(`octomux-agents running at http://localhost:${PORT}`);
});

export { server, app };
