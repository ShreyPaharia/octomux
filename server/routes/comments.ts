import express from 'express';
import type { Request, Response } from 'express';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { childLogger } from '../logger.js';
import { safeResolvePath } from '@octomux/diff-engine';
import { taskWorkingDir } from '../task-paths.js';
import { setReviewed, clearReviewed } from '../repositories/file-review-state.js';
import {
  listComments,
  getComment,
  resolveComment,
  unresolveComment,
  updateCommentBody,
  deleteComment,
  updateCommentFields,
} from '../repositories/inline-comments.js';
import { computeOutdated } from '../inline-comments-outdated.js';
import { addLearning } from '../repositories/review-learnings.js';
import { createInlineComment } from '../services/comment-service.js';
import { ServiceError } from '../services/errors.js';
import { loadTaskOrFail } from './_shared.js';

const execFile = promisify(execFileCb);
const logger = childLogger('api:comments');

export const router = express.Router();

// POST /api/tasks/:id/files/*path/reviewed — mark a file as reviewed
router.post('/api/tasks/:id/files/*path/reviewed', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const cwd = taskWorkingDir(task);
  if (!cwd) {
    res.status(400).json({ error: 'Task has no worktree' });
    return;
  }
  const params = req.params as Record<string, string | string[]>;
  const rawPath = params.path ?? params['0'] ?? '';
  const relPath = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
  try {
    safeResolvePath(cwd, relPath);
  } catch {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  try {
    const { stdout } = await execFile('git', ['-C', cwd, 'rev-parse', 'HEAD']);
    const headSha = stdout.trim();
    // Capture the blob hash of the content actually reviewed (the working
    // tree), so "changed since review" reacts to uncommitted edits too. Null
    // when the file is gone (e.g. a reviewed deletion).
    let blobSha: string | null = null;
    try {
      const { stdout: bs } = await execFile('git', ['-C', cwd, 'hash-object', '--', relPath]);
      blobSha = bs.trim() || null;
    } catch {
      blobSha = null;
    }
    setReviewed(task.id, relPath, headSha, blobSha);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/tasks/:id/files/*path/reviewed — unmark a file as reviewed
router.delete('/api/tasks/:id/files/*path/reviewed', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const cwd = taskWorkingDir(task);
  if (!cwd) {
    res.status(400).json({ error: 'Task has no worktree' });
    return;
  }
  const params = req.params as Record<string, string | string[]>;
  const rawPath = params.path ?? params['0'] ?? '';
  const relPath = Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
  try {
    safeResolvePath(cwd, relPath);
  } catch {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  clearReviewed(task.id, relPath);
  res.status(204).send();
});

// POST /api/tasks/:id/comments — create an inline review comment
router.post('/api/tasks/:id/comments', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  if (task.run_mode === 'scratch') {
    res.status(400).json({ error: 'no repo for scratch task' });
    return;
  }
  const cwd = taskWorkingDir(task);
  if (!cwd) {
    res.status(400).json({ error: 'Task has no worktree' });
    return;
  }
  if (!fs.existsSync(cwd)) {
    res.status(400).json({ error: 'Worktree no longer exists on disk' });
    return;
  }

  const body = req.body as {
    file_path?: unknown;
    line?: unknown;
    side?: unknown;
    body?: unknown;
    agent_id?: unknown;
    anchor_commit_sha?: unknown;
  };

  const filePath = typeof body.file_path === 'string' ? body.file_path : '';
  const lineRaw = body.line;
  const side = body.side;
  const commentBody = typeof body.body === 'string' ? body.body : '';
  const agentId = typeof body.agent_id === 'string' && body.agent_id ? body.agent_id : null;
  const anchorRaw = body.anchor_commit_sha;

  if (!filePath) {
    res.status(400).json({ error: 'file_path is required' });
    return;
  }
  if (typeof lineRaw !== 'number' || !Number.isInteger(lineRaw) || lineRaw < 1) {
    res.status(400).json({ error: 'line must be a positive integer' });
    return;
  }
  if (side !== 'old' && side !== 'new') {
    res.status(400).json({ error: "side must be 'old' or 'new'" });
    return;
  }
  if (!commentBody.trim()) {
    res.status(400).json({ error: 'body is required' });
    return;
  }
  if (anchorRaw !== undefined && typeof anchorRaw !== 'string') {
    res.status(400).json({ error: 'anchor_commit_sha must be a string' });
    return;
  }

  try {
    safeResolvePath(cwd, filePath);
  } catch {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  if (!task.base_sha) {
    res.status(400).json({ error: 'base_sha not available for this task' });
    return;
  }

  try {
    const row = await createInlineComment({
      cwd,
      task_id: task.id,
      base_sha: task.base_sha,
      file_path: filePath,
      line: lineRaw as number,
      side: side as 'old' | 'new',
      body: commentBody,
      agent_id: agentId,
      anchor_commit_sha: anchorRaw as string | undefined,
    });
    res.status(201).json(row);
  } catch (err) {
    if (err instanceof ServiceError) {
      res.status(err.status).json({ error: err.message });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

// GET /api/tasks/:id/comments — list inline comments for a task
router.get('/api/tasks/:id/comments', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;

  const fileFilter = typeof req.query.file === 'string' ? req.query.file : undefined;
  const rows = listComments(task.id, fileFilter ? { file: fileFilter } : undefined);

  const cwd = taskWorkingDir(task);
  const haveWorktree = !!cwd && fs.existsSync(cwd) && task.run_mode !== 'scratch';

  if (!haveWorktree || !task.base_sha) {
    res.json({
      comments: rows.map((r) => ({ ...r, outdated: false })),
      outdated_unavailable: true,
    });
    return;
  }

  try {
    const map = await computeOutdated(cwd!, task.base_sha, rows);
    res.json({
      comments: rows.map((r) => ({ ...r, outdated: map.get(r.id) ?? false })),
    });
  } catch (err) {
    logger.warn(
      { task_id: task.id, err: (err as Error).message },
      'computeOutdated failed; returning comments without outdated flag',
    );
    res.json({
      comments: rows.map((r) => ({ ...r, outdated: false })),
      outdated_unavailable: true,
    });
  }
});

// PATCH /api/tasks/:id/comments/:cid — update a comment
router.patch('/api/tasks/:id/comments/:cid', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;

  const cid = (req.params as Record<string, string>).cid;
  const existing = getComment(cid);
  if (!existing || existing.task_id !== task.id) {
    res.status(404).json({ error: 'Comment not found' });
    return;
  }

  // Refuse updates on already-published comments
  if (existing.status === 'published') {
    res.status(409).json({ error: 'Cannot update a published comment' });
    return;
  }

  const body = req.body as {
    resolved?: unknown;
    body?: unknown;
    status?: unknown;
    bucket?: unknown;
    kind?: unknown;
    severity?: unknown;
    existing_code?: unknown;
    suggested_code?: unknown;
    rejection_why?: unknown;
  };
  const hasResolved = body.resolved !== undefined;
  const hasBody = body.body !== undefined;
  const hasStatus = body.status !== undefined;
  const hasExtended =
    body.bucket !== undefined ||
    body.kind !== undefined ||
    body.severity !== undefined ||
    body.existing_code !== undefined ||
    body.suggested_code !== undefined;

  const VALID_STATUSES = ['draft', 'accepted', 'rejected', 'stale'];

  if (!hasResolved && !hasBody && !hasStatus && !hasExtended) {
    res.status(400).json({ error: 'no fields to update' });
    return;
  }
  if (hasResolved && typeof body.resolved !== 'boolean') {
    res.status(400).json({ error: 'resolved must be a boolean' });
    return;
  }
  if (hasBody && (typeof body.body !== 'string' || !body.body.trim())) {
    res.status(400).json({ error: 'body must be a non-empty string' });
    return;
  }
  if (hasStatus && !VALID_STATUSES.includes(body.status as string)) {
    res.status(400).json({ error: `status must be one of ${VALID_STATUSES.join(', ')}` });
    return;
  }

  let row = existing;

  if (hasBody) {
    const updated = updateCommentBody(cid, body.body as string);
    if (updated) row = updated;
  }
  if (hasResolved) {
    const updated = (body.resolved as boolean) ? resolveComment(cid) : unresolveComment(cid);
    if (updated) row = updated;
  }
  if (hasStatus || hasExtended) {
    const fields: import('../repositories/inline-comments.js').UpdateCommentFields = {};
    if (hasStatus) fields.status = body.status as import('../types.js').CommentStatus;
    if (body.bucket !== undefined)
      fields.bucket = body.bucket as import('../types.js').CommentBucket | null;
    if (body.kind !== undefined) fields.kind = body.kind as import('../types.js').CommentKind;
    if (body.severity !== undefined)
      fields.severity = body.severity as import('../types.js').CommentSeverity | null;
    if (body.existing_code !== undefined)
      fields.existing_code = body.existing_code as string | null;
    if (body.suggested_code !== undefined)
      fields.suggested_code = body.suggested_code as string | null;
    const updated = updateCommentFields(cid, fields);
    if (updated) row = updated;
  }

  // Capture rejection learning if status='rejected' and rejection_why provided
  if (
    body.status === 'rejected' &&
    typeof body.rejection_why === 'string' &&
    body.rejection_why.trim()
  ) {
    const repoPath = task.repo_path ?? '';
    if (repoPath) {
      addLearning({
        repo_path: repoPath,
        why: body.rejection_why.trim(),
        created_from_comment_id: cid,
      });
    }
  }

  res.json(row);
});

// DELETE /api/tasks/:id/comments/:cid — delete a comment
router.delete('/api/tasks/:id/comments/:cid', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;

  const cid = (req.params as Record<string, string>).cid;
  const existing = getComment(cid);
  if (!existing || existing.task_id !== task.id) {
    res.status(404).json({ error: 'Comment not found' });
    return;
  }

  deleteComment(cid);
  res.status(204).send();
});
