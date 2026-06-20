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
 *  - Install a `PreToolUse` hook with `matcher: "Bash(octomux *)"` in the
 *    isolated settings for the deny-now gate (Phase 3 / SHR-131).
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

// ─── Orchestrator role (system prompt) ──────────────────────────────────────

/**
 * The conductor's role, appended to claude's default system prompt via
 * `--append-system-prompt`. It establishes the orchestrator as a thin
 * coordination layer that DELEGATES work to octomux worker tasks rather than
 * doing the work itself. Paired with the `permissions.deny` mutation block, this
 * fixes the conductor editing the repo directly instead of creating + tracking a
 * worker task.
 */
const ORCHESTRATOR_SYSTEM_PROMPT = [
  'You are the octomux ORCHESTRATOR (the conductor). Your job is to COORDINATE work — never to do it yourself.',
  '',
  'HARD RULES:',
  '- NEVER implement work yourself. Do not write code, edit files, run git, or modify anything. You have no Edit/Write tools by design — that is intentional.',
  '- DELEGATE every task to an octomux worker. Do NOT plan the implementation yourself — you have not read the code, so any step-by-step plan you write will be stale or wrong, and it duplicates the planning the worker will redo on the ground.',
  '    octomux create-task --title "<short title>" --description "<goal-oriented brief — see below>" --repo <absolute repo path>',
  '',
  'WRITE A GOAL-ORIENTED BRIEF, NOT A PLAN. The task description tells the worker WHAT to achieve and WHY — never the HOW (no "step 1, step 2, edit file X"). A capable worker owns the implementation. Use this shape:',
  '  ## Goal — 1-2 sentences: the outcome/capability that should exist when done.',
  '  ## Why / Context — intent and how it fits, so the worker makes sound tradeoffs itself.',
  '  ## Acceptance criteria — VERIFIABLE: passing tests / build+lint green / concrete example cases / an end-to-end check that proves it works, plus what evidence to show.',
  "  ## Hard constraints — non-negotiables (don't break API X, no new deps, follow CLAUDE.md).",
  '  ## Non-goals — explicitly what NOT to touch (prevents scope-creep).',
  '  ## Pointers — orientation only: "follow the pattern in src/auth/" — NEVER a procedure.',
  'Put your precision into the acceptance criteria, not into steps.',
  '',
  "- PLANNING is the WORKER's job, not yours. For ambiguous or larger work, add `--kind plan`: the worker reads the real code, writes a plan for you to review, you approve, then it implements — all in ONE session. For small/clear work (a one-sentence diff), skip the plan and let it implement directly.",
  '- TRACK progress with your read tools only: mcp__octomux__list_tasks, mcp__octomux__get_task, mcp__octomux__monitor_status, mcp__octomux__get_task_output. Do not read or edit the repo directly — inspect tasks and their artifacts through these tools.',
  '- KEEP THE USER INFORMED: when you create a task, tell them its id and the goal; when a worker finishes a phase, summarize the outcome and propose the next step.',
  '',
  'You are a thin coordination layer: set the goal, delegate, track it, report status. Never plan the implementation, never touch the code.',
].join('\n');

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
 * Contains:
 *  - `theme` + `tui` pre-set so first-run TUI dialogs (trust-folder, theme
 *    picker, onboarding) are pre-accepted and never block the session.
 *  - `PreToolUse` HTTP hook restricted to `Bash(octomux *)` for the deny-now
 *    gate (Phase 3 / SHR-131). The hook URL uses `127.0.0.1` so the backend
 *    restart window is < 1s and the fail-open risk is minimised.
 *  - `permissions.allow` intentionally omits `octomux *` so the PreToolUse hook
 *    gate remains active (documented Phase-0 constraint).
 */
