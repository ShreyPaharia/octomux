import express from 'express';
import type { Request, Response } from 'express';
import { childLogger } from '../logger.js';
import { requireBearerHookToken } from './hook-auth.js';
import {
  addLearning,
  deleteLearning,
  getLearning,
  laneFor,
  listBenefit,
  listForDigest,
  listForRead,
  searchForRead,
  supersedeLearning,
  touchLearning,
  SHARED_LANE,
} from '../repositories/agent-learnings.js';
import { lintLearning } from '../repositories/learn-lint.js';
import { getTask } from '../repositories/tasks.js';
import { revParseHead } from '../task-engine/git.js';
import { badRequest, notFound, ServiceError } from '../services/errors.js';

const logger = childLogger('routes/learnings');
export const router = express.Router();

// The PR-review learning lane in the shared agent_learnings store (folded in
// from the old standalone review_learnings table — see spec/agent-learnings-store.md Task 9).
const REVIEW_LANE = 'review';
const REVIEW_LIST_LIMIT = 50;

// GET /api/repos/:repoPath/learnings — list review learnings for a repo (frontend Settings panel).
// Response shape is preserved for the existing frontend consumer (LearningsPanel).
router.get('/api/repos/:repoPath/learnings', (req: Request, res: Response) => {
  const repoPath = decodeURIComponent((req.params as Record<string, string>).repoPath);
  const rows = listForRead(repoPath, REVIEW_LANE, { limit: REVIEW_LIST_LIMIT });
  res.json(
    rows.map((r) => ({
      id: r.id,
      repo_path: r.repo_path,
      why: r.lesson,
      created_from_comment_id: r.evidence === REVIEW_LANE ? null : r.evidence,
      usage_count: r.usage_count,
      last_used_at: r.last_used_at,
      created_at: r.created_at,
    })),
  );
});

// DELETE /api/learnings/:id — delete a single learning
router.delete('/api/learnings/:id', (req: Request, res: Response) => {
  const id = (req.params as Record<string, string>).id;
  deleteLearning(id);
  res.status(204).send();
});

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

  const task = getTask(q.taskId);
  if (!task) throw notFound('Task not found');

  const rows = searchForRead(task.repo_path, laneFor(task), q.query);
  for (const r of rows) touchLearning(r.id);
  logger.info({ task_id: task.id, count: rows.length }, 'learnings recalled');
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
