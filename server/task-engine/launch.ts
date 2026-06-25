import path from 'path';
import fs from 'fs';
import { hookBaseUrl } from '../hook-base-url.js';
import { childLogger } from '../logger.js';
import { mcpServerInvocation } from '../orchestrator/runner.js';
import { isOrchestratorManaged } from '../orchestrator/store.js';
import { shellQuoteSingle } from '../shell-quote.js';
import { tmuxWindowSubstrate } from '../agent-session/substrate-tmux-windowed.js';
import { setAgentHarnessSessionId } from '../repositories/index.js';
import type { Harness } from '../harnesses/index.js';
import type { Agent } from '../types.js';

const logger = childLogger('task-engine/launch');

/** Delay before removing the on-disk prompt file after launch. Must outlast the
 *  worst-case interactive-shell init: the prompt is read by `cat` as part of the
 *  window's startup command, which only runs after the shell sources its rc
 *  files (can be ~10s on a heavy zsh). 5s was safe when the command was typed
 *  in after a readiness wait; as a startup process the read happens later. */
const PROMPT_FILE_CLEANUP_MS = 60000;

export const DISABLED_PLUGINS_IN_WORKTREES = ['remember@claude-plugins-official'] as const;

export function writeAgentLocalSettings(worktreePath: string): void {
  const claudeDir = path.join(worktreePath, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, 'settings.local.json');
  if (fs.existsSync(settingsPath)) return;
  const plugins: Record<string, boolean> = {};
  for (const p of DISABLED_PLUGINS_IN_WORKTREES) plugins[p] = false;
  fs.writeFileSync(settingsPath, JSON.stringify({ plugins }, null, 2));
}

/**
 * Build the command that launches an agent AS a tmux window's startup process.
 *
 * Running the harness command as the pane's initial process (rather than
 * spawning an interactive shell and typing the command into it with send-keys)
 * removes the shell-readiness race entirely: tmux starts the process when it
 * creates the pane, so there is no prompt to detect, no sentinel handshake, and
 * no possibility of a half-typed or interleaved command. This is the documented
 * fix for the `send-keys`-races-shell-init bug class.
 *
 * The command runs under an interactive shell (`$SHELL -ic`) so it inherits the
 * user's full environment (PATH, nvm, etc.) — exactly what the typed-in command
 * got from the window's default interactive shell before. When the harness
 * exits we `exec $SHELL -i` so the window persists as a usable shell (matching
 * the prior UX). The initial prompt is passed via `"$(cat <file>)"` to keep
 * arbitrary prompt text out of the command line; the file is removed after a
 * delay (see PROMPT_FILE_CLEANUP_MS).
 */
export function buildAgentStartupCommand(args: {
  baseCmd: string;
  prompt?: string | null;
  worktreePath?: string;
  agentId?: string;
}): string {
  let inner = args.baseCmd;
  if (args.prompt && args.worktreePath && args.agentId) {
    const promptFile = path.join(args.worktreePath, `.claude-prompt-${args.agentId}`);
    fs.writeFileSync(promptFile, args.prompt, { mode: 0o600, flag: 'wx' });
    // `--` ends option parsing so the positional prompt can't be swallowed by a
    // preceding variadic flag. `--mcp-config` (appended for orchestrator-managed
    // tasks) is variadic in Claude Code: without the separator it consumes the
    // prompt as a second config path and the worker dies with
    // "Invalid MCP configuration". POSIX `--` is honoured by both harnesses.
    inner += ` -- "$(cat ${shellQuoteSingle(promptFile)})"`;
    setTimeout(() => {
      try {
        fs.unlinkSync(promptFile);
      } catch {
        // already removed or never existed
      }
    }, PROMPT_FILE_CLEANUP_MS);
  }
  const shell = process.env.SHELL || '/bin/sh';
  // Keep the window alive as an interactive shell once the harness exits, so
  // the pane stays usable (matches the prior typed-command behaviour).
  const script = `${inner}; exec ${shell} -i`;
  return `${shell} -ic ${shellQuoteSingle(script)}`;
}

/**
 * Write a worker mcp-config.json into the worktree's .claude directory so the
 * worker's `claude` session gets the octomux MCP server with the report_complete
 * tool. Only written for orchestrator-managed tasks.
 *
 * The worker's MCP subprocess receives OCTOMUX_TASK_ID + OCTOMUX_ACTION_TOKEN +
 * OCTOMUX_ACTION_BASE_URL, which enables workerReportEnabled() in the server and
 * registers the report_complete tool. Does NOT use --strict-mcp-config so the
 * worker keeps its existing tools + the user's project MCP servers.
 *
 * Returns the absolute path to the written mcp-config.json, or null if the MCP
 * server entry can't be resolved (worker still launches, but without the tool).
 */
