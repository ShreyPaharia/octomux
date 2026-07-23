import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import { childLogger } from '../logger.js';
import { hashObject, revParseHead } from '../task-engine/git.js';
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
import { addLearning } from '../repositories/agent-learnings.js';
import { createInlineComment } from '../services/comment-service.js';
import { loadTaskOrFail } from './_shared.js';
import { badRequest, conflict, notFound } from '../services/errors.js';

const logger = childLogger('api:comments');

function resolveRelPath(req: Request): string {
  const params = req.params as Record<string, string | string[]>;
  const rawPath = params.path ?? params['0'] ?? '';
  return Array.isArray(rawPath) ? rawPath.join('/') : rawPath;
}

function assertValidPath(cwd: string, relPath: string): void {
  try {
    safeResolvePath(cwd, relPath);
  } catch {
    throw badRequest('Invalid path');
  }
}

export const router = express.Router();

router.post('/api/tasks/:id/files/*path/reviewed', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  const cwd = taskWorkingDir(task);
  if (!cwd) {
    throw badRequest('Task has no worktree');
  }
  const relPath = resolveRelPath(req);
  assertValidPath(cwd, relPath);

  const headSha = await revParseHead(cwd);
  const blobSha = await hashObject(cwd, relPath);
  setReviewed(task.id, relPath, headSha, blobSha);
  res.status(204).send();
});

router.delete('/api/tasks/:id/files/*path/reviewed', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  const cwd = taskWorkingDir(task);
  if (!cwd) {
    throw badRequest('Task has no worktree');
  }
  const relPath = resolveRelPath(req);
  assertValidPath(cwd, relPath);
  clearReviewed(task.id, relPath);
  res.status(204).send();
});

router.post('/api/tasks/:id/comments', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);
  if (task.run_mode === 'scratch') {
    throw badRequest('no repo for scratch task');
  }
  const cwd = taskWorkingDir(task);
  if (!cwd) {
    throw badRequest('Task has no worktree');
  }
  if (!fs.existsSync(cwd)) {
    throw badRequest('Worktree no longer exists on disk');
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
    throw badRequest('file_path is required');
  }
  if (typeof lineRaw !== 'number' || !Number.isInteger(lineRaw) || lineRaw < 1) {
    throw badRequest('line must be a positive integer');
  }
  if (side !== 'old' && side !== 'new') {
    throw badRequest("side must be 'old' or 'new'");
  }
  if (!commentBody.trim()) {
    throw badRequest('body is required');
  }
  if (anchorRaw !== undefined && typeof anchorRaw !== 'string') {
    throw badRequest('anchor_commit_sha must be a string');
  }

  assertValidPath(cwd, filePath);

  if (!task.base_sha) {
    throw badRequest('base_sha not available for this task');
  }

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
});

router.get('/api/tasks/:id/comments', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);

  const fileFilter = typeof req.query.file === 'string' ? req.query.file : undefined;
  const activeOnly = req.query.active === '1' || req.query.active === 'true';
  const rows = listComments(
    task.id,
    fileFilter || activeOnly ? { file: fileFilter, activeOnly } : undefined,
  );

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

router.patch('/api/tasks/:id/comments/:cid', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);

  const cid = (req.params as Record<string, string>).cid;
  const existing = getComment(cid);
  if (!existing || existing.task_id !== task.id) {
    throw notFound('Comment not found');
  }

  if (existing.status === 'published') {
    throw conflict('Cannot update a published comment');
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
    throw badRequest('no fields to update');
  }
  if (hasResolved && typeof body.resolved !== 'boolean') {
    throw badRequest('resolved must be a boolean');
  }
  if (hasBody && (typeof body.body !== 'string' || !body.body.trim())) {
    throw badRequest('body must be a non-empty string');
  }
  if (hasStatus && !VALID_STATUSES.includes(body.status as string)) {
    throw badRequest(`status must be one of ${VALID_STATUSES.join(', ')}`);
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

  if (
    body.status === 'rejected' &&
    typeof body.rejection_why === 'string' &&
    body.rejection_why.trim()
  ) {
    const repoPath = task.repo_path ?? '';
    if (repoPath) {
      addLearning({
        repo_path: repoPath,
        lane: 'review',
        trigger: 'PR review learning',
        lesson: body.rejection_why.trim(),
        evidence: cid,
        source_run_id: cid,
      });
    }
  }

  res.json(row);
});

router.delete('/api/tasks/:id/comments/:cid', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);

  const cid = (req.params as Record<string, string>).cid;
  const existing = getComment(cid);
  if (!existing || existing.task_id !== task.id) {
    throw notFound('Comment not found');
  }

  deleteComment(cid);
  res.status(204).send();
});
