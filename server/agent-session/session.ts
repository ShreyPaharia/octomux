/**
 * server/agent-session/session.ts
 *
 * runAgentSession — the central primitive that assembles:
 *   - a ProcessSubstrate (pty headless or tmux reattachable) for launching the agent,
 *   - a CaptureStrategy (default: MCP submit_result) for receiving the structured result.
 *
 * DB-free by default: only type-only import of Harness; no task-engine /
 * repositories / orchestrator / task-runner imports at load time. Passing
 * `opts.run` opts a single call into `runs` persistence via a dynamic
 * `repositories/runs.js` import, so the no-run path stays untouched.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { nanoid } from 'nanoid';
import { childLogger } from '../logger.js';
import { shellQuoteSingle } from '../shell-quote.js';
import { writeSubmitResultMcpConfig } from './mcp/config.js';
import type { ProcessSubstrate } from './substrate.js';
import type { Harness } from '../harnesses/types.js';

const logger = childLogger('agent-session/session');

// ─── CaptureStrategy ─────────────────────────────────────────────────────────

export interface CaptureStrategy<T = unknown> {
  /**
   * Set up capture infrastructure. Returns extra CLI args (e.g. --mcp-config
   * <path>) and optional extra env vars to pass to the spawned process.
   */
  setup(ctx: {
    workspaceDir: string;
  }): Promise<{ extraArgs: string; env?: Record<string, string> }>;

  /**
   * Resolves when the structured result is available (e.g. the result file
   * was written by the MCP server). The caller races this against onExit + timeout.
   */
  waitForResult(): Promise<T>;

  /** Idempotent teardown: stop watchers, remove temp files, etc. */
  dispose(): void;
}

// ─── RunAgentSessionOptions ───────────────────────────────────────────────────

export interface RunAgentSessionOptions<T = unknown> {
  /** Ephemeral scratch dir OR a git worktree; no git required. */
  workspaceDir: string;
  /** Injected harness; only buildLaunchCommand + newSessionId are called. */
  harness: Harness;
  /** The prompt / task description to send to the agent. */
  input: string;
  /** Pty (headless) or tmux (reattachable) substrate — injected. */
  substrate: ProcessSubstrate;
  /** JSON Schema for the structured result the agent must submit. */
  outputSchema: object;
  model?: string | null;
  /** Override the default mcpSubmitResultCapture. */
  capture?: CaptureStrategy<T>;
  /** Max milliseconds to wait for the agent to submit a result. Default 300 000. */
  timeoutMs?: number;
  /**
   * Directory for the MCP config + result file.
   * Default: a fresh os.tmpdir() subdirectory.
   */
  resultDir?: string;
  /**
   * When set, persists a `runs` row for this session (insertRun before spawn,
   * finishRun on settle). Omit to keep this call DB-free, as today.
   */
  run?: { workflowKind: string; trigger: string; scheduleId?: string };
}

// ─── Default capture: MCP submit_result ──────────────────────────────────────

export interface McpSubmitResultCaptureOpts {
  /** Directory to place mcp-config.json + result.json. */
  resultDir: string;
}

/**
 * Create the default CaptureStrategy backed by the submit_result MCP server.
 * The agent CLI is told to load the generated mcp-config.json; the MCP server
 * subprocess writes captured results to a JSON file which we watch for.
 */
