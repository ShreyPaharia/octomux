import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { childLogger } from './logger.js';
import { octomuxRoot } from './octomux-root.js';
import { getHookEnabled, getTaskExternalRefs } from './repositories/index.js';
import type { HookEventName, HookEnvelope } from './hook-types.js';

export type { HookEventName, HookEnvelope };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = childLogger('hooks');
const integLogger = childLogger('integrations');

// ─── Hook enabled/disabled cache ─────────────────────────────────────────────

/** In-memory cache: `${scope}::${key}` → enabled boolean. Invalidated on PATCH. */
const hookEnabledCache = new Map<string, boolean>();

/**
 * Look up whether a given (scope, key) pair is enabled.
 * Missing rows = enabled (back-compat default).
 * Results are cached until `invalidateHookEnabledCache` is called.
 */
export function isHookEnabled(scope: string, key: string): boolean {
  const cacheKey = `${scope}::${key}`;
  if (hookEnabledCache.has(cacheKey)) {
    return hookEnabledCache.get(cacheKey)!;
  }
  const result = getHookEnabled(scope, key, true);
  hookEnabledCache.set(cacheKey, result);
  return result;
}

/**
 * Invalidate the cache for a specific (scope, key) pair, or the entire cache
 * when called with no arguments. Called after PATCH /api/hooks/registry.
 */
export function invalidateHookEnabledCache(scope?: string, key?: string): void {
  if (scope !== undefined && key !== undefined) {
    hookEnabledCache.delete(`${scope}::${key}`);
  } else {
    hookEnabledCache.clear();
  }
}

const isProduction = process.env.NODE_ENV === 'production';

function resolveHooksLogsDir(): string {
  return isProduction
    ? path.join(octomuxRoot(), 'logs', 'hooks')
    : path.join(__dirname, '..', 'data', 'logs', 'hooks');
}

