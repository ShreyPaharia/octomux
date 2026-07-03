import express from 'express';
import type { Request, Response } from 'express';
import { getSettings, updateSettings } from '../settings.js';
import {
  getOrCreateRepoConfig,
  updateRepoConfig,
  listRepoConfigs,
} from '../repositories/repo-config.js';
import { augmentDashboardSettings } from './_shared.js';
import { badRequest, ServiceError } from '../services/errors.js';

function throwSettingsError(err: unknown): never {
  const message = (err as Error).message;
  const clientInputError =
    message.startsWith('Invalid editor') ||
    message.startsWith('Invalid claudeFlags') ||
    message.includes('Invalid claude-code') ||
    message.includes('Invalid harnesses.claude-code');
  if (clientInputError) {
    throw badRequest(message);
  }
  throw new ServiceError(message, 500);
}

export const router = express.Router();

router.get('/api/settings', async (_req: Request, res: Response) => {
  const settings = await getSettings();
  const envClaudeFlags = process.env.OCTOMUX_CLAUDE_FLAGS?.trim();
  res.json({
    ...augmentDashboardSettings(settings),
    envOverrides: {
      claudeFlags: envClaudeFlags ? envClaudeFlags : null,
    },
  });
});

router.patch('/api/settings', async (req: Request, res: Response) => {
  try {
    const settings = await updateSettings(req.body);
    res.json(augmentDashboardSettings(settings));
  } catch (err) {
    throwSettingsError(err);
  }
});

// ─── Repo Config ────────────────────────────────────────────────────────────

router.get('/api/repo-configs', async (_req: Request, res: Response) => {
  const configs = listRepoConfigs();
  res.json(configs);
});

router.get('/api/repo-config', async (req: Request, res: Response) => {
  const repoPath = req.query.repo_path as string;
  if (!repoPath) {
    throw badRequest('repo_path query parameter is required');
  }
  const config = await getOrCreateRepoConfig(repoPath);
  res.json(config);
});

router.patch('/api/repo-config', async (req: Request, res: Response) => {
  const { repo_path, ...updates } = req.body as Record<string, unknown>;
  if (!repo_path || typeof repo_path !== 'string') {
    throw badRequest('repo_path is required');
  }
  const config = updateRepoConfig(repo_path, updates);
  res.json(config);
});