export function writeWorkerMcpConfig(
  worktreePath: string,
  taskId: string,
  hookToken: string,
): string | null {
  const inv = mcpServerInvocation();
  if (!inv) {
    logger.warn(
      { task_id: taskId, operation: 'writeWorkerMcpConfig' },
      'worker MCP: server entry not found — worker will not have report_complete tool',
    );
    return null;
  }

  const claudeDir = path.join(worktreePath, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const cfgPath = path.join(claudeDir, 'worker-mcp-config.json');

  const env: Record<string, string> = {
    OCTOMUX_TASK_ID: taskId,
    OCTOMUX_ACTION_TOKEN: hookToken,
    OCTOMUX_ACTION_BASE_URL: hookBaseUrl(),
  };
  if (process.env.NODE_ENV) env.NODE_ENV = process.env.NODE_ENV;
  if (process.env.OCTOMUX_DATA_DIR) env.OCTOMUX_DATA_DIR = process.env.OCTOMUX_DATA_DIR;

  const cfg = {
    mcpServers: {
      octomux: {
        command: inv.command,
        args: inv.args,
        env,
      },
    },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

  logger.info(
    { task_id: taskId, operation: 'writeWorkerMcpConfig', config_path: cfgPath },
    'worker MCP: wrote worker mcp-config.json',
  );

  return cfgPath;
}

// ─── Extracted helpers ────────────────────────────────────────────────────────

/**
 * Create a tmux window for a new agent and return its window index.
 *
 * fresh=true  → new-session + set-option aggressive-resize + getActiveWindowIndex
 * fresh=false → new-window + getLastWindowIndex
 *
 * Argv is byte-identical to the original inline calls in each launch site.
 */
export async function launchAgentWindow(opts: {
  session: string;
  cwd: string;
  startupCmd: string;
  fresh: boolean;
}): Promise<number> {
  return tmuxWindowSubstrate.launchWindow(opts);
}

/**
 * Compute fresh (db + launch) session IDs for a new agent launch.
 *
 * When sessionIdMode === 'orchestrator-assigned', both DB and launch IDs are
 * the same freshly-minted value. Otherwise the DB ID is null and a fresh ID is
 * still generated for the launch call (harness self-assigns it).
 */
export function computeFreshSessionIds(harness: Harness): {
  sessionIdForDb: string | null;
  sessionIdForLaunch: string;
} {
  if (harness.sessionIdMode === 'orchestrator-assigned') {
    const sid = harness.newSessionId();
    return { sessionIdForDb: sid, sessionIdForLaunch: sid };
  }
  return { sessionIdForDb: null, sessionIdForLaunch: harness.newSessionId() };
}

/**
 * Apply orchestrator MCP config to flags for a worker task.
 *
 * For orchestrator-managed tasks, writes worker-mcp-config.json and appends
 * --mcp-config to flags so the worker gets the report_complete tool. Returns
 * the (possibly augmented) flags string. The `isOrchestratorManaged` check is
 * encapsulated here so Modular 05 can later invert the dependency.
 */
export function applyOrchestratorMcpConfig(
  flags: string,
  worktreePath: string,
  taskId: string,
  hookToken: string,
): string {
  if (isOrchestratorManaged(taskId)) {
    const workerMcpConfigPath = writeWorkerMcpConfig(worktreePath, taskId, hookToken);
    if (workerMcpConfigPath) {
      flags += ` --mcp-config ${shellQuoteSingle(workerMcpConfigPath)}`;
    }
  }
  return flags;
}

/**
 * Build the resume/continue/launch command for an agent being resumed or hopped.
 *
 * Encapsulates the identical three-branch ladder in resumeTask and hopAgent:
 *   1. resume by harness_session_id
 *   2. continue (new session ID, buildContinueCommand)
 *   3. fresh launch (buildContinueCommand returned null)
 *
 * Includes the setAgentHarnessSessionId side-effect and the logger.warn for the
 * continue-unsupported fallback — both are byte-identical across both callers.
 * Returns the baseCmd string. The caller is responsible for any post-launch DB
 * writes (setAgentWindowRunning / hopAgentToTask).
 */
export function prepareResumeLaunch(opts: {
  agent: Agent;
  harness: Harness;
  flags: string;
  model: string | null;
  cwd: string;
}): string {
  const { agent, harness, flags, model, cwd } = opts;
  let baseCmd: string;
  if (agent.harness_session_id) {
    baseCmd = harness.buildResumeCommand({
      sessionId: agent.harness_session_id,
      flags,
      model,
      workspacePath: cwd,
    });
  } else {
    const newId = harness.newSessionId();
    const continueCmd = harness.buildContinueCommand({
      sessionId: newId,
      flags,
      model,
      workspacePath: cwd,
    });
    if (continueCmd !== null) {
      baseCmd = continueCmd;
    } else {
      baseCmd = harness.buildLaunchCommand({
        sessionId: newId,
        agent: agent.agent,
        flags,
        model,
        workspacePath: cwd,
      });
      logger.warn(
        { agent_id: agent.id, harness: harness.id },
        'continue unsupported, launching fresh',
      );
    }
    if (harness.sessionIdMode === 'orchestrator-assigned') {
      setAgentHarnessSessionId(agent.id, newId);
    }
  }
  return baseCmd;
}