function resolveHookDirs(event: HookEventName, taskRepoPath?: string): string[] {
  const dirs: string[] = [];

  // Global hooks dir
  const globalDir = path.join(octomuxRoot(), 'hooks', `${event}.d`);
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

/** Default number of log files to retain per (event, script-basename) combo. */
const DEFAULT_LOG_RETAIN = 50;

function logRetainCount(): number {
  const v = parseInt(process.env.OCTOMUX_HOOK_LOG_RETAIN ?? String(DEFAULT_LOG_RETAIN), 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_LOG_RETAIN;
}

/**
 * Prune oldest log files for a given event+script prefix, keeping the N most
 * recent.  Idempotent; ignores any FS errors.
 */
function pruneOldLogs(logsDir: string, event: string, scriptBaseName: string): void {
  try {
    const retain = logRetainCount();
    const prefix = `${event}-`;
    // suffix pattern: "-<scriptBaseName>.log" (task_id suffix optional between script name and .log)
    const suffix = `-${scriptBaseName}`;
    const files = fs
      .readdirSync(logsDir)
      .filter(
        (f) => f.startsWith(prefix) && (f.endsWith(`${suffix}.log`) || f.includes(`${suffix}-`)),
      )
      .map((f) => {
        const fullPath = path.join(logsDir, f);
        try {
          return { name: f, mtime: fs.statSync(fullPath).mtimeMs };
        } catch {
          return { name: f, mtime: 0 };
        }
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first

    if (files.length <= retain) return;
    for (const f of files.slice(retain)) {
      try {
        fs.unlinkSync(path.join(logsDir, f.name));
      } catch {
        // best effort
      }
    }
  } catch {
    // never propagate
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
  const startedAt = Date.now();
  const baseName = path.basename(scriptPath);
  const taskId = envelope.task?.id;
  // Include task_id in filename when available so the REST endpoint can filter by task.
  const taskSuffix = taskId ? `-${taskId}` : '';
  const logFile = path.join(logsDir, `${envelope.event}-${startedAt}-${baseName}${taskSuffix}.log`);

  return new Promise<void>((resolve) => {
    let timedOut = false;
    let proc: ReturnType<typeof spawn> | null = null;

    try {
      fs.mkdirSync(logsDir, { recursive: true });
      const logStream = fs.createWriteStream(logFile, { flags: 'a' });

      // Write enriched header line for later parsing.
      const headerLine = `[octomux] event=${envelope.event} script=${baseName} task_id=${taskId ?? ''} started_at=${startedAt}\n`;
      logStream.write(headerLine);

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
          { script: scriptPath, task_id: taskId, event: envelope.event },
          'hook script timed out',
        );
        // Append footer with timed-out indicator
        try {
          const duration = Date.now() - startedAt;
          logStream.write(`\n[octomux] duration_ms=${duration} exit_code=timeout\n`);
        } catch {
          /* best effort */
        }
        resolve();
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (!timedOut) {
          const duration = Date.now() - startedAt;
          // Append footer with exit code and duration for later parsing.
          try {
            logStream.write(`\n[octomux] duration_ms=${duration} exit_code=${code ?? -1}\n`);
          } catch {
            /* best effort */
          }
          if (code !== 0) {
            logger.warn(
              { script: scriptPath, task_id: taskId, event: envelope.event, exit_code: code },
              'hook script exited with non-zero code',
            );
          } else {
            logger.debug(
              { script: scriptPath, task_id: taskId, event: envelope.event },
              'hook script completed',
            );
          }
          // Prune old logs after writing the new one.
          pruneOldLogs(logsDir, envelope.event, baseName);
          resolve();
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        logger.warn(
          { script: scriptPath, task_id: taskId, event: envelope.event, err },
          'hook script spawn error',
        );
        try {
          logStream.write(`\n[octomux] duration_ms=${Date.now() - startedAt} exit_code=-1\n`);
        } catch {
          /* best effort */
        }
        pruneOldLogs(logsDir, envelope.event, baseName);
        resolve();
      });
    } catch (err) {
      logger.warn(
        { script: scriptPath, task_id: taskId, event: envelope.event, err },
        'hook script setup error',
      );
      resolve();
    }
  });
}

/**
 * Fire UI-configured integration providers for the given event.
 * Providers run first (in instance creation order), then shell scripts.
 * All errors are isolated per provider; never throws.
 */
/**
 * Load external refs for a task from the DB, parsing the JSON metadata column.
 * Returns an empty array if the DB is unavailable or the task has no refs.
 */
function loadTaskExternalRefs(taskId: string): import('./types.js').TaskExternalRef[] {
  try {
    return getTaskExternalRefs(taskId);
  } catch {
    return [];
  }
}

async function fireIntegrationProviders(
  event: HookEventName,
  envelope: HookEnvelope,
): Promise<void> {
  // Lazily import to avoid circular dependency at module load time.
  let listIntegrations: typeof import('./integrations/store.js').listIntegrations;
  let getProvider: typeof import('./integrations/registry.js').getProvider;
  try {
    ({ listIntegrations } = await import('./integrations/store.js'));
    ({ getProvider } = await import('./integrations/registry.js'));
  } catch {
    // integrations module not available (e.g. test env without DB)
    return;
  }

  let integrations: import('./integrations/types.js').Integration[];
  try {
    integrations = listIntegrations();
  } catch {
    // DB may not be initialized yet
    return;
  }

  // Ensure external_refs (with parsed metadata) are available for provider handlers.
  // Callers typically spread the task row which lacks this relation, so we hydrate it here.
  const enrichedEnvelope: HookEnvelope =
    envelope.task?.id && !envelope.task.external_refs
      ? {
          ...envelope,
          task: {
            ...envelope.task,
            external_refs: loadTaskExternalRefs(envelope.task.id),
          },
        }
      : envelope;

  const timeoutMs = parseInt(process.env.OCTOMUX_HOOK_TIMEOUT_MS ?? '30000', 10);

  for (const integration of integrations) {
    if (!integration.enabled) continue;
    const provider = getProvider(integration.kind);
    if (!provider) continue;
    if (!provider.events.includes(event)) continue;

    let resolvedConfig: unknown;
    try {
      const { resolveEnvVars } = await import('./integrations/resolve-env.js');
      resolvedConfig = resolveEnvVars(integration.config);
    } catch {
      resolvedConfig = integration.config;
    }

    try {
      await Promise.race([
        provider.handler(enrichedEnvelope, resolvedConfig),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('provider handler timed out')), timeoutMs),
        ),
      ]);
    } catch (err) {
      integLogger.warn(
        {
          integration_id: integration.id,
          kind: integration.kind,
          event,
          err: err instanceof Error ? err.message : String(err),
        },
        'integration provider handler failed or timed out',
      );
    }
  }
}

// ─── Hook execution log reader ────────────────────────────────────────────────

export interface HookExecution {
  event: string;
  script: string; // basename
  started_at: string; // ISO string derived from filename timestamp
  duration_ms: number | null;
  exit_code: number | null;
  log_path: string;
  stdout_excerpt: string; // first 500 chars after header
  stderr_excerpt: string; // empty string (logs merge stdout+stderr)
}

/**
 * Parse the enriched header line written by runScript.
 * Header format: `[octomux] event=... script=... task_id=... started_at=...`
 * Footer format: `[octomux] duration_ms=... exit_code=...`
 */
