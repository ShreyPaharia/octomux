import express from 'express';
import type { Request, Response } from 'express';
import { childLogger } from '../logger.js';
import { requireBearerHookToken } from './hook-auth.js';
import {
  addLearning,
  getLearning,
  laneFor,
  listBenefit,
  listForDigest,
  searchForRead,
  searchShared,
  supersedeLearning,
  touchLearning,
  SHARED_LANE,
} from '../repositories/agent-learnings.js';
import type { AgentLearning } from '../types.js';
import { lintLearning } from '../repositories/learn-lint.js';
import { getTask } from '../repositories/tasks.js';
import { revParseHead } from '../task-engine/git.js';
import { badRequest, notFound, ServiceError } from '../services/errors.js';

const logger = childLogger('routes/learnings');
export const router = express.Router();

// The PR-review learning lane in the shared agent_learnings store (folded in
// from the old standalone review_learnings table — see spec/agent-learnings-store.md Task 9).
// Exported: server/registry/capabilities/learning.ts's learning.list handler
// (the migrated GET /api/repos/:repoPath/learnings) reuses these verbatim.
export const REVIEW_LANE = 'review';
export const REVIEW_LIST_LIMIT = 50;

// GET /api/repos/:repoPath/learnings and DELETE /api/learnings/:id now live in
// server/registry/capabilities/learning.ts (learning.list / learning.delete)
// — both were unauthenticated, so migrating them onto the capability registry
// changes nothing about who can call them. See that module's doc comment for
// why the other four routes below did NOT move: they're gated by
// requireBearerHookToken, and the registry's HttpProjection has no way to
// express "reject a missing/invalid bearer token" (resolveCallerFromRequest
// only classifies caller identity — an unrecognised request still resolves to
// 'agent' and is authorized, rather than being rejected).

/**
 * Recall learnings matching `query`, shared across `GET /api/learnings` (the
 * bearer-gated agent-recall route, below) and the `search_learnings` MCP tool
 * (server/orchestrator/mcp/read.ts) — previously two independent
 * implementations that behaved differently (one lane-aware + usage-tracking,
 * the other shared-lane-only and silent). Now one function both call
 * in-process:
 *
 *   - `taskId` given (the HTTP route, always): resolves the task's own lane
 *     via `laneFor`, searches shared + that lane via `searchForRead`, and
 *     bumps `usage_count` on every returned row via `touchLearning` — exactly
 *     what the route did inline before.
 *   - `taskId` omitted (the MCP tool, which has no task context — it's the
 *     conductor's cross-task search, not a worker's): searches the shared
 *     lane only via `searchShared`, no usage bump — exactly what
 *     `handleSearchLearnings` did inline before.
 */
export function recallLearnings(input: {
  taskId?: string;
  query: string;
  repo?: string;
}): AgentLearning[] {
  if (input.taskId) {
    const task = getTask(input.taskId);
    if (!task) throw notFound('Task not found');
    const rows = searchForRead(task.repo_path, laneFor(task), input.query);
    for (const r of rows) touchLearning(r.id);
    return rows;
  }
  return searchShared(input.query, input.repo ? { repo: input.repo } : {});
}

// ── Agent learnings store (octomux learn/recall) ──────────────────────────

router.post('/api/learnings', requireBearerHookToken, async (req: Request, res: Response) => {
  const b = req.body as {
    taskId?: unknown;
    trigger?: unknown;
    lesson?: unknown;
    evidence?: unknown;
    private?: unknown;
  };
  if (typeof b.taskId !== 'string' || !b.taskId) throw badRequest('taskId is required');
  if (typeof b.trigger !== 'string' || !b.trigger.trim()) throw badRequest('trigger is required');
  if (typeof b.lesson !== 'string' || !b.lesson.trim()) throw badRequest('lesson is required');
  if (typeof b.evidence !== 'string' || !b.evidence.trim()) {
    throw badRequest('evidence is required');
  }

  const task = getTask(b.taskId);
  if (!task) throw notFound('Task not found');

  const lint = lintLearning(b.lesson);
  if (!lint.ok) {
    logger.warn({ task_id: task.id, reason: lint.reason }, 'learning rejected by lint');
    res.status(422).json({ error: `learning rejected: ${lint.reason}` });
    return;
  }

  const commit = task.worktree ? await revParseHead(task.worktree).catch(() => null) : null;
  const lane = b.private === true ? laneFor(task) : SHARED_LANE;
  const row = addLearning({
    repo_path: task.repo_path,
    lane,
    trigger: b.trigger.trim(),
    lesson: b.lesson.trim(),
    evidence: b.evidence.trim(),
    source_run_id: task.id,
    source_commit: commit,
  });
  logger.info({ task_id: task.id, lane, deduped: row === null }, 'learning recorded');
  res.status(201).json(row ?? { deduped: true });
});

router.get('/api/learnings', requireBearerHookToken, (req: Request, res: Response) => {
  const q = req.query as Record<string, string>;
  if (typeof q.taskId !== 'string' || !q.taskId) throw badRequest('taskId is required');
  if (typeof q.query !== 'string' || !q.query.trim()) throw badRequest('query is required');

  const rows = recallLearnings({ taskId: q.taskId, query: q.query });
  logger.info({ task_id: q.taskId, count: rows.length }, 'learnings recalled');
  res.json(rows);
});

// POST /api/learnings/:id/supersede — soft-supersede a now-false learning
// (reversible: the row stays, just filtered out of reads). Isolation check:
// a task may only supersede learnings that belong to its own repo.
router.post(
  '/api/learnings/:id/supersede',
  requireBearerHookToken,
  (req: Request, res: Response) => {
    const id = (req.params as Record<string, string>).id;
    const b = req.body as { taskId?: unknown; reason?: unknown };
    if (typeof b.taskId !== 'string' || !b.taskId) throw badRequest('taskId is required');
    if (typeof b.reason !== 'string' || !b.reason.trim()) throw badRequest('reason is required');

    const learning = getLearning(id);
    if (!learning) throw notFound('Learning not found');

    const task = getTask(b.taskId);
    if (!task) throw notFound('Task not found');

    if (learning.repo_path !== task.repo_path) {
      throw new ServiceError('learning belongs to a different repo', 403);
    }

    supersedeLearning(id, b.reason.trim());
    logger.info(
      { task_id: task.id, learning_id: id, reason: b.reason.trim() },
      'learning superseded',
    );
    res.status(200).json(getLearning(id));
  },
);

const DEFAULT_DIGEST_SINCE_DAYS = 7;

// GET /api/learnings/digest — weekly digest data (additions/removal-candidates/benefit)
// consumed by `octomux learnings-digest`. Read-only; same hook-token auth as
// the rest of this router (any live agent's token, not scoped to one task).
router.get('/api/learnings/digest', requireBearerHookToken, (req: Request, res: Response) => {
  const q = req.query as Record<string, string>;
  if (typeof q.repo !== 'string' || !q.repo) throw badRequest('repo is required');

  const sinceDays = q.sinceDays ? Number(q.sinceDays) : DEFAULT_DIGEST_SINCE_DAYS;
  if (!Number.isFinite(sinceDays) || sinceDays <= 0) throw badRequest('sinceDays must be > 0');

  const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ');
  const { additions, unused, superseded } = listForDigest(q.repo, sinceIso);
  const benefit = listBenefit(q.repo);
  logger.info(
    {
      repo_path: q.repo,
      sinceDays,
      additions: additions.length,
      unused: unused.length,
      superseded: superseded.length,
    },
    'learnings digest computed',
  );
  res.json({ additions, unused, superseded, benefit });
});