function writeOrchestratorsettings(convId: string, hookToken: string): string {
  const dir = path.join(convConfigDir(convId), '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, 'settings.local.json');

  // The conversation_id is REQUIRED on the gate URL: handlePreToolUse fails-open
  // (allows the write un-gated) when it can't attach a card to a conversation.
  const preToolUseUrl =
    `${hookBaseUrl()}/api/hooks/pre-tool-use` +
    `?token=${encodeURIComponent(hookToken)}` +
    `&conversation_id=${encodeURIComponent(convId)}`;

  const settings = {
    // NOTE: no `theme`/`tui` here — we run with the DEFAULT config dir (auth +
    // onboarding already done), and an object `tui` value is rejected by claude
    // ("Invalid value. Expected one of: default, fullscreen") which blocks the
    // session on a settings-error dialog.
    // PreToolUse gate hook. IMPORTANT: Claude Code hook matchers match the TOOL
    // NAME only (as a regex) — NOT permissions-style command patterns. A matcher
    // of 'Bash(octomux *)' silently never fires, leaving every write un-gated.
    // We therefore match ALL 'Bash' calls and narrow to `octomux *` server-side
    // in handlePreToolUse (non-octomux Bash is allowed through untouched).
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'http', url: preToolUseUrl, timeout: 5 }],
        },
      ],
    },
    // Orchestrator's allowed tools: MCP read tools only (writes go through Bash + gate)
    permissions: {
      allow: [
        // Core read tools
        'Bash(cat:*)',
        'Bash(ls:*)',
        'Bash(find:*)',
        'Bash(grep:*)',
        'Bash(echo:*)',
        // MCP orchestrator reads (added in Phase 1 / SHR-121)
        'mcp__octomux__list_tasks',
        'mcp__octomux__get_task',
        'mcp__octomux__monitor_status',
        'mcp__octomux__get_task_output',
        'mcp__octomux__pull_linear_issue',
      ],
      // The conductor COORDINATES work — it must never do the work itself.
      // Hard-deny the mutation tools so it structurally cannot edit the repo,
      // write files, or implement; it can only delegate via `octomux create-task`
      // (gated) and observe via the read tools. (Fixes: conductor editing files
      // directly instead of creating + tracking a worker task.)
      deny: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
      // NOTE: 'octomux *' is NOT in allow — the PreToolUse hook must remain active
    },
  };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
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
 */
