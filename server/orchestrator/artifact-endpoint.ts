/**
 * server/orchestrator/artifact-endpoint.ts
 *
 * Task 2.4 / SHR-127: symlink-safe artifact endpoint + advisory lock.
 *
 * Exports `mountArtifactEndpoint(app)` which registers:
 *   GET  /api/orchestrator/artifact?task=<id>&path=<p>
 *   PUT  /api/orchestrator/artifact?task=<id>&path=<p>
 *
 * Security model (spec §6.5, R2-F6):
 *  - Path resolution is symlink-safe: each path component is checked with
 *    lstatSync (no-follow). Any symlink component returns 403.
 *  - The final absolute path must lie strictly within the worktree directory
 *    (containment check).
 *  - Extension allowlist: .json | .md | .html only.
 *  - GET: returns file contents + ETag (SHA-256 of content, hex).
 *  - PUT: requires
 *      (a) If-Match header matching current ETag (428 if absent, 412 if stale)
 *      (b) managed_tasks.phase == 'awaiting_approval' (409 otherwise)
 *      (c) managed_tasks.artifact_lock_owner == 'ui' (409 otherwise)
 *    On success: writes via temp-then-rename; returns new ETag.
 *
 * Pointers-not-contents discipline: this endpoint is called by the *browser*
 * (to render/edit the artifact) — not by the orchestrator session. The
 * orchestrator only holds the path pointer (task_id + artifact path).
 */

