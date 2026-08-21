import type { OctomuxSettings } from '../settings.js';
import type { ComputeFiles } from '../compute/types.js';

const AGENT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Forbidden shell metacharacters: backtick, `;`, `|`, `&`, `>`, `<`, newline,
// and `$(...)` command substitution.
const FLAG_FORBIDDEN_RE = /[`;|&><\n\r]|\$\(/;

/**
 * Validate a custom agent name. Returns the input unchanged if valid;
 * throws with a stable message otherwise. Used at the API boundary AND in
 * harness implementations (defense in depth).
 */
export function validateAgentName(name: string): string {
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(`Invalid agent name: ${JSON.stringify(name)}. Must match ${AGENT_NAME_RE}`);
  }
  return name;
}

/**
 * Validate a flag string for shell-injection metacharacters. Reuses the
 * existing rules from `server/settings.ts::validateClaudeFlags` and adds
 * `;`, `|`, `&`, `>`, `<`, `\n`, `\r`.
 */
export function validateFlagString(flags: string, fieldName: string): string {
  if (typeof flags !== 'string') {
    throw new Error(`Invalid ${fieldName}: must be a string`);
  }
  const trimmed = flags.trim();
  if (FLAG_FORBIDDEN_RE.test(trimmed)) {
    throw new Error(
      `Invalid ${fieldName}: contains forbidden shell metacharacter (one of \` ; | & > < $( or newline)`,
    );
  }
  const singleQuotes = (trimmed.match(/'/g) ?? []).length;
  const doubleQuotes = (trimmed.match(/"/g) ?? []).length;
  if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
    throw new Error(`Invalid ${fieldName}: unbalanced quotes`);
  }
  return trimmed;
}

export interface HarnessLaunchOpts {
  sessionId: string;
  agent?: string | null;
  flags?: string;
  /** Per-task model override. When set, replaces any --model in flags. */
  model?: string | null;
  /** Absolute cwd for harnesses where the CLI needs an explicit `--workspace` (Cursor). */
  workspacePath?: string;
}

export interface HarnessResumeOpts {
  sessionId: string;
  flags?: string;
  /** Per-task model override. When set, replaces any --model in flags. */
  model?: string | null;
  workspacePath?: string;
}

export interface Harness {
  readonly id: string;
  readonly displayName: string;
  readonly sessionIdMode: 'orchestrator-assigned' | 'harness-issued';

  newSessionId(): string;
  buildLaunchCommand(opts: HarnessLaunchOpts): string;
  buildResumeCommand(opts: HarnessResumeOpts): string;
  buildContinueCommand(opts: HarnessResumeOpts): string | null;
  /**
   * Write octomux's hook wiring into a directory. `files` is the file facade
   * for the machine the workspace actually lives on — for a task pinned to a
   * remote compute provider, the caller passes that session's `ComputeFiles`
   * (`(await sessionFor(task)).files`) so the config lands on the box the
   * agent runs on, not on the octomux server's own disk. Optional and
   * defaults to `localFiles` (the server's own filesystem, i.e. today's
   * behavior) so a plugin-supplied harness written against the old
   * three-arg shape still compiles and still works unchanged on local
   * compute.
   */
  installHooks(
    worktreePath: string,
    baseUrl: string,
    hookToken: string,
    files?: ComputeFiles,
  ): Promise<void>;
  /**
   * Remove octomux's hook wiring from a directory. Called on teardown for paths
   * octomux does NOT own (run_mode `existing`/`none`), which survive deleteTask
   * — otherwise the config outlives the worker row whose token it carries and
   * every later session in that directory 401s on every hook. Must leave the
   * user's own hooks and permissions intact, and no-op when nothing is there.
   * `files` follows the same rule as `installHooks`: the compute the
   * directory actually lives on, defaulting to `localFiles`.
   */
  uninstallHooks(dirPath: string, files?: ComputeFiles): Promise<void>;
  /**
   * Optional post-launch hook called after the launch command is sent to the
   * tmux pane. Used by harnesses with an interactive first-run gate (e.g.
   * Cursor's "Trust this workspace" prompt). Receives the tmux target so the
   * harness can capture and/or send keys.
   */
  postLaunch?(target: string): Promise<void>;
  resolveFlags(settings: OctomuxSettings): string;
  validateSettings(blob: unknown): Record<string, unknown>;
  validateAgentName(name: string): string;

  /**
   * Whether this harness supports Claude Code's plugin ecosystem
   * (`--plugin-dir`, marketplaces, skills/agents delivery). Purely
   * descriptive today — nothing reads it yet.
   */
  readonly supportsClaudePlugins?: boolean;
  /**
   * Will replace the hardcoded prompt-delivery construction in
   * `task-engine/launch.ts::buildAgentStartupCommand` (how the initial
   * prompt file gets appended to the launch command). Currently unwired —
   * no call site reads this member yet.
   */
  buildPromptDelivery?(baseCmd: string, promptFile: string): string;
  /**
   * Will replace the hardcoded MCP config wiring in
   * `task-engine/launch.ts::applyOrchestratorMcpConfig`. Currently unwired —
   * no call site reads this member yet. A harness implementing this builds a
   * shell command string from `worktreePath`/`configPath` and MUST quote its
   * own inputs (core uses `shellQuoteSingle` from `server/shell-quote.ts`,
   * verified sound) — an implementation that skips quoting is a real shell
   * injection surface.
   */
  attachMcp?(flags: string, worktreePath: string, configPath: string): string;
  /**
   * Will replace the harness-specific message-sending path used to talk to
   * a running agent (currently hardcoded per-harness in the task engine).
   * Currently unwired — no call site reads this member yet. An
   * implementation that shells out MUST quote `target`/`text` itself (see
   * `attachMcp` above for the same caveat).
   */
  sendMessage?(target: string, text: string): Promise<void>;
  /**
   * Will replace the harness-specific idle/active detection currently
   * hardcoded in the task engine. Currently unwired — no call site reads
   * this member yet.
   */
  detectActivity?(target: string): Promise<'active' | 'idle'>;
}
