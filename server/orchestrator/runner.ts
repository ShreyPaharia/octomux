/**
 * server/orchestrator/runner.ts
 *
 * Interactive tmux runner for the orchestrator chat (Task 1.4 / SHR-120).
 *
 * Each orchestrator conversation = one interactive `claude` session in tmux.
 * This is the SAME model as worker agents — no `-p`, no headless mode.
 *
 * Key Phase-0 findings honored here:
 *  - Pre-clear first-run TUI dialogs via isolated `settings.local.json` in an
 *    orchestrator-specific config dir (tui + theme pre-set).
 *  - Conductor is PURE-MCP: no PreToolUse gate hook. All writes go through
 *    mcp__octomux__* tools which execute immediately. Bash/Edit/Write are denied.
 *  - After `--resume`, wait for the auto-injected continuation turn's Stop hook
 *    (or a quiet window) before injecting real turns (resumeDelay guard).
 *  - `sendTurn` is hardened: paste text → capture-pane confirm it landed → Enter.
 *  - Store the tmux session name in `orchestrator_conversations.tmux_window`.
 *  - `transcript_path` is derived from the session_id at creation time and
 *    stored in the DB (populated when the SessionStart hook fires externally).
 *
 * Public API:
 *   startConversation(convId, cwd, opts?)  → void
 *   resumeConversation(convId, cwd, opts?) → void
 *   stopConversation(convId)               → void
 *   sendTurn(convId, text)                 → Promise<void>
 *   conversationTmuxTarget(conv)           → string | null
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { execTmux } from '../tmux-bin.js';
import { hookBaseUrl } from '../hook-base-url.js';
import { octomuxRoot } from '../octomux-root.js';
import { childLogger } from '../logger.js';
import { DEFAULT_HARNESS_ID, getHarness } from '../harnesses/index.js';
import { writeJsonConfig } from '../harnesses/shared.js';
import { buildOrchestratorConductorFlags } from './conductor-flags.js';
import {
  getConversation,
  updateConversation,
  listActiveConversations,
  listPendingCards,
} from './store.js';
import type { OrchestratorConversation } from './store.js';

const logger = childLogger('orchestrator/runner');

// ─── Constants ────────────────────────────────────────────────────────────────

/** How long to wait for the pane content to show the pasted text. */
const CAPTURE_PANE_MAX_WAIT_MS = 3000;
/** Poll interval for the capture-pane confirm loop. */
const CAPTURE_PANE_POLL_MS = 50;
/** Delay between the paste send-keys and Enter, if capture-pane confirm succeeds quickly. */
const PASTE_TO_ENTER_MIN_DELAY_MS = 50;
/** Delay after --resume auto-turn before we allow real turns to be sent. */
export const RESUME_QUIET_WINDOW_MS = process.env.NODE_ENV === 'test' ? 0 : 2000;

// ─── Config dir ───────────────────────────────────────────────────────────────

/**
 * Root of the orchestrator-specific config directory. Kept separate from
 * worktree `.claude/` so conductor settings never bleed into worker harnesses.
 */
function orchestratorConfigDir(): string {
  const root =
    process.env.NODE_ENV !== 'production'
      ? path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'data')
      : octomuxRoot();
  return path.join(root, 'orchestrator-config');
}

/** Per-conversation config dir under the shared orchestrator config root. */
function convConfigDir(convId: string): string {
  return path.join(orchestratorConfigDir(), convId);
}

// ─── Isolated settings ────────────────────────────────────────────────────────

