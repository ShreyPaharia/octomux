import express from 'express';
import type { Request, Response } from 'express';
import { getReviewRun, getCurrentRun, setWalkthrough } from '../repositories/review-runs.js';
import { listPublishedReviews } from '../repositories/published-reviews.js';
import { triggerReviewRun } from '../services/review-service.js';
import { loadTaskOrFail, deepMerge } from './_shared.js';

export const router = express.Router();

// PATCH /api/tasks/:id/review-runs/:rid/walkthrough — deep-merge walkthrough
router.patch('/api/tasks/:id/review-runs/:rid/walkthrough', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;

  const params = req.params as Record<string, string>;
  const rid = params.rid;

  const run = getReviewRun(rid);
  if (!run || run.task_id !== task.id) {
    res.status(404).json({ error: 'Review run not found' });
    return;
  }

  // Refuse if a published_reviews row exists for this run's pr_head_sha
  const published = listPublishedReviews(task.id);
  const alreadyPublished = published.some((p) => p.head_sha === run.pr_head_sha);
  if (alreadyPublished) {
    res.status(409).json({ error: 'Review already published for this head SHA' });
    return;
  }

  // Deep-merge incoming body into existing walkthrough JSON
  const existing = run.walkthrough ? JSON.parse(run.walkthrough) : {};
  const incoming = req.body as Record<string, unknown>;
  const merged = deepMerge(existing, incoming);
  setWalkthrough(rid, JSON.stringify(merged));

  const updated = getReviewRun(rid);
  res.json(updated);
});

// POST /api/tasks/:id/review-runs — trigger a manual re-review
router.post('/api/tasks/:id/review-runs', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;

  // 409 if a run with status='running' already exists for this task
  const currentRun = getCurrentRun(task.id);
  if (currentRun?.status === 'running') {
    res.status(409).json({ error: 'A review run is already in progress' });
    return;
  }

  try {
    await triggerReviewRun(task);
    res.status(202).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/tasks/:id/publish-review — publish accepted draft comments to GitHub
router.post('/api/tasks/:id/publish-review', async (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;

  const body = req.body as { verdict?: unknown; review_body?: unknown };
  const verdict = body.verdict ?? 'COMMENT';

  if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(verdict as string)) {
    res.status(400).json({ error: 'verdict must be one of COMMENT, APPROVE, REQUEST_CHANGES' });
    return;
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
      res.status(400).json({ error: msg });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});
