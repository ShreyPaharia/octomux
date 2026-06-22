import express from 'express';
import type { Request, Response } from 'express';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { childLogger } from '../logger.js';
import { listReviewsInbox, getReviewDetail } from '../reviews-inbox.js';
import { taskWorkingDir } from '../task-paths.js';
import {
  findExistingReviewTask,
  listTrackedRepoPaths,
  getTask as getTaskRepo,
} from '../repositories/index.js';
import { createReviewTaskFromPr, createManualReview } from '../services/review-service.js';
import { lookupExistingReviewId } from './_shared.js';

const execFile = promisify(execFileCb);
const logger = childLogger('api:reviews');

export const router = express.Router();

// GET /api/reviews — list all auto_review tasks with aggregated counts
router.get('/api/reviews', (_req: Request, res: Response) => {
  try {
    res.json(listReviewsInbox());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/reviews/:id — full detail for a single review task
router.get('/api/reviews/:id', (req: Request, res: Response) => {
  try {
    const detail = getReviewDetail((req.params as Record<string, string>).id);
    if (!detail) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/reviews — create an auto_review task for a GitHub PR URL.
// Idempotent: if a live (non-deleted, non-error) review task already exists
// for the same repo+PR, returns that instead of creating a duplicate.
router.post('/api/reviews', async (req: Request, res: Response) => {
  const body = req.body as { pr_url?: unknown; repo_path?: unknown };
  const prUrl = typeof body.pr_url === 'string' ? body.pr_url.trim() : '';
  const bodyRepoPath = typeof body.repo_path === 'string' ? body.repo_path.trim() : '';

  // Parse GitHub PR URL
  const prMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!prMatch) {
    res.status(400).json({ error: 'invalid pr_url' });
    return;
  }
  const [, owner, repo, numberStr] = prMatch;
  const number = parseInt(numberStr, 10);
  const ownerRepo = `${owner}/${repo}`;

  // Resolve the local repo path
  let repoPath = bodyRepoPath;
  if (!repoPath) {
    const rows = listTrackedRepoPaths();

    for (const row of rows) {
      const candidatePath = row.repo_path;
      try {
        const { stdout } = await execFile('git', [
          '-C',
          candidatePath,
          'remote',
          'get-url',
          'origin',
        ]);
        const remoteUrl = stdout.trim();
        // Handle both ssh (git@github.com:owner/repo.git) and https
        const sshMatch = remoteUrl.match(/git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
        const httpsMatch = remoteUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
        const remoteOwnerRepo = (sshMatch?.[1] ?? httpsMatch?.[1] ?? '').toLowerCase();
        if (remoteOwnerRepo === ownerRepo.toLowerCase()) {
          repoPath = candidatePath;
          break;
        }
      } catch {
        // skip this candidate
      }
    }
  }

  if (!repoPath) {
    res.status(400).json({
      error: `could not resolve a local repo for ${ownerRepo}; pass repo_path`,
    });
    return;
  }

  // Dedup: check for an existing live review task for this repo+PR
  const existing = findExistingReviewTask(repoPath, number);

  if (existing) {
    res.status(200).json({ id: existing.id, reused: true });
    return;
  }

  // Fetch PR metadata via gh CLI
  let pr: {
    title: string;
    headRefOid: string;
    baseRefName: string;
    author: { login: string } | null;
    state: string;
    url: string;
  };
  try {
    const { stdout } = await execFile(
      'gh',
      [
        'pr',
        'view',
        String(number),
        '--repo',
        ownerRepo,
        '--json',
        'title,headRefOid,baseRefName,author,state,url',
      ],
      { cwd: repoPath },
    );
    pr = JSON.parse(stdout) as typeof pr;
  } catch (err) {
    res.status(400).json({ error: `failed to fetch PR metadata: ${(err as Error).message}` });
    return;
  }

  if (pr.state !== 'OPEN') {
    res.status(400).json({ error: `PR #${number} is ${pr.state}` });
    return;
  }

  // Create the review task (service owns the build+insert+broadcast+startTask tail).
  const { id } = await createReviewTaskFromPr({
    repo_path: repoPath,
    pr_number: number,
    pr_url: pr.url,
    pr_head_sha: pr.headRefOid,
    base_branch: pr.baseRefName,
    title: pr.title,
    author: pr.author?.login ?? null,
    requested_at: new Date().toISOString(),
  });

  logger.info(
    { task_id: id, pr_number: number, repo: ownerRepo, repo_path: repoPath },
    'review create task created',
  );

  res.status(201).json({ id, reused: false });
});

// POST /api/tasks/:taskId/review — manually trigger a review for this task.
// Creates an auto_review task pointing back at the source via review_of_task_id,
// or returns the existing review when one is already present.
router.post('/api/tasks/:taskId/review', async (req: Request, res: Response) => {
  const taskId = (req.params as Record<string, string>).taskId;
  const task = getTaskRepo(taskId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  if (!task.branch || !task.worktree) {
    res.status(400).json({ error: 'Start the task first' });
    return;
  }

  const existingId = lookupExistingReviewId(task);
  if (existingId) {
    res.status(200).json({ id: existingId, action: 'existing' });
    return;
  }

  // PR-less source: capture the current HEAD of the source worktree so the
  // review agent has a concrete sha to diff base..head against.
  let prHeadSha = task.pr_head_sha;
  if (!prHeadSha) {
    const cwd = taskWorkingDir(task);
    try {
      const { stdout } = await execFile('git', ['-C', cwd!, 'rev-parse', 'HEAD']);
      prHeadSha = stdout.trim();
    } catch (err) {
      res.status(500).json({ error: `failed to resolve HEAD: ${(err as Error).message}` });
      return;
    }
  }

  const { id: newId } = await createManualReview({
    source_task_id: task.id,
    source_title: task.title,
    repo_path: task.repo_path,
    branch: task.branch,
    base_branch: task.base_branch,
    base_sha: task.base_sha ?? null,
    pr_head_sha: prHeadSha,
    pr_url: task.pr_url ?? null,
    pr_number: task.pr_number ?? null,
    requested_at: new Date().toISOString(),
  });

  res.status(201).json({ id: newId, action: 'created' });
});