/**
 * Write the conductor's isolated `settings.local.json` into the per-conversation
 * config dir.
 *
 * The conductor is PURE-MCP: no PreToolUse gate hook. All orchestration writes
 * go through mcp__octomux__* tools which execute immediately. Bash, Edit, Write,
 * MultiEdit, and NotebookEdit are hard-denied so the conductor structurally cannot
 * touch the repo — it can only delegate via MCP tools and observe via read tools.
 *
 * (The conductor's hook_token lives on the conversation and is wired into the
 * mcp-config write-env by writeOrchestratorMcpConfig — not needed here.)
 *
 * Contains:
 *  - `permissions.deny` includes Bash, Edit, Write, MultiEdit, NotebookEdit.
 *  - `permissions.allow` lists only the mcp__octomux__* tools (reads + writes).
 *  - No `theme`/`tui` keys — we run with the DEFAULT config dir (auth +
 *    onboarding already done), and an object `tui` value is rejected by claude
 *    ("Invalid value. Expected one of: default, fullscreen") which blocks the
 *    session on a settings-error dialog.
 */
function writeOrchestratorsettings(convId: string): string {
  const dir = path.join(convConfigDir(convId), '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, 'settings.local.json');

  const settings = {
    // NOTE: no `theme`/`tui` here — we run with the DEFAULT config dir (auth +
    // onboarding already done), and an object `tui` value is rejected by claude
    // ("Invalid value. Expected one of: default, fullscreen") which blocks the
    // session on a settings-error dialog.
    permissions: {
      // CONDUCTOR IS NON-INTERACTIVE — nobody is at its tmux TUI (the user talks
      // to it via the web chat). A permission prompt there hangs the session
      // forever (and isn't surfaced: pending tool calls aren't in the transcript
      // the chat tails, and the conductor has no PermissionRequest hook). So we
      // run in `bypassPermissions` mode: NO prompt ever appears. Crucially, the
      // `deny` list below is STILL enforced in this mode (per Claude Code docs —
      // deny/ask rules apply in every mode), so Bash/Edit/Write remain hard-
      // blocked. Net: never hangs, MCP tools (incl. future ones) just work, and
      // the conductor still structurally cannot shell out or touch files.
      defaultMode: 'bypassPermissions',
      allow: [
        // Whole-server allow: approves EVERY tool the octomux MCP server exposes,
        // present and future. Critical because an un-allowed MCP tool triggers an
        // interactive permission prompt in the conductor's tmux TUI that nobody can
        // answer (the user interacts via the web chat) — hanging the session. The
        // whole-server form (`mcp__<server>`, no trailing tool) works; the
        // `mcp__<server>__*` wildcard does NOT (claude-code#13077). The explicit
        // tools below are kept for documentation + as a fallback.
        'mcp__octomux',
        // MCP orchestrator reads (Phase 1 / SHR-121 + SHR-142 discovery reads).
        'mcp__octomux__list_tasks',
        'mcp__octomux__get_task',
        'mcp__octomux__monitor_status',
        'mcp__octomux__get_task_output',
        'mcp__octomux__pull_linear_issue',
        'mcp__octomux__recent_repos',
        'mcp__octomux__default_branch',
        'mcp__octomux__search_learnings',
        // MCP write tools (SHR-142) — execute immediately, no Bash, no gate.
        'mcp__octomux__create_task',
        'mcp__octomux__send_message',
        'mcp__octomux__set_task_status',
        'mcp__octomux__add_agent',
        'mcp__octomux__close_task',
        'mcp__octomux__delete_task',
      ],
      // The conductor COORDINATES work — it must never do the work itself.
      // Hard-deny Bash and all mutation tools so it structurally cannot run
      // shell commands, edit the repo, write files, or implement anything.
      // All writes go through mcp__octomux__* tools. (Fixes: conductor editing
      // files directly instead of creating + tracking a worker task.)
      deny: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
    },
  };

  writeJsonConfig(settingsPath, settings);
  return settingsPath;
}

// ─── MCP read-tools config ──────────────────────────────────────────────────

/**
 * Resolve how to launch the octomux MCP read-tools stdio server.
 *
 * The conductor reaches octomux's typed read tools (`list_tasks`,
 * `get_task_output`, …) via an `--mcp-config` stdio server. We must launch it
 * the same way the rest of the server runs:
 *  - prod: the build emits `dist-server/orchestrator/mcp/server.js` (a tsup
 *    entry); runner.ts is bundled into `dist-server/index.js`, so the server is
 *    a sibling under `orchestrator/mcp/`. Launch with `node <server.js>`.
 *  - dev: runner.ts runs from source at `server/orchestrator/runner.ts`; the
 *    server source is at `server/orchestrator/mcp/server.ts`. Launch via the
 *    tsx CLI (`node <tsx/cli> <server.ts>`) so TS runs without a build.
 *
 * All paths are absolute so the spawned subprocess works regardless of the cwd
 * claude launches it from. Returns null if no runnable server file is found
 * (caller then launches the conductor without MCP reads rather than failing).
 *
 * Exported so the task-engine (launch.ts) can reuse this resolution when writing
 * the worker mcp-config.json (SHR-160 — do NOT duplicate the logic there).
 */
export function mcpServerInvocation(): { command: string; args: string[] } | null {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);

  // prod: bundled runner lives in dist-server/index.js → server.js sibling tree
  const prodServer = path.join(dir, 'orchestrator', 'mcp', 'server.js');
  if (fs.existsSync(prodServer)) {
    return { command: process.execPath, args: [prodServer] };
  }

  // dev: runner.ts lives in server/orchestrator/ → mcp/server.ts sibling
  const devServer = path.join(dir, 'mcp', 'server.ts');
  if (fs.existsSync(devServer)) {
    try {
      const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
      return { command: process.execPath, args: [tsxCli, devServer] };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Write the conductor's `mcp-config.json` (octomux read-tools stdio server) into
 * the per-conversation config dir. Returns the file path, or null when the MCP
 * server entry can't be located (the conductor still launches, without reads).
 */
function writeOrchestratorMcpConfig(convId: string, hookToken: string): string | null {
  const inv = mcpServerInvocation();
  if (!inv) {
    logger.warn(
      { conversation_id: convId },
      'orchestrator: MCP server entry not found — launching conductor without --mcp-config (read tools disabled)',
    );
    return null;
  }

  const dir = path.join(convConfigDir(convId), '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const cfgPath = path.join(dir, 'mcp-config.json');

  // The subprocess inherits the conductor's env (NODE_ENV, OCTOMUX_DATA_DIR) so
  // it opens the SAME sqlite DB; pass them explicitly too for robustness.
  // The OCTOMUX_ACTION_* + OCTOMUX_CONVERSATION_ID vars enable the MCP WRITE
  // tools (SHR-142): they RPC back to the main server's orchestrator-action
  // endpoint, authenticated by the conductor token and scoped to this conversation.
  const env: Record<string, string> = {
    OCTOMUX_ACTION_BASE_URL: hookBaseUrl(),
    OCTOMUX_ACTION_TOKEN: hookToken,
    OCTOMUX_CONVERSATION_ID: convId,
  };
  if (process.env.NODE_ENV) env.NODE_ENV = process.env.NODE_ENV;
  if (process.env.OCTOMUX_DATA_DIR) env.OCTOMUX_DATA_DIR = process.env.OCTOMUX_DATA_DIR;

  const cfg = {
    mcpServers: {
      octomux: {
        command: inv.command,
        args: inv.args,
        ...(Object.keys(env).length ? { env } : {}),
      },
    },
  };
  writeJsonConfig(cfgPath, cfg);
  return cfgPath;
}

// ─── Tmux session name ────────────────────────────────────────────────────────

/** Deterministic tmux session name for an orchestrator conversation. */
function orchestratorSessionName(convId: string): string {
  return `octomux-orch-${convId}`;
}

/**
 * Build the shell command tmux runs to launch the conductor.
 *
 * On claude exit we DO NOT drop to an interactive shell (`exec $SHELL -i`): a
 * crashed conductor would then execute any `send-keys` chat text as a shell
 * command (the security review's "chat text run as bash" hazard). Instead we
 * hold non-interactively — `read -r _` blocks consuming input as data, never a
 * command — so a dead pane can never run keystrokes. Liveness
 * (`isConversationSessionAlive`) then sees the shell (not `node`/`claude`) and
 * `sendTurn` resumes rather than pasting into a corpse.
 */
function buildConductorStartupCmd(claudeCmd: string): string {
  const shell = process.env.SHELL || '/bin/sh';
  const script = `${claudeCmd}; echo CONDUCTOR_EXITED; read -r _`;
  return `${shell} -ic '${script.replace(/'/g, "'\\''")}'`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return the `session:windowIndex` tmux target for a conversation, or null
 * if no session exists.
 */
export function conversationTmuxTarget(conv: OrchestratorConversation): string | null {
  return conv.tmux_window ?? null;
}

export interface StartConversationOpts {
  /** Existing Claude session id to --resume, if any. Overrides conv.claude_session_id. */
  claudeSessionId?: string;
  /** Additional claude CLI flags. */
  extraFlags?: string;
}

/**
 * Start a fresh orchestrator conversation: launch an interactive `claude`
 * session in a new tmux session with isolated conductor settings.
 *
 * Stores the session name + window index in the conversation record.
 */
export async function startConversation(
  convId: string,
  cwd: string,
  opts: StartConversationOpts = {},
): Promise<void> {
  logger.info(
    { conversation_id: convId, operation: 'startConversation', cwd },
    'startConversation: start',
  );

  const hookToken = crypto.randomBytes(32).toString('hex');
  const settingsPath = writeOrchestratorsettings(convId);
  const mcpConfigPath = writeOrchestratorMcpConfig(convId, hookToken);

  const sessionName = orchestratorSessionName(convId);

  const harness = getHarness(DEFAULT_HARNESS_ID);
  const sessionId = harness.newSessionId();
  const flags = buildOrchestratorConductorFlags({
    settingsPath,
    mcpConfigPath,
    extraFlags: opts.extraFlags,
  });

  const claudeCmd = harness.buildLaunchCommand({ sessionId, flags });
  const startupCmd = buildConductorStartupCmd(claudeCmd);

  await execTmux(['new-session', '-d', '-s', sessionName, '-c', cwd, startupCmd]);
  await execTmux(['set-option', '-t', sessionName, 'aggressive-resize', 'on']);

  // Record the active window index
  const { stdout: winOut } = await execTmux([
    'display-message',
    '-t',
    sessionName,
    '-p',
    '#{window_index}',
  ]);
  // tmux base-index varies per user (often 0); a plain `|| 1` fallback would
  // turn a real index of 0 into 1, targeting a window that does not exist.
  const parsedWindowIndex = parseInt(winOut.trim(), 10);
  const windowIndex = Number.isNaN(parsedWindowIndex) ? 0 : parsedWindowIndex;
  const tmuxWindow = `${sessionName}:${windowIndex}`;

  updateConversation(convId, {
    tmux_window: tmuxWindow,
    claude_session_id: sessionId,
    transcript_path: transcriptPathFor(cwd, sessionId),
    hook_token: hookToken,
    cwd,
  });

  logger.info(
    { conversation_id: convId, operation: 'startConversation', tmux_window: tmuxWindow },
    'startConversation: complete',
  );
}

/**
 * Resume an existing orchestrator conversation: recreate the tmux session and
 * launch `claude --resume <session_id>` from the pinned cwd.
 *
 * Phase-0 finding: `--resume` auto-injects a continuation turn — do not send
 * real turns until the resumeDelay guard has elapsed.
 */
export async function resumeConversation(
  convId: string,
  cwd: string,
  opts: StartConversationOpts = {},
): Promise<void> {
  const conv = getConversation(convId);
  if (!conv) {
    throw new Error(`orchestrator runner: conversation ${convId} not found`);
  }

  logger.info(
    { conversation_id: convId, operation: 'resumeConversation', cwd },
    'resumeConversation: start',
  );

  const hookToken = crypto.randomBytes(32).toString('hex');
  const settingsPath = writeOrchestratorsettings(convId);
  const mcpConfigPath = writeOrchestratorMcpConfig(convId, hookToken);

  const sessionName = orchestratorSessionName(convId);

  const harness = getHarness(DEFAULT_HARNESS_ID);
  const flags = buildOrchestratorConductorFlags({
    settingsPath,
    mcpConfigPath,
    extraFlags: opts.extraFlags,
  });

  const claudeSessionId = opts.claudeSessionId ?? conv.claude_session_id;

  let claudeCmd: string;
  if (claudeSessionId) {
    claudeCmd = harness.buildResumeCommand({ sessionId: claudeSessionId, flags });
  } else {
    // No session id → fresh start (fallback)
    const newSessionId = harness.newSessionId();
    claudeCmd = harness.buildLaunchCommand({ sessionId: newSessionId, flags });
    updateConversation(convId, {
      claude_session_id: newSessionId,
      transcript_path: transcriptPathFor(cwd, newSessionId),
    });
  }

  const startupCmd = buildConductorStartupCmd(claudeCmd);

  await execTmux(['new-session', '-d', '-s', sessionName, '-c', cwd, startupCmd]);
  await execTmux(['set-option', '-t', sessionName, 'aggressive-resize', 'on']);

  const { stdout: winOut } = await execTmux([
    'display-message',
    '-t',
    sessionName,
    '-p',
    '#{window_index}',
  ]);
  // tmux base-index varies per user (often 0); a plain `|| 1` fallback would
  // turn a real index of 0 into 1, targeting a window that does not exist.
  const parsedWindowIndex = parseInt(winOut.trim(), 10);
  const windowIndex = Number.isNaN(parsedWindowIndex) ? 0 : parsedWindowIndex;
  const tmuxWindow = `${sessionName}:${windowIndex}`;

  updateConversation(convId, { tmux_window: tmuxWindow, hook_token: hookToken });

  logger.info(
    {
      conversation_id: convId,
      operation: 'resumeConversation',
      tmux_window: tmuxWindow,
      has_session_id: !!claudeSessionId,
    },
    'resumeConversation: complete (resume delay guard applies)',
  );
}

/**
 * Stop an orchestrator conversation by killing its tmux session.
 * The conversation record is updated to reflect the stopped state.
 */
export async function stopConversation(convId: string): Promise<void> {
  const conv = getConversation(convId);
  if (!conv?.tmux_window) {
    logger.debug(
      { conversation_id: convId, operation: 'stopConversation' },
      'stopConversation: no session, no-op',
    );
    return;
  }

  // tmux_window is stored as "session:windowIndex"; kill by the session name
  const sessionName = conv.tmux_window.split(':')[0];
  if (!sessionName) return;

  logger.info(
    { conversation_id: convId, operation: 'stopConversation', session: sessionName },
    'stopConversation: killing session',
  );

  try {
    await execTmux(['kill-session', '-t', sessionName]);
    logger.info(
      { conversation_id: convId, operation: 'stopConversation' },
      'stopConversation: session killed',
    );
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    if (/can't find session/i.test(stderr)) {
      logger.debug(
        { conversation_id: convId, operation: 'stopConversation' },
        'stopConversation: session already gone',
      );
    } else {
      logger.warn(
        { conversation_id: convId, operation: 'stopConversation', err },
        'stopConversation: kill-session failed',
      );
    }
  }

  updateConversation(convId, { status: 'stopped', tmux_window: null });
}

// ─── Single-writer FIFO per conversation ────────────────────────────────────

/**
 * Per-conversation write chain. Every writer into the pane (a web user turn, a
 * gateway/Telegram turn) goes through `sendTurn`, which serializes on this chain
 * so two turns can never interleave their paste/Enter keystrokes into one pane
 * (which would submit garbled input). One conversation = one pane = one writer
 * at a time; distinct conversations run concurrently.
 */
const convWriteChains = new Map<string, Promise<void>>();

function withConvWriteLock<T>(convId: string, fn: () => Promise<T>): Promise<T> {
  const prev = convWriteChains.get(convId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  // The next writer waits for this one regardless of success/failure.
  convWriteChains.set(
    convId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Interrupt the conductor's in-flight turn by sending the TUI interrupt key
 * (Escape) to the pane. Used by the gateway turn policy to stop-and-merge when a
 * new inbound message arrives mid-turn (the user asked for "stop and push the
 * new message if not idle"). No-op if the session isn't alive.
 *
 * Serialized on the same write chain as `sendTurn`, so an interrupt can't race a
 * paste into the same pane.
 */
export async function interruptTurn(convId: string): Promise<void> {
  const conv = getConversation(convId);
  if (!conv || !(await isConversationSessionAlive(conv)) || !conv.tmux_window) return;
  const target = conv.tmux_window;
  await withConvWriteLock(convId, async () => {
    await execTmux(['send-keys', '-t', target, 'Escape']);
    logger.debug(
      { conversation_id: convId, operation: 'interruptTurn' },
      'interruptTurn: Escape sent',
    );
  });
}

/**
 * Send a user turn into a live orchestrator conversation via hardened send-keys.
 *
 * Hardening (Phase-0 / §3.1):
 *  1. Paste the text via `-l` (bracketed paste, keeps newlines).
 *  2. Poll `capture-pane` until the text appears in the pane buffer (or timeout).
 *  3. Send `Enter` to submit.
 *
 * The whole operation (including a transparent resume of a dead session) runs
 * under the per-conversation write lock so concurrent turns serialize.
 */
export async function sendTurn(convId: string, text: string): Promise<void> {
  return withConvWriteLock(convId, () => deliverTurn(convId, text));
}

async function deliverTurn(convId: string, text: string): Promise<void> {
  let conv = getConversation(convId);
  if (!conv) {
    throw new Error(`orchestrator runner: conversation ${convId} not found`);
  }

  // Resume the session if it died (server restart, crash, or a prior stop). The
  // conductor is one interactive `claude` session in tmux; reopening a chat and
  // sending a turn must transparently restart it via `--resume <session_id>`
  // (same session id → same transcript, history intact) before delivering.
  if (!(await isConversationSessionAlive(conv))) {
    logger.info(
      { conversation_id: convId, operation: 'sendTurn' },
      'sendTurn: session not alive — resuming before delivering turn',
    );
    await resumeConversation(convId, conv.cwd ?? process.cwd());
    // Let the --resume continuation settle before injecting the real turn.
    if (RESUME_QUIET_WINDOW_MS > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, RESUME_QUIET_WINDOW_MS));
    }
    conv = getConversation(convId); // reload — resume updated tmux_window
  }

  if (!conv?.tmux_window) {
    throw new Error(`orchestrator runner: no tmux session for conversation ${convId}`);
  }

  const target = conv.tmux_window; // "session:windowIndex"

  logger.debug(
    { conversation_id: convId, operation: 'sendTurn', target, textLength: text.length },
    'sendTurn: pasting text',
  );

  // Step 1: paste the text (bracketed paste — preserves newlines)
  await execTmux(['send-keys', '-t', target, '-l', text]);

  // Step 2: capture-pane confirm — wait until the pasted text appears in the buffer
  const confirmed = await waitForPaneContent(target, text);
  if (!confirmed) {
    logger.warn(
      { conversation_id: convId, operation: 'sendTurn', target },
      'sendTurn: capture-pane confirm timed out; sending Enter anyway',
    );
  }

  // Step 3: brief minimum delay then Enter
  await new Promise<void>((resolve) => setTimeout(resolve, PASTE_TO_ENTER_MIN_DELAY_MS));
  await execTmux(['send-keys', '-t', target, 'Enter']);

  logger.debug({ conversation_id: convId, operation: 'sendTurn' }, 'sendTurn: Enter sent');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Whether the conductor's `claude` process is currently alive in the pane —
 * NOT merely "the tmux session exists."
 *
 * `has-session` is true even when claude has crashed and the pane fell back to
 * the holding shell. Pasting a chat turn into that shell would run it as a
 * command, so liveness must mean the pane's foreground process is claude
 * (reported as `node` — the CLI is a node process — or `claude`). Anything else
 * (the shell, `read`) means dead → `sendTurn` resumes instead of pasting.
 *
 * A failed `display-message` (no such session) also means not-alive.
 */
async function isConversationSessionAlive(conv: OrchestratorConversation): Promise<boolean> {
  if (!conv.tmux_window) return false;
  try {
    const { stdout } = await execTmux([
      'display-message',
      '-t',
      conv.tmux_window,
      '-p',
      '#{pane_current_command}',
    ]);
    const cmd = stdout.trim().toLowerCase();
    return cmd === 'node' || cmd === 'claude';
  } catch {
    return false;
  }
}

/**
 * Derive the transcript path Claude Code writes under the default config dir:
 * `~/.claude/projects/<cwd-with-non-alnum-as-dash>/<session-id>.jsonl`.
 * (Verified: cwd `/private/tmp` → `~/.claude/projects/-private-tmp/<id>.jsonl`.)
 */
export function transcriptPathFor(cwd: string, sessionId: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  // Claude encodes the REAL (symlink-resolved) cwd: on macOS `/tmp` →
  // `/private/tmp` → `-private-tmp`. Encoding the raw cwd would point the tail at
  // a non-existent file, so the conductor's replies would never stream. Resolve
  // the real path first (fall back to the raw cwd if it doesn't exist yet).
  let realCwd = cwd;
  try {
    realCwd = fs.realpathSync(cwd);
  } catch {
    realCwd = cwd;
  }
  const encoded = realCwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(home, '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

/**
 * Poll `tmux capture-pane` until the target pane shows content that includes
 * a substring of the pasted text (or the full prompt-ready state). Returns
 * true if confirmed, false on timeout.
 */
async function waitForPaneContent(target: string, text: string): Promise<boolean> {
  // We check for the first ~20 chars of the pasted text (enough to confirm it landed).
  const needle = text.slice(0, 20);
  const deadline = Date.now() + CAPTURE_PANE_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      const { stdout } = await execTmux(['capture-pane', '-t', target, '-p']);
      if (stdout.includes(needle)) {
        return true;
      }
    } catch {
      // Ignore capture-pane errors; fall through to timeout
    }
    await new Promise<void>((resolve) => setTimeout(resolve, CAPTURE_PANE_POLL_MS));
  }
  return false;
}

// ─── Restart hardening ────────────────────────────────────────────────────────

/**
 * Snapshot of a conversation's restart state. Returned by `rehydrateConversations`
 * so the caller can decide whether to re-attach a transcript tail, show a
 * pending-card notice in the UI, or prompt the user to resume a stopped session.
 */
export interface RehydratedConversation {
  conversationId: string;
  title: string;
  tmuxWindow: string | null;
  claudeSessionId: string | null;
  transcriptPath: string | null;
  /** How many action cards are still in 'pending' state (need user decision). */
  pendingCardCount: number;
}

/**
 * On backend boot, scan all active conversations and surface:
 *  - Their current tmux session info (so the stream layer can re-attach).
 *  - How many pending action cards remain undecided (so the UI can rehydrate them).
 *
 * This is a read-only inspection — it does not restart any sessions or re-tail
 * any transcripts. The caller (typically `server/app.ts` or the stream layer)
 * decides what to do with the results.
 *
 * Spec reference: §10 "durable execution / rehydrate-on-restart".
 */
export function rehydrateConversations(): RehydratedConversation[] {
  const active = listActiveConversations();
  return active.map((conv) => {
    const pendingCards = listPendingCards(conv.id);
    return {
      conversationId: conv.id,
      title: conv.title,
      tmuxWindow: conv.tmux_window,
      claudeSessionId: conv.claude_session_id,
      transcriptPath: conv.transcript_path,
      pendingCardCount: pendingCards.length,
    };
  });
}
