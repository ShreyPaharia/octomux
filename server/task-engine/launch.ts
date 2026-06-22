import path from 'path';
import fs from 'fs';
import { hookBaseUrl } from '../hook-base-url.js';
import { childLogger } from '../logger.js';
import { mcpServerInvocation } from '../orchestrator/runner.js';
import { shellQuoteSingle } from '../shell-quote.js';

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
