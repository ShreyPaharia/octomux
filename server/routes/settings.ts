import express from 'express';
import type { Request, Response } from 'express';
import { getSettings, updateSettings } from '../settings.js';
import {
  getOrCreateRepoConfig,
  updateRepoConfig,
  listRepoConfigs,
} from '../repositories/repo-config.js';
import { augmentDashboardSettings } from './_shared.js';

export const router = express.Router();

router.get('/api/settings', async (_req: Request, res: Response) => {
  try {
    const settings = await getSettings();
    const envClaudeFlags = process.env.OCTOMUX_CLAUDE_FLAGS?.trim();
    res.json({
      ...augmentDashboardSettings(settings),
      envOverrides: {
        claudeFlags: envClaudeFlags ? envClaudeFlags : null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.patch('/api/settings', async (req: Request, res: Response) => {
  try {
    const settings = await updateSettings(req.body);
    res.json(augmentDashboardSettings(settings));
  } catch (err) {
    const message = (err as Error).message;
    const clientInputError =
      message.startsWith('Invalid editor') ||
      message.startsWith('Invalid claudeFlags') ||
      message.includes('Invalid claude-code') ||
      message.includes('Invalid harnesses.claude-code');
    if (clientInputError) {
      res.status(400).json({ error: message });
    } else {
      res.status(500).json({ error: message });
    }
  }
});

// ─── Repo Config ────────────────────────────────────────────────────────────

router.get('/api/repo-configs', async (_req: Request, res: Response) => {
  try {
    const configs = listRepoConfigs();
    res.json(configs);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/api/repo-config', async (req: Request, res: Response) => {
  const repoPath = req.query.repo_path as string;
  if (!repoPath) {
    res.status(400).json({ error: 'repo_path query parameter is required' });
    return;
  }
  try {
    const config = await getOrCreateRepoConfig(repoPath);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.patch('/api/repo-config', async (req: Request, res: Response) => {
  const { repo_path, ...updates } = req.body as Record<string, unknown>;
  if (!repo_path || typeof repo_path !== 'string') {
    res.status(400).json({ error: 'repo_path is required' });
    return;
  }
  try {
    const config = updateRepoConfig(repo_path, updates);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
