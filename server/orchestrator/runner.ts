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

  const preToolUseUrl = `${hookBaseUrl()}/api/hooks/pre-tool-use?token=${encodeURIComponent(hookToken)}`;

  const settings = {
    // Pre-clear first-run TUI dialogs (Phase-0 finding)
    theme: 'dark',
    tui: {
      autoAcceptPolicyChecks: true,
    },
    // PreToolUse gate hook (deny-now for Bash(octomux *) calls)
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash(octomux *)',
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
      // NOTE: 'octomux *' is NOT in allow — the PreToolUse hook must remain active
    },
  };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return settingsPath;
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

  const sessionName = orchestratorSessionName(convId);

  // Generate a fresh session id for this new conversation
  const sessionId = crypto.randomUUID();

  const claudeCmd = buildLaunchCommand({ sessionId, settingsPath, extraFlags: opts.extraFlags });
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

  const sessionName = orchestratorSessionName(convId);

  const claudeSessionId = opts.claudeSessionId ?? conv.claude_session_id;

  let claudeCmd: string;
  if (claudeSessionId) {
    claudeCmd = buildResumeCommand({
      sessionId: claudeSessionId,
      settingsPath,
      extraFlags: opts.extraFlags,
    });
  } else {
    // No session id → fresh start (fallback)
    const newSessionId = crypto.randomUUID();
    claudeCmd = buildLaunchCommand({
      sessionId: newSessionId,
      settingsPath,
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

  updateConversation(convId, { tmux_window: tmuxWindow });

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
  const conv = getConversation(convId);
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

interface LaunchOpts {
  sessionId: string;
  settingsPath: string;
  extraFlags?: string;
}

interface ResumeOpts {
  sessionId: string;
  settingsPath: string;
  extraFlags?: string;
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
function buildLaunchCommand({ sessionId, settingsPath, extraFlags = '' }: LaunchOpts): string {
  return `claude --session-id ${sessionId} --settings ${shellQuoteSingle(settingsPath)}${extraFlags ? ` ${extraFlags}` : ''}`;
}

/** Build the `claude --resume <id>` command (default config dir + `--settings`). */
function buildResumeCommand({ sessionId, settingsPath, extraFlags = '' }: ResumeOpts): string {
  return `claude --resume ${sessionId} --settings ${shellQuoteSingle(settingsPath)}${extraFlags ? ` ${extraFlags}` : ''}`;
}

/**
 * Derive the transcript path Claude Code writes under the default config dir:
 * `~/.claude/projects/<cwd-with-non-alnum-as-dash>/<session-id>.jsonl`.
 * (Verified: cwd `/private/tmp` → `~/.claude/projects/-private-tmp/<id>.jsonl`.)
 */
export function transcriptPathFor(cwd: string, sessionId: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
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