function parseHookLog(logPath: string): {
  event: string;
  script: string;
  taskId: string;
  startedAt: number;
  durationMs: number | null;
  exitCode: number | null;
  excerpt: string;
} | null {
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    // Find header line
    const headerLine = lines.find((l) => l.startsWith('[octomux] event='));
    if (!headerLine) return null;

    const get = (key: string): string => {
      const m = headerLine.match(new RegExp(`${key}=([^\\s]+)`));
      return m?.[1] ?? '';
    };

    const event = get('event');
    const script = get('script');
    const taskId = get('task_id');
    const startedAt = parseInt(get('started_at'), 10) || 0;

    // Find footer line
    const footerLine = lines.slice(1).find((l) => l.startsWith('[octomux] duration_ms='));
    let durationMs: number | null = null;
    let exitCode: number | null = null;
    if (footerLine) {
      const dm = footerLine.match(/duration_ms=(\d+)/);
      const ec = footerLine.match(/exit_code=(-?\d+)/);
      if (dm) durationMs = parseInt(dm[1], 10);
      if (ec) exitCode = parseInt(ec[1], 10);
    }

    // excerpt = content between header and footer, first 500 chars
    const bodyStart = content.indexOf('\n') + 1;
    const footerIdx = content.lastIndexOf('\n[octomux] duration_ms=');
    const body =
      footerIdx > bodyStart ? content.slice(bodyStart, footerIdx) : content.slice(bodyStart);
    const excerpt = body.slice(0, 500);

    return { event, script, taskId, startedAt, durationMs, exitCode, excerpt };
  } catch {
    return null;
  }
}

/**
 * Return recent hook executions for a given task, newest first.
 * Reads log files from the hooks logs directory and filters to those tagged
 * with the task_id (either in the filename or in the header line).
 */
export function getTaskHookExecutions(taskId: string, limit = 50): HookExecution[] {
  const logsDir = resolveHooksLogsDir();
  try {
    if (!fs.existsSync(logsDir)) return [];
    const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log'));

    const results: HookExecution[] = [];
    for (const file of files) {
      const logPath = path.join(logsDir, file);
      // Quick filename filter: if task_id is in filename, accept; otherwise parse to check.
      const likelyMatch = file.includes(taskId);
      const parsed = parseHookLog(logPath);
      if (!parsed) continue;
      if (!likelyMatch && parsed.taskId !== taskId) continue;
      if (parsed.taskId && parsed.taskId !== taskId) continue;

      results.push({
        event: parsed.event,
        script: parsed.script,
        started_at: new Date(parsed.startedAt).toISOString(),
        duration_ms: parsed.durationMs,
        exit_code: parsed.exitCode,
        log_path: logPath,
        stdout_excerpt: parsed.excerpt,
        stderr_excerpt: '',
      });
    }

    // Sort newest first by started_at
    results.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
    return results.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Fire hook scripts for the given event. Non-blocking — callers should NOT await this.
 * All errors are isolated per script; fireHook never throws.
 */
export async function fireHook(event: HookEventName, envelope: HookEnvelope): Promise<void> {
  try {
    // Fire UI-configured providers first (in creation order).
    await fireIntegrationProviders(event, envelope);

    const taskRepoPath = envelope.task?.repo_path ?? undefined;
    const worktreePath = (envelope.task as Record<string, unknown>)?.worktree as string | undefined;
    const cwd = worktreePath ?? taskRepoPath ?? os.homedir();
    const logsDir = resolveHooksLogsDir();

    const globalHooksBase = path.join(octomuxRoot(), 'hooks');
    const hookDirs = resolveHookDirs(event, taskRepoPath);
    // Track which dir each script came from so we can build the correct scope.
    const scriptsWithScope: Array<{ script: string; scope: string }> = [];
    for (const dir of hookDirs) {
      const discovered = discoverScripts(dir);
      for (const script of discovered) {
        // Determine scope: global or repo:<absolute-path>
        const isGlobal = dir.startsWith(globalHooksBase);
        const scope = isGlobal ? 'global' : taskRepoPath ? `repo:${taskRepoPath}` : 'global';
        scriptsWithScope.push({ script, scope });
      }
    }

    if (scriptsWithScope.length === 0) return;

    const env: NodeJS.ProcessEnv = {
      OCTOMUX_EVENT: event,
      OCTOMUX_TASK_ID: envelope.task?.id ?? '',
      OCTOMUX_HOOK_DIR: hookDirs[0],
    };

    logger.debug(
      { event, task_id: envelope.task?.id, script_count: scriptsWithScope.length },
      'firing hooks',
    );

    for (const { script, scope } of scriptsWithScope) {
      const key = `${event}/${path.basename(script)}`;
      if (!isHookEnabled(scope, key)) {
        logger.debug({ scope, key, event }, 'hook skipped (disabled)');
        continue;
      }
      await runScript(script, envelope, env, cwd, logsDir);
    }
  } catch (err) {
    // Never propagate hook errors to callers
    logger.error({ event, err }, 'fireHook: unexpected error');
  }
}
