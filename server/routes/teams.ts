import express from 'express';
import type { Request, Response } from 'express';

export const router = express.Router();

router.post('/api/teams/run', async (req: Request, res: Response) => {
  const { name, repo_path } = req.body as { name?: string; repo_path?: string };
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!repo_path) {
    res.status(400).json({ error: 'repo_path is required' });
    return;
  }
  try {
    const { runTeam } = await import('../teams.js');
    const taskId = await runTeam({ name, repoPath: repo_path });
    res.status(201).json({ task_id: taskId });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/api/teams/schedule', async (req: Request, res: Response) => {
  const { name, repo_path, cron } = req.body as {
    name?: string;
    repo_path?: string;
    cron?: string;
  };
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!repo_path) {
    res.status(400).json({ error: 'repo_path is required' });
    return;
  }
  if (!cron) {
    res.status(400).json({ error: 'cron is required' });
    return;
  }
  try {
    const { upsertTeamSchedule } = await import('../teams.js');
    upsertTeamSchedule({ name, repoPath: repo_path, cron });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.get('/api/teams', async (_req: Request, res: Response) => {
  try {
    const { listTeamSchedules } = await import('../teams.js');
    const schedules = listTeamSchedules();
    res.json(schedules);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
