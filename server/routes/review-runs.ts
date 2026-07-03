import express from 'express';
import type { Request, Response } from 'express';
import { getReviewRun, getCurrentRun, setWalkthrough } from '../repositories/review-runs.js';
import { listPublishedReviews } from '../repositories/published-reviews.js';
import { triggerReviewRun } from '../services/review-service.js';
import { loadTaskOrFail, deepMerge } from './_shared.js';
import { badRequest, conflict, notFound } from '../services/errors.js';

export const router = express.Router();

router.patch('/api/tasks/:id/review-runs/:rid/walkthrough', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);

  const params = req.params as Record<string, string>;
  const rid = params.rid;

  const run = getReviewRun(rid);
  if (!run || run.task_id !== task.id) {
    throw notFound('Review run not found');
  }

  const published = listPublishedReviews(task.id);
  const alreadyPublished = published.some((p) => p.head_sha === run.pr_head_sha);
  if (alreadyPublished) {
    throw conflict('Review already published for this head SHA');
  }

  const existing = run.walkthrough ? JSON.parse(run.walkthrough) : {};
  const incoming = req.body as Record<string, unknown>;
  const merged = deepMerge(existing, incoming);
  setWalkthrough(rid, JSON.stringify(merged));

  const updated = getReviewRun(rid);
  res.json(updated);
});

router.post('/api/tasks/:id/review-runs', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);

  const currentRun = getCurrentRun(task.id);
  if (currentRun?.status === 'running') {
    throw conflict('A review run is already in progress');
  }

  await triggerReviewRun(task);
  res.status(202).json({ ok: true });
});

router.post('/api/tasks/:id/publish-review', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req);

  const body = req.body as { verdict?: unknown; review_body?: unknown };
  const verdict = body.verdict ?? 'COMMENT';

  if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(verdict as string)) {
    throw badRequest('verdict must be one of COMMENT, APPROVE, REQUEST_CHANGES');
  }

  try {
    const { publishReview } = await import('../publish-review.js');
    const result = await publishReview(
      task.id,
      verdict as import('../types.js').PublishedReviewVerdict,
      typeof body.review_body === 'string' ? body.review_body : '',
    );
    res.json(result);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('No accepted comments')) {
      throw badRequest(msg);
    }
    throw err;
  }
});
