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
import { badRequest, notFound, ServiceError } from '../services/errors.js';

const execFile = promisify(execFileCb);
const logger = childLogger('api:reviews');

export const router = express.Router();

router.get('/api/reviews', (_req: Request, res: Response) => {
  res.json(listReviewsInbox());
});

router.get('/api/reviews/:id', (req: Request, res: Response) => {
  const detail = getReviewDetail((req.params as Record<string, string>).id);
  if (!detail) {
    throw notFound('Review not found');
  }
  res.json(detail);
});

router.post('/api/reviews', async (req: Request, res: Response) => {
  const body = req.body as { pr_url?: unknown; repo_path?: unknown };
  const prUrl = typeof body.pr_url === 'string' ? body.pr_url.trim() : '';
  const bodyRepoPath = typeof body.repo_path === 'string' ? body.repo_path.trim() : '';

  const prMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!prMatch) {
    throw badRequest('invalid pr_url');
  }
  const [, owner, repo, numberStr] = prMatch;
  const number = parseInt(numberStr, 10);
  const ownerRepo = `${owner}/${repo}`;

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
    throw badRequest(`could not resolve a local repo for ${ownerRepo}; pass repo_path`);
  }

  const existing = findExistingReviewTask(repoPath, number);

  if (existing) {
    res.status(200).json({ id: existing.id, reused: true });
    return;
  }

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
    throw badRequest(`failed to fetch PR metadata: ${(err as Error).message}`);
  }

  if (pr.state !== 'OPEN') {
    throw badRequest(`PR #${number} is ${pr.state}`);
  }

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

router.post('/api/tasks/:taskId/review', async (req: Request, res: Response) => {
  const taskId = (req.params as Record<string, string>).taskId;
  const task = getTaskRepo(taskId);
  if (!task) {
    throw notFound('Task not found');
  }

  if (!task.branch || !task.worktree) {
    throw badRequest('Start the task first');
  }

  const existingId = lookupExistingReviewId(task);
  if (existingId) {
    res.status(200).json({ id: existingId, action: 'existing' });
    return;
  }

  let prHeadSha = task.pr_head_sha;
  if (!prHeadSha) {
    const cwd = taskWorkingDir(task);
    try {
      const { stdout } = await execFile('git', ['-C', cwd!, 'rev-parse', 'HEAD']);
      prHeadSha = stdout.trim();
    } catch (err) {
      throw new ServiceError(`failed to resolve HEAD: ${(err as Error).message}`, 500);
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
