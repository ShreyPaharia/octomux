import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { getDataDir, pingDb } from '../db.js';
import { childLogger } from '../logger.js';
import { countRunningTasks, listRecentRepoPaths } from '../repositories/index.js';
import { listHarnesses } from '../harnesses/index.js';
import { badRequest, ServiceError } from '../services/errors.js';

const execFile = promisify(execFileCb);
const healthLogger = childLogger('health');

export const router = express.Router();

router.get('/api/health', (_req: Request, res: Response) => {
  const uptime = process.uptime();
  const data_dir = getDataDir();

  let db: { ok: true } | { ok: false; error: string };
  let running_tasks = 0;
  try {
    pingDb();
    db = { ok: true };
    running_tasks = countRunningTasks();
  } catch (err) {
    db = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const status = db.ok ? 'ok' : 'degraded';
  if (db.ok) {
    healthLogger.info({ operation: 'health', status, db_ok: true, running_tasks }, 'health check');
  } else {
    healthLogger.warn(
      { operation: 'health', status, db_ok: false, error: db.error },
      'health check degraded',
    );
  }

  res.status(db.ok ? 200 : 503).json({ status, uptime, db, running_tasks, data_dir });
});

router.get('/api/harnesses', (_req: Request, res: Response) => {
  res.json(
    listHarnesses().map(({ id, displayName, sessionIdMode }) => ({
      id,
      displayName,
      sessionIdMode,
    })),
  );
});

router.get('/api/browse', async (req: Request, res: Response) => {
  const dirPath = (req.query.path as string) || os.homedir();

  try {
    const stat = await fs.promises.stat(dirPath);
    if (!stat.isDirectory()) {
      throw badRequest('Path is not a directory');
    }
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    throw badRequest('Path does not exist');
  }

  const dirEntries = await fs.promises.readdir(dirPath);
  const resolved = await Promise.all(
    dirEntries.map(async (name): Promise<{ name: string; path: string; isGit: boolean } | null> => {
      const fullPath = path.join(dirPath, name);
      try {
        const stat = await fs.promises.stat(fullPath);
        if (!stat.isDirectory()) return null;
        const isGit = await fs.promises
          .access(path.join(fullPath, '.git'))
          .then(() => true)
          .catch(() => false);
        return { name, path: fullPath, isGit };
      } catch {
        return null;
      }
    }),
  );
  const entries = resolved.filter(
    (e): e is { name: string; path: string; isGit: boolean } => e !== null,
  );

  entries.sort((a, b) => {
    if (a.isGit !== b.isGit) return a.isGit ? -1 : 1;
    const aHidden = a.name.startsWith('.');
    const bHidden = b.name.startsWith('.');
    if (aHidden !== bHidden) return aHidden ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  const parent = path.dirname(dirPath);
  res.json({
    current: dirPath,
    parent: parent !== dirPath ? parent : null,
    entries,
  });
});

router.get('/api/branches', async (req: Request, res: Response) => {
  const repoPath = req.query.repo_path as string;
  if (!repoPath) {
    throw badRequest('repo_path is required');
  }

  try {
    const { stdout } = await execFile('git', [
      '-C',
      repoPath,
      'branch',
      '-a',
      '--format=%(refname:short)',
    ]);
    const branches = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((b) => b.replace(/^origin\//, ''));
    const unique = [...new Set(branches)].filter((b) => b !== 'HEAD');
    res.json(unique);
  } catch {
    throw badRequest('Failed to list branches');
  }
});

router.get('/api/preflight/none-mode', async (req: Request, res: Response) => {
  const repoPath = String(req.query.repo_path ?? '');
  const baseBranch = String(req.query.base_branch ?? '');
  if (!repoPath || !baseBranch) {
    throw badRequest('repo_path and base_branch are required');
  }
  try {
    const { preflightNoneMode } = await import('../preflight.js');
    const result = await preflightNoneMode(repoPath, baseBranch);
    res.json(result);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
});

router.post('/api/preflight/stash', async (req: Request, res: Response) => {
  const repoPath = String(req.body?.repo_path ?? '');
  const targetBranch = String(req.body?.target_branch ?? '');
  if (!repoPath || !targetBranch) {
    throw badRequest('repo_path and target_branch are required');
  }
  try {
    await execFile('git', [
      '-C',
      repoPath,
      'stash',
      'push',
      '-u',
      '-m',
      `octomux: auto-stash before switching to ${targetBranch}`,
    ]);
    res.json({ ok: true });
  } catch (err) {
    throw badRequest((err as Error).message);
  }
});

router.get('/api/default-branch', async (req: Request, res: Response) => {
  const repoPath = req.query.repo_path as string;
  if (!repoPath) {
    throw badRequest('repo_path is required');
  }

  try {
    const { stdout } = await execFile('git', [
      '-C',
      repoPath,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
    ]);
    const branch = stdout.trim().replace('refs/remotes/origin/', '');
    res.json({ branch });
  } catch {
    res.json({ branch: 'main' });
  }
});

router.get('/api/recent-repos', (_req: Request, res: Response) => {
  res.json(listRecentRepoPaths(10));
});
