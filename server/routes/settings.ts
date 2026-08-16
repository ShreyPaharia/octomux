import express from 'express';
import type { Request, Response } from 'express';
import { getSettings, updateSettings } from '../settings.js';
import { updateRepoConfig, listRepoConfigs } from '../repositories/repo-config.js';
import { augmentDashboardSettings } from './_shared.js';
import { badRequest, ServiceError } from '../services/errors.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates only the container shape of `body.plugins` — a plain object,
 * keyed by plugin id, of plain-object blobs. A plugin's own config contents
 * are never schema-checked (opaque to the host, see settings.ts); this only
 * guards against non-object payloads (e.g. a string) silently spreading into
 * numeric-keyed junk when merged.
 */
function assertValidPluginsShape(body: unknown): void {
  if (!isPlainObject(body) || !('plugins' in body)) return;
  const { plugins } = body;
  if (!isPlainObject(plugins) || !Object.values(plugins).every(isPlainObject)) {
    throw badRequest('Invalid plugins: must be an object of objects, keyed by plugin id.');
  }
}

function throwSettingsError(err: unknown): never {
  const message = (err as Error).message;
  const clientInputError =
    message.startsWith('Invalid editor') ||
    message.startsWith('Invalid claudeFlags') ||
    message.startsWith('Invalid approvalTimeoutMs') ||
    message.startsWith('Invalid hookTimeoutMs') ||
    message.startsWith('Invalid aiTaskNaming') ||
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
  assertValidPluginsShape(req.body);
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

router.patch('/api/repo-config', async (req: Request, res: Response) => {
  const { repo_path, ...updates } = req.body as Record<string, unknown>;
  if (!repo_path || typeof repo_path !== 'string') {
    throw badRequest('repo_path is required');
  }
  const config = updateRepoConfig(repo_path, updates);
  res.json(config);
});
