import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { childLogger } from './logger.js';
import type { HookEventName, HookEnvelope } from './hook-types.js';

export type { HookEventName, HookEnvelope };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = childLogger('hooks');

const isProduction = process.env.NODE_ENV === 'production';

function resolveHooksLogsDir(): string {
  return isProduction
    ? path.join(os.homedir(), '.octomux', 'logs', 'hooks')
    : path.join(__dirname, '..', 'data', 'logs', 'hooks');
}

function resolveHookDirs(event: HookEventName, taskRepoPath?: string): string[] {
  const dirs: string[] = [];

  // Global hooks dir
  const globalDir = path.join(os.homedir(), '.octomux', 'hooks', `${event}.d`);
  dirs.push(globalDir);

  // Repo-local hooks dir
  if (taskRepoPath) {
    const repoDir = path.join(taskRepoPath, '.octomux', 'hooks', `${event}.d`);
    dirs.push(repoDir);
  }

  return dirs;
}

/** Discover executable scripts in a directory, sorted alphabetically. */
function discoverScripts(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => {
        if (!e.isFile()) return false;
        try {
          fs.accessSync(path.join(dir, e.name), fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      })
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/** Run a single hook script. Never throws. */
async function runScript(
  scriptPath: string,
  envelope: HookEnvelope,
  env: NodeJS.ProcessEnv,
  cwd: string,
  logsDir: string,
): Promise<void> {
  const timeoutMs = parseInt(process.env.OCTOMUX_HOOK_TIMEOUT_MS ?? '30000', 10);
  const timestamp = Date.now();
  const baseName = path.basename(scriptPath);
  const logFile = path.join(logsDir, `${envelope.event}-${timestamp}-${baseName}.log`);

  return new Promise<void>((resolve) => {
    let timedOut = false;
    let proc: ReturnType<typeof spawn> | null = null;

    try {
      fs.mkdirSync(logsDir, { recursive: true });
      const logStream = fs.createWriteStream(logFile, { flags: 'a' });

      proc = spawn(scriptPath, [], {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdinData = JSON.stringify(envelope);
      proc.stdin?.write(stdinData, 'utf8');
      proc.stdin?.end();

      proc.stdout?.pipe(logStream);
      proc.stderr?.pipe(logStream);

      const timer = setTimeout(() => {
        timedOut = true;
        proc?.kill('SIGTERM');
        logger.warn(
          { script: scriptPath, task_id: envelope.task?.id, event: envelope.event },
          'hook script timed out',
        );
        resolve();
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (!timedOut) {
          if (code !== 0) {
            logger.warn(
              { script: scriptPath, task_id: envelope.task?.id, event: envelope.event, exit_code: code },
              'hook script exited with non-zero code',
            );
          } else {
            logger.debug(
              { script: scriptPath, task_id: envelope.task?.id, event: envelope.event },
              'hook script completed',
            );
          }
          resolve();
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        logger.warn(
          { script: scriptPath, task_id: envelope.task?.id, event: envelope.event, err },
          'hook script spawn error',
        );
        resolve();
      });
    } catch (err) {
      logger.warn(
        { script: scriptPath, task_id: envelope.task?.id, event: envelope.event, err },
        'hook script setup error',
      );
      resolve();
    }
  });
}

/**
 * Fire hook scripts for the given event. Non-blocking — callers should NOT await this.
 * All errors are isolated per script; fireHook never throws.
 */
export async function fireHook(event: HookEventName, envelope: HookEnvelope): Promise<void> {
  try {
    const taskRepoPath = envelope.task?.repo_path ?? undefined;
    const worktreePath = (envelope.task as Record<string, unknown>)?.worktree as string | undefined;
    const cwd = worktreePath ?? taskRepoPath ?? os.homedir();
    const logsDir = resolveHooksLogsDir();

    const hookDirs = resolveHookDirs(event, taskRepoPath);
    const scripts: string[] = [];
    for (const dir of hookDirs) {
      scripts.push(...discoverScripts(dir));
    }

    if (scripts.length === 0) return;

    const env: NodeJS.ProcessEnv = {
      OCTOMUX_EVENT: event,
      OCTOMUX_TASK_ID: envelope.task?.id ?? '',
      OCTOMUX_HOOK_DIR: hookDirs[0],
    };

    logger.debug(
      { event, task_id: envelope.task?.id, script_count: scripts.length },
      'firing hooks',
    );

    for (const script of scripts) {
      await runScript(script, envelope, env, cwd, logsDir);
    }
  } catch (err) {
    // Never propagate hook errors to callers
    logger.error({ event, err }, 'fireHook: unexpected error');
  }
}