import type { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { getManagedTask } from './store.js';
import { childLogger } from '../logger.js';
import { getTask } from '../repositories/index.js';
import type { Task } from '../types.js';

const logger = childLogger('orchestrator/artifact-endpoint');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Allowed file extensions. */
const ALLOWED_EXTENSIONS = new Set(['.json', '.md', '.html']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute an ETag for file contents (SHA-256 hex of the content string).
 * Returned as a quoted string per HTTP spec.
 */
function computeEtag(content: string): string {
  const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 32);
  return `"${hash}"`;
}

/**
 * Look up the worktree path for a task by id.
 * Returns null if the task doesn't exist or has no worktree.
 */
function getWorktreePath(taskId: string): { task: Task; worktreePath: string } | null {
  const task = getTask(taskId);
  if (!task) return null;
  if (!task.worktree) return null;
  return { task, worktreePath: task.worktree };
}

/**
 * Validate and resolve an artifact relative path against a worktree root.
 *
 * Rules:
 *  1. Path must not be absolute.
 *  2. After path.normalize, it must not start with `..` (traversal).
 *  3. Extension must be in ALLOWED_EXTENSIONS.
 *  4. Each path component from the worktree root down to the target must NOT
 *     be a symlink (lstatSync no-follow check).
 *  5. The fully resolved path must start with `worktreeDir + path.sep`
 *     (containment).
 *
 * Returns the absolute path on success, or a rejection reason string.
 */
function resolveArtifactPath(
  worktreeDir: string,
  relPath: string,
): { resolved: string } | { rejected: string } {
  // 1. Must not be absolute.
  if (path.isAbsolute(relPath)) {
    return { rejected: 'path must be relative, not absolute' };
  }

  // 2. Normalize and check for traversal.
  const normalized = path.normalize(relPath);
  if (normalized.startsWith('..') || normalized.startsWith('/')) {
    return { rejected: 'path traversal detected' };
  }

  // 3. Extension allowlist.
  const ext = path.extname(normalized).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      rejected: `extension "${ext}" is not allowed; allowed extensions: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
    };
  }

  // 4. Walk each component and reject any symlink.
  const segments = normalized.split(path.sep).filter(Boolean);
  let current = worktreeDir;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      // Component doesn't exist yet — that's OK for PUT (parent dirs may not
      // exist), but GET will fail at the read step. Stop symlink checking here
      // since there's nothing to check.
      break;
    }
    if (stat.isSymbolicLink()) {
      return { rejected: `symlink detected at path component "${current}"` };
    }
  }

  const resolved = path.join(worktreeDir, normalized);

  // 5. Containment: resolved path must be within worktreeDir.
  const containmentBase = worktreeDir.endsWith(path.sep) ? worktreeDir : worktreeDir + path.sep;
  if (!resolved.startsWith(containmentBase) && resolved !== worktreeDir) {
    return { rejected: 'path escapes worktree directory' };
  }

  return { resolved };
}

// ─── Route handlers ───────────────────────────────────────────────────────────

function handleGet(req: Request, res: Response): void {
  const taskId = req.query['task'] as string | undefined;
  const relPath = req.query['path'] as string | undefined;

  if (!taskId) {
    res.status(400).json({ error: 'task query parameter is required' });
    return;
  }
  if (!relPath) {
    res.status(400).json({ error: 'path query parameter is required' });
    return;
  }

  // Look up worktree.
  const found = getWorktreePath(taskId);
  if (!found) {
    res.status(404).json({ error: `task "${taskId}" not found or has no worktree` });
    return;
  }
  const { worktreePath } = found;

  // Symlink-safe path resolution.
  const resolution = resolveArtifactPath(worktreePath, relPath);
  if ('rejected' in resolution) {
    logger.warn(
      { task_id: taskId, path: relPath, reason: resolution.rejected },
      'artifact GET rejected',
    );
    res.status(403).json({ error: resolution.rejected });
    return;
  }
  const { resolved } = resolution;

  // Read file.
  let content: string;
  try {
    content = fs.readFileSync(resolved, 'utf8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      res.status(404).json({ error: `artifact not found: ${relPath}` });
    } else {
      logger.error({ task_id: taskId, path: relPath, err }, 'artifact GET read error');
      res.status(500).json({ error: 'failed to read artifact' });
    }
    return;
  }

  const etag = computeEtag(content);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');

  // Return JSON parsed for .json files; plain text otherwise.
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.json') {
    try {
      res.status(200).json(JSON.parse(content));
    } catch {
      // Malformed JSON — return as text so the UI can render in prose-fallback mode.
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(content);
    }
  } else {
    res.setHeader(
      'Content-Type',
      ext === '.html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
    );
    res.status(200).send(content);
  }
}

function handlePut(req: Request, res: Response): void {
  const taskId = req.query['task'] as string | undefined;
  const relPath = req.query['path'] as string | undefined;

  if (!taskId) {
    res.status(400).json({ error: 'task query parameter is required' });
    return;
  }
  if (!relPath) {
    res.status(400).json({ error: 'path query parameter is required' });
    return;
  }

  // Require If-Match header (conditional PUT).
  const ifMatch = req.headers['if-match'];
  if (!ifMatch) {
    res.status(428).json({ error: 'If-Match header is required for conditional PUT' });
    return;
  }

  // Look up worktree.
  const found = getWorktreePath(taskId);
  if (!found) {
    res.status(404).json({ error: `task "${taskId}" not found or has no worktree` });
    return;
  }
  const { worktreePath } = found;

  // Symlink-safe path resolution.
  const resolution = resolveArtifactPath(worktreePath, relPath);
  if ('rejected' in resolution) {
    logger.warn(
      { task_id: taskId, path: relPath, reason: resolution.rejected },
      'artifact PUT rejected',
    );
    res.status(403).json({ error: resolution.rejected });
    return;
  }
  const { resolved } = resolution;

  // Phase + lock check: must be awaiting_approval with lock held by UI.
  const managedTask = getManagedTask(taskId);
  if (
    !managedTask ||
    managedTask.phase !== 'awaiting_approval' ||
    managedTask.artifact_lock_owner !== 'ui'
  ) {
    const reason = !managedTask
      ? 'task is not orchestrator-managed'
      : managedTask.phase !== 'awaiting_approval'
        ? `PUT requires phase=awaiting_approval (current: ${managedTask.phase})`
        : 'PUT requires artifact_lock_owner=ui';
    logger.warn({ task_id: taskId, reason }, 'artifact PUT rejected: lock/phase check');
    res.status(409).json({ error: reason });
    return;
  }

  // ETag (If-Match) check — read current content to verify.
  let currentContent: string | null = null;
  try {
    currentContent = fs.readFileSync(resolved, 'utf8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.error({ task_id: taskId, path: relPath, err }, 'artifact PUT read error');
      res.status(500).json({ error: 'failed to read artifact for ETag check' });
      return;
    }
    // File doesn't exist yet — no ETag match possible.
  }

  if (currentContent !== null) {
    const currentEtag = computeEtag(currentContent);
    if (ifMatch !== currentEtag) {
      res.status(412).json({ error: `ETag mismatch: file has been modified since last fetch` });
      return;
    }
  } else if (ifMatch !== '"new"') {
    // File doesn't exist — only allow PUT with If-Match: "new"
    res.status(412).json({ error: 'ETag mismatch: file does not exist' });
    return;
  }

  // Build new content from request body.
  let newContent: string;
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.includes('application/json')) {
    // Re-serialise parsed JSON for consistent formatting.
    newContent = JSON.stringify(req.body, null, 2);
  } else if (typeof req.body === 'string') {
    newContent = req.body;
  } else {
    newContent = JSON.stringify(req.body);
  }

  // Atomic write: temp file then rename.
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = path.join(
    os.tmpdir(),
    `artifact-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    fs.writeFileSync(tmpFile, newContent, 'utf8');
    fs.renameSync(tmpFile, resolved);
  } catch (err) {
    // Clean up temp file if it exists.
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
    logger.error({ task_id: taskId, path: relPath, err }, 'artifact PUT write error');
    res.status(500).json({ error: 'failed to write artifact' });
    return;
  }

  const newEtag = computeEtag(newContent);
  logger.info(
    { task_id: taskId, path: relPath, operation: 'PUT', etag: newEtag },
    'artifact written',
  );

  res.setHeader('ETag', newEtag);
  res.status(200).json({ ok: true, etag: newEtag });
}

// ─── Mount ────────────────────────────────────────────────────────────────────

/**
 * Register the artifact GET/PUT endpoints on the given Express app.
 * Called from api.ts's `setupRoutes`.
 */
export function mountArtifactEndpoint(app: Express): void {
  app.get('/api/orchestrator/artifact', handleGet);
  app.put('/api/orchestrator/artifact', handlePut);
}
