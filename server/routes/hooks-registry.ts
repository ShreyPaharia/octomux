import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { octomuxRoot } from '../octomux-root.js';
import { childLogger } from '../logger.js';
import { invalidateHookEnabledCache } from '../hook-dispatcher.js';
import {
  listActiveRepoPaths,
  getHookEnabled as getHookEnabledRepo,
  upsertHookSetting,
} from '../repositories/index.js';
import { badRequest, ServiceError } from '../services/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiLogger = childLogger('api');

export const router = express.Router();

const ALL_HOOK_EVENTS = [
  'workflow_status_changed',
  'summary_updated',
  'note_added',
  'ref_added',
  'ref_removed',
  'task_created',
  'runtime_state_changed',
] as const;

const isProduction = process.env.NODE_ENV === 'production';
const hooksLogsDir = isProduction
  ? path.join(octomuxRoot(), 'logs', 'hooks')
  : path.join(__dirname, '..', '..', 'data', 'logs', 'hooks');

interface HookRegistryEntry {
  scope: 'global' | `repo:${string}` | 'builtin';
  key: string;
  event: string | null;
  script_path: string | null;
  description: string | null;
  enabled: boolean;
  requires_env: string | null;
  last_run_at: string | null;
  last_exit_code: number | null;
}

/** Parse the most-recent log file for a given event+script-basename. */
function findLastRunMeta(
  event: string,
  scriptName: string,
): { last_run_at: string | null; last_exit_code: number | null } {
  try {
    if (!fs.existsSync(hooksLogsDir)) return { last_run_at: null, last_exit_code: null };
    const prefix = `${event}-`;
    const suffix = `-${scriptName}`;
    const files = fs
      .readdirSync(hooksLogsDir)
      .filter(
        (f) => f.startsWith(prefix) && (f.endsWith(`${suffix}.log`) || f.includes(`${suffix}-`)),
      )
      .map((f) => {
        try {
          return { f, mtime: fs.statSync(path.join(hooksLogsDir, f)).mtimeMs };
        } catch {
          return { f, mtime: 0 };
        }
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return { last_run_at: null, last_exit_code: null };

    const logPath = path.join(hooksLogsDir, files[0].f);
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    const headerLine = lines.find((l) => l.startsWith('[octomux] event='));
    const footerLine = lines.slice(1).find((l) => l.startsWith('[octomux] duration_ms='));

    let last_run_at: string | null = null;
    let last_exit_code: number | null = null;

    if (headerLine) {
      const m = headerLine.match(/started_at=(\d+)/);
      if (m) last_run_at = new Date(parseInt(m[1], 10)).toISOString();
    }
    if (footerLine) {
      const ec = footerLine.match(/exit_code=(-?\d+)/);
      if (ec) last_exit_code = parseInt(ec[1], 10);
    }
    return { last_run_at, last_exit_code };
  } catch {
    return { last_run_at: null, last_exit_code: null };
  }
}

/** Read enabled state from hook_settings; missing row = defaultEnabled. */
function getHookEnabled(scope: string, key: string, defaultEnabled: boolean): boolean {
  return getHookEnabledRepo(scope, key, defaultEnabled);
}

/** Discover scripts for all events under a hooks base directory. */
function discoverHookScripts(
  hooksBase: string,
  scope: HookRegistryEntry['scope'],
): HookRegistryEntry[] {
  const entries: HookRegistryEntry[] = [];
  for (const event of ALL_HOOK_EVENTS) {
    const dir = path.join(hooksBase, `${event}.d`);
    try {
      if (!fs.existsSync(dir)) continue;
      const files = fs
        .readdirSync(dir)
        .filter((name) => {
          try {
            return fs.statSync(path.join(dir, name)).isFile();
          } catch {
            return false;
          }
        })
        .sort();
      for (const name of files) {
        const key = `${event}/${name}`;
        const runMeta = findLastRunMeta(event, name);
        entries.push({
          scope,
          key,
          event,
          script_path: path.join(dir, name),
          description: null,
          enabled: getHookEnabled(scope, key, true),
          requires_env: null,
          last_run_at: runMeta.last_run_at,
          last_exit_code: runMeta.last_exit_code,
        });
      }
    } catch {
      // skip unreadable dirs
    }
  }
  return entries;
}

router.get('/api/hooks/templates', async (_req: Request, res: Response) => {
  const { listHookTemplates, isHookTemplateInstalled } = await import('../hooks-install.js');
  const templates = listHookTemplates().map((id) => ({
    id,
    installed: isHookTemplateInstalled(id),
  }));
  res.json(templates);
});

router.post('/api/hooks/install', async (req: Request, res: Response) => {
  const { template } = req.body as { template?: string };
  if (!template || typeof template !== 'string') {
    throw badRequest('body must contain { template: string }');
  }
  try {
    const { installHookTemplate } = await import('../hooks-install.js');
    const files = installHookTemplate(template);
    res.json({ ok: true, files });
  } catch (err) {
    throw badRequest((err as Error).message);
  }
});

// GET /api/hooks/registry — list all hooks with enabled state
router.get('/api/hooks/registry', (_req: Request, res: Response) => {
  const entries: HookRegistryEntry[] = [];

  const builtinEnabled = getHookEnabled('builtin', 'summarize-progress', false);
  entries.push({
    scope: 'builtin',
    key: 'summarize-progress',
    event: null,
    script_path: null,
    description:
      'After each agent stop, calls Haiku to write a one-sentence progress summary to tasks.current_summary.',
    enabled: builtinEnabled,
    requires_env: process.env.ANTHROPIC_API_KEY ? null : 'ANTHROPIC_API_KEY',
    last_run_at: null,
    last_exit_code: null,
  });

  const globalHooksBase = path.join(octomuxRoot(), 'hooks');
  entries.push(...discoverHookScripts(globalHooksBase, 'global'));

  try {
    const activeTasks = listActiveRepoPaths();

    const seen = new Set<string>();
    for (const { repo_path } of activeTasks) {
      if (seen.has(repo_path)) continue;
      seen.add(repo_path);
      const scope: HookRegistryEntry['scope'] = `repo:${repo_path}`;
      const repoHooksBase = path.join(repo_path, '.octomux', 'hooks');
      entries.push(...discoverHookScripts(repoHooksBase, scope));
    }
  } catch {
    // DB error — skip repo hooks
  }

  res.json({ hooks: entries });
});

// PATCH /api/hooks/registry/:scope/:key — toggle a hook
router.patch('/api/hooks/registry/:scope/:key', (req: Request, res: Response) => {
  const params = req.params as Record<string, string>;
  const scope = decodeURIComponent(params.scope);
  const key = decodeURIComponent(params.key);
  const { enabled } = req.body as { enabled?: unknown };

  if (typeof enabled !== 'boolean') {
    throw badRequest('body must contain { enabled: boolean }');
  }

  try {
    upsertHookSetting(scope, key, enabled);
    invalidateHookEnabledCache(scope, key);
    res.json({ scope, key, enabled });
  } catch (err) {
    apiLogger.warn({ scope, key, err }, 'failed to update hook_settings');
    throw new ServiceError('failed to update hook setting', 500);
  }
});