export function mcpSubmitResultCapture<T = unknown>(
  schema: object,
  opts: McpSubmitResultCaptureOpts,
): CaptureStrategy<T> {
  const { resultDir } = opts;
  let resultPath: string | null = null;
  let watcher: fs.FSWatcher | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  return {
    async setup(_ctx: { workspaceDir: string }) {
      fs.mkdirSync(resultDir, { recursive: true });
      resultPath = path.join(resultDir, 'result.json');

      const cfgPath = writeSubmitResultMcpConfig(resultDir, {
        schema,
        resultPath,
      });

      if (!cfgPath) {
        logger.warn({ resultDir }, 'submit-result MCP server not found; capture will not attach');
        return { extraArgs: '' };
      }

      logger.debug({ cfgPath, resultPath }, 'MCP submit_result capture ready');
      return { extraArgs: ` --mcp-config ${shellQuoteSingle(cfgPath)}` };
    },

    waitForResult(): Promise<T> {
      if (!resultPath) {
        return Promise.reject(new Error('capture.prepare() must be called before waitForResult()'));
      }

      const rPath = resultPath;

      return new Promise<T>((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
          if (poll) {
            clearInterval(poll);
            poll = null;
          }
          if (watcher) {
            try {
              watcher.close();
            } catch {
              // ignore
            }
            watcher = null;
          }
        };

        // Resolve/reject exactly once, tearing down both the watcher and poll.
        const settleResolve = (value: T) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };
        const settleReject = (err: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };

        // Read + parse the result file; returns true once handled (resolved or
        // rejected). Returns false if the file isn't there yet.
        const tryRead = (): boolean => {
          if (disposed) {
            settleReject(new Error('capture disposed before result'));
            return true;
          }
          if (!fs.existsSync(rPath)) return false;
          try {
            settleResolve(JSON.parse(fs.readFileSync(rPath, 'utf8')) as T);
          } catch (err) {
            settleReject(new Error(`Failed to parse result file: ${err}`));
          }
          return true;
        };

        if (disposed) {
          settleReject(new Error('capture disposed before result'));
          return;
        }

        // Race-free immediate check (covers the file already existing).
        if (tryRead()) return;

        // Belt-and-suspenders: a watcher AND a poll run concurrently. fs.watch
        // event delivery is best-effort and can be missed/delayed under load, so
        // the 100ms poll guarantees the result is picked up regardless. Whichever
        // fires first settles; cleanup() tears down both.
        poll = setInterval(tryRead, 100);
        try {
          watcher = fs.watch(path.dirname(rPath), (_event, filename) => {
            if (filename && filename !== path.basename(rPath)) return;
            tryRead();
          });
        } catch (err) {
          // Watch unavailable in some environments — the poll still covers us.
          logger.debug({ err }, 'fs.watch unavailable; relying on poll');
        }
      });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
      try {
        watcher?.close();
      } catch {
        // ignore
      }
      watcher = null;
      // Best-effort cleanup of the result dir
      if (resultDir) {
        try {
          fs.rmSync(resultDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    },
  };
}

// ─── runAgentSession ──────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000;

const SUBMIT_RESULT_INSTRUCTION = `

IMPORTANT: You MUST call the submit_result tool exactly once with your final
structured answer before exiting. The answer must conform to the required JSON
Schema. Do not exit the session without calling submit_result.
`;

/**
 * Launch an agent via the given substrate, wait for it to submit a structured
 * result via the MCP submit_result tool, and return the result.
 *
 * Guaranteed to call handle.dispose() and capture.dispose() on every exit path
 * (success, exit-before-result, timeout).
 */
export async function runAgentSession<T = unknown>(
  opts: RunAgentSessionOptions<T>,
): Promise<{ result: T }> {
  const {
    workspaceDir,
    harness,
    input,
    substrate,
    outputSchema,
    model = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  const resultDir = opts.resultDir ?? path.join(os.tmpdir(), `octomux-as-${nanoid(8)}`);

  // Optional run-record persistence: dynamic import so the module stays
  // DB-free at load time when `run` is omitted (the default, unchanged path).
  let runRec: { id: string } | undefined;
  let finishRunFn: (typeof import('../repositories/runs.js'))['finishRun'] | undefined;
  if (opts.run) {
    const { insertRun, finishRun } = await import('../repositories/runs.js');
    finishRunFn = finishRun;
    runRec = insertRun({
      workflowKind: opts.run.workflowKind,
      trigger: opts.run.trigger,
      scheduleId: opts.run.scheduleId ?? null,
    });
  }

  const capture: CaptureStrategy<T> =
    opts.capture ?? mcpSubmitResultCapture<T>(outputSchema, { resultDir });

  // 1. Set up the capture strategy
  const { extraArgs, env: captureEnv } = await capture.setup({ workspaceDir });

  // 2. Build the full prompt with the submit_result instruction appended
  const fullPrompt = input + SUBMIT_RESULT_INSTRUCTION;

  // 3. Write the prompt to a temp file to avoid shell injection
  const promptFile = path.join(resultDir, 'prompt.txt');
  fs.mkdirSync(resultDir, { recursive: true });
  fs.writeFileSync(promptFile, fullPrompt, 'utf8');

  // 4. Build the launch command
  const sessionId = harness.newSessionId();
  const baseCmd = harness.buildLaunchCommand({
    sessionId,
    agent: null,
    flags: extraArgs.trim(),
    model,
    workspacePath: workspaceDir,
  });

  // Append the prompt file reference. Claude Code reads from stdin with --print
  // or via a file argument. We use --print with the prompt piped in to avoid
  // interactive mode, passing it via a shell here-document to avoid injection.
  const command = `${baseCmd} --print < ${shellQuoteSingle(promptFile)}`;

  logger.info(
    { workspaceDir, sessionId, substrate: substrate.kind, timeoutMs },
    'runAgentSession: launching agent',
  );

  // 5. Spawn the process
  const handle = await opts.substrate.spawn({
    command,
    cwd: workspaceDir,
    env: captureEnv,
  });

  // 6. Race: result vs early exit vs timeout
  const exitPromise = new Promise<never>((_resolve, reject) => {
    handle.onExit(({ code }) => {
      reject(
        new Error(
          `Agent exited before submitting result (exit code ${code}). ` +
            'Ensure the agent calls submit_result before exiting.',
        ),
      );
    });
  });

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutTimer = setTimeout(() => {
      reject(new Error(`runAgentSession timed out after ${timeoutMs}ms waiting for submit_result`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([capture.waitForResult(), exitPromise, timeoutPromise]);
    logger.info({ workspaceDir, sessionId }, 'runAgentSession: result received');
    if (runRec) finishRunFn?.(runRec.id, { status: 'done', result });
    return { result };
  } catch (err) {
    if (runRec) finishRunFn?.(runRec.id, { status: 'failed', error: (err as Error).message });
    throw err;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    handle.dispose();
    capture.dispose();
  }
}