function mcpServerInvocation(): { command: string; args: string[] } | null {
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
function writeOrchestratorMcpConfig(convId: string): string | null {
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
  const env: Record<string, string> = {};
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
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  return cfgPath;
}

// ─── Tmux session name ────────────────────────────────────────────────────────

/** Deterministic tmux session name for an orchestrator conversation. */
function orchestratorSessionName(convId: string): string {
  return `octomux-orch-${convId}`;
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
  const settingsPath = writeOrchestratorsettings(convId, hookToken);
  const mcpConfigPath = writeOrchestratorMcpConfig(convId);

  const sessionName = orchestratorSessionName(convId);

  // Generate a fresh session id for this new conversation
  const sessionId = crypto.randomUUID();

  const claudeCmd = buildLaunchCommand({
    sessionId,
    settingsPath,
    mcpConfigPath,
    extraFlags: opts.extraFlags,
  });
  const shell = process.env.SHELL || '/bin/sh';
  const script = `${claudeCmd}; exec ${shell} -i`;
  const startupCmd = `${shell} -ic '${script.replace(/'/g, "'\\''")}'`;

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
  const windowIndex = parseInt(winOut.trim(), 10) || 1;
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
  const settingsPath = writeOrchestratorsettings(convId, hookToken);
  const mcpConfigPath = writeOrchestratorMcpConfig(convId);

  const sessionName = orchestratorSessionName(convId);

  const claudeSessionId = opts.claudeSessionId ?? conv.claude_session_id;

  let claudeCmd: string;
  if (claudeSessionId) {
    claudeCmd = buildResumeCommand({
      sessionId: claudeSessionId,
      settingsPath,
      mcpConfigPath,
      extraFlags: opts.extraFlags,
    });
  } else {
    // No session id → fresh start (fallback)
    const newSessionId = crypto.randomUUID();
    claudeCmd = buildLaunchCommand({
      sessionId: newSessionId,
      settingsPath,
      mcpConfigPath,
      extraFlags: opts.extraFlags,
    });
    updateConversation(convId, {
      claude_session_id: newSessionId,
      transcript_path: transcriptPathFor(cwd, newSessionId),
    });
  }

  const shell = process.env.SHELL || '/bin/sh';
  const script = `${claudeCmd}; exec ${shell} -i`;
  const startupCmd = `${shell} -ic '${script.replace(/'/g, "'\\''")}'`;

  await execTmux(['new-session', '-d', '-s', sessionName, '-c', cwd, startupCmd]);
  await execTmux(['set-option', '-t', sessionName, 'aggressive-resize', 'on']);

  const { stdout: winOut } = await execTmux([
    'display-message',
    '-t',
    sessionName,
    '-p',
    '#{window_index}',
  ]);
  const windowIndex = parseInt(winOut.trim(), 10) || 1;
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

/**
 * Send a user turn into a live orchestrator conversation via hardened send-keys.
 *
 * Hardening (Phase-0 / §3.1):
 *  1. Paste the text via `-l` (bracketed paste, keeps newlines).
 *  2. Poll `capture-pane` until the text appears in the pane buffer (or timeout).
 *  3. Send `Enter` to submit.
 *
 * This replaces the blind fixed-50ms sleep from the original `sendMessageToAgent`.
 */
export async function sendTurn(convId: string, text: string): Promise<void> {
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
 * Whether the conversation's tmux session is currently alive. False when there's
 * no recorded window, or `tmux has-session` reports the session is gone (the
 * server restarted, the session was killed, or claude exited).
 */
async function isConversationSessionAlive(conv: OrchestratorConversation): Promise<boolean> {
  if (!conv.tmux_window) return false;
  const session = conv.tmux_window.split(':')[0];
  if (!session) return false;
  try {
    await execTmux(['has-session', '-t', session]);
    return true;
  } catch {
    return false;
  }
}

interface LaunchOpts {
  sessionId: string;
  settingsPath: string;
  /** Path to the conductor mcp-config.json (octomux read tools), or null. */
  mcpConfigPath?: string | null;
  extraFlags?: string;
}

interface ResumeOpts {
  sessionId: string;
  settingsPath: string;
  /** Path to the conductor mcp-config.json (octomux read tools), or null. */
  mcpConfigPath?: string | null;
  extraFlags?: string;
}

/**
 * Build the `--mcp-config <file> --strict-mcp-config` flag fragment. `--strict`
 * limits the session to ONLY this config's servers (ignores the user's global
 * ~/.claude MCP servers) — the conductor gets exactly octomux's read tools.
 */
function mcpConfigFlags(mcpConfigPath?: string | null): string {
  if (!mcpConfigPath) return '';
  return ` --mcp-config ${shellQuoteSingle(mcpConfigPath)} --strict-mcp-config`;
}

/**
 * Build the `claude --session-id <id>` launch command.
 *
 * Uses the DEFAULT config dir so the user's subscription OAuth applies — an
 * isolated `CLAUDE_CONFIG_DIR` logs the session out (verified end-to-end). Tool
 * isolation is via `--settings <file>` (gate hook + read-only allowlist), not a
 * separate config home. (`--config-dir` is not a real claude flag — it was
 * rejected with "unknown option".)
 */
function buildLaunchCommand({
  sessionId,
  settingsPath,
  mcpConfigPath,
  extraFlags = '',
}: LaunchOpts): string {
  return `claude --session-id ${sessionId} --settings ${shellQuoteSingle(settingsPath)}${mcpConfigFlags(mcpConfigPath)}${orchestratorRoleFlag()}${extraFlags ? ` ${extraFlags}` : ''}`;
}

/** Build the `claude --resume <id>` command (default config dir + `--settings`). */
function buildResumeCommand({
  sessionId,
  settingsPath,
  mcpConfigPath,
  extraFlags = '',
}: ResumeOpts): string {
  return `claude --resume ${sessionId} --settings ${shellQuoteSingle(settingsPath)}${mcpConfigFlags(mcpConfigPath)}${orchestratorRoleFlag()}${extraFlags ? ` ${extraFlags}` : ''}`;
}

/** The `--append-system-prompt` flag carrying the orchestrator role. */
function orchestratorRoleFlag(): string {
  return ` --append-system-prompt ${shellQuoteSingle(ORCHESTRATOR_SYSTEM_PROMPT)}`;
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

/** Single-quote a string safe for use inside a shell command. */
function shellQuoteSingle(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
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
