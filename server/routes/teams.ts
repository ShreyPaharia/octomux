import express from 'express';
import type { Request, Response } from 'express';
import { badRequest } from '../services/errors.js';

export const router = express.Router();

router.post('/api/teams/run', async (req: Request, res: Response) => {
  const { name, repo_path } = req.body as { name?: string; repo_path?: string };
  if (!name) {
    throw badRequest('name is required');
  }
  if (!repo_path) {
    throw badRequest('repo_path is required');
  }
  try {
    const { runTeam } = await import('../teams.js');
    const taskId = await runTeam({ name, repoPath: repo_path });
    res.status(201).json({ task_id: taskId });
  } catch (err) {
    throw badRequest((err as Error).message);
  }
});

router.post('/api/teams/schedule', async (req: Request, res: Response) => {
  const { name, repo_path, cron } = req.body as {
    name?: string;
    repo_path?: string;
    cron?: string;
  };
  if (!name) {
    throw badRequest('name is required');
  }
  if (!repo_path) {
    throw badRequest('repo_path is required');
  }
  if (!cron) {
    throw badRequest('cron is required');
  }
  try {
    const { upsertTeamSchedule } = await import('../teams.js');
    upsertTeamSchedule({ name, repoPath: repo_path, cron });
    res.status(200).json({ ok: true });
  } catch (err) {
    throw badRequest((err as Error).message);
  }
});

router.get('/api/teams', async (_req: Request, res: Response) => {
  const { listTeamSchedules } = await import('../teams.js');
  const schedules = listTeamSchedules();
  res.json(schedules);
});
