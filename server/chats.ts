import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { octomuxRoot } from './octomux-root.js';
import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { getSettings } from './settings.js';
import { getHarness } from './harnesses/index.js';
import { hookBaseUrl } from './hook-base-url.js';
import { childLogger } from './logger.js';
import { execTmux } from './tmux-bin.js';
import { shellQuoteSingle } from './shell-quote.js';
import type { Agent } from './types.js';

const logger = childLogger('chats');

/**
 * A "chat" is a standalone runtime agent — a Claude instance with `task_id=NULL`.
 * Lives in its own tmux session (`octomux-chat-<id>`), with a per-agent scratch
 * working directory under `~/.octomux/chats/<id>/`.
 */

/** Root directory for chat scratch working dirs. */
export function chatRoot(): string {
  return path.join(octomuxRoot(), 'chats');
}

export function chatDirFor(id: string): string {
  return path.join(chatRoot(), id);
}

export function chatSessionName(id: string): string {
  return `octomux-chat-${id}`;
}

export interface CreateChatOptions {
  label?: string;
  cwd?: string;
  agent?: string | null;
  prompt?: string | null;
  harnessId?: string | null;
}

/**
 * Create a standalone agent row + tmux session + launch claude in it.
 */
export async function createChat(opts: CreateChatOptions = {}): Promise<Agent> {
  const db = getDb();
  const id = nanoid(12);
  const label = opts.label ?? 'Chat';
  const cwd = opts.cwd ?? chatDirFor(id);
  const agent = opts.agent ?? null;
  fs.mkdirSync(cwd, { recursive: true });

  const session = chatSessionName(id);

  const harness = getHarness(opts.harnessId ?? null);
  const agentId = id; // for standalone chats, agent row id == chat id
  const hookToken = crypto.randomBytes(32).toString('hex');
  const flags = harness.resolveFlags(await getSettings());

  let sessionIdForDb: string | null;
  let sessionIdForLaunch: string;
  if (harness.sessionIdMode === 'orchestrator-assigned') {
    const sid = harness.newSessionId();
    sessionIdForDb = sid;
    sessionIdForLaunch = sid;
  } else {
    sessionIdForDb = null;
    sessionIdForLaunch = harness.newSessionId();
  }

  db.prepare(
    `INSERT INTO agents
       (id, task_id, window_index, label, status, harness_id, harness_session_id,
        hook_token, hook_activity, tmux_session, agent, created_at)
     VALUES (?, NULL, 0, ?, 'running', ?, ?, ?, 'active', ?, ?, datetime('now'))`,
  ).run(id, label, harness.id, sessionIdForDb, hookToken, session, agent);

  try {
    await harness.syncAgents(cwd);
    await harness.installHooks(cwd, hookBaseUrl(), hookToken);

    await execTmux(['new-session', '-d', '-s', session, '-c', cwd]);
    await execTmux(['set-option', '-t', session, 'aggressive-resize', 'on']);

    const baseCmd = harness.buildLaunchCommand({
      sessionId: sessionIdForLaunch,
      agent,
      flags,
      workspacePath: cwd,
    });
    let cmd = baseCmd;
    let promptFile: string | null = null;
    const initialPrompt = opts.prompt?.trim();
    if (initialPrompt) {
      promptFile = path.join(cwd, `.claude-prompt-${agentId}`);
      fs.writeFileSync(promptFile, initialPrompt, { mode: 0o600, flag: 'wx' });
      cmd += ` "$(cat ${shellQuoteSingle(promptFile)})"`;
    }
    await execTmux(['send-keys', '-t', session, cmd, 'Enter']);
    if (promptFile) {
      const pf = promptFile;
      setTimeout(() => {
        try {
          fs.unlinkSync(pf);
        } catch {
          // already removed
        }
      }, 30_000);
    }

    logger.info(
      {
        chat_id: id,
        tmux_session: session,
        cwd,
        agent,
        harness: harness.id,
        harness_session_id: sessionIdForDb,
        operation: 'createChat',
      },
      'createChat: complete',
    );
  } catch (err) {
    logger.error({ chat_id: id, operation: 'createChat', err }, 'createChat: failed');
    db.prepare(`UPDATE agents SET status = 'stopped' WHERE id = ?`).run(id);
    throw err;
  }

  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent;
}

/** List all standalone agents (task_id IS NULL), oldest first. */
export function listChats(): Agent[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM agents
         WHERE task_id IS NULL
         ORDER BY created_at ASC`,
    )
    .all() as Agent[];
}

export function getChat(id: string): Agent | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM agents WHERE id = ? AND task_id IS NULL`).get(id) as
    | Agent
    | undefined;
  return row ?? null;
}

function isTmuxTargetMissing(err: unknown): boolean {
  const stderr = (err as { stderr?: string } | null)?.stderr ?? '';
  return /can't find (?:session|window|pane):/i.test(stderr);
}

async function killChatSession(id: string, session: string, op: string): Promise<void> {
  try {
    await execTmux(['kill-session', '-t', session]);
    logger.info(
      { chat_id: id, operation: op, tmux_session: session },
      `${op}: tmux session killed`,
    );
  } catch (err) {
    if (isTmuxTargetMissing(err)) {
      logger.debug(
        { chat_id: id, operation: op, tmux_session: session },
        `${op}: tmux session already gone`,
      );
    } else {
      logger.warn(
        { chat_id: id, operation: op, tmux_session: session, err },
        `${op}: tmux kill-session failed`,
      );
    }
  }
}

/**
 * Close a chat: stop the tmux session and mark the agent row stopped.
 * Preserves the DB row + scratch dir so history remains visible.
 */
export async function closeChat(chat: Agent): Promise<void> {
  const db = getDb();
  logger.info({ chat_id: chat.id, operation: 'closeChat' }, 'closeChat: start');

  db.prepare(
    `UPDATE agents SET status = 'stopped', hook_activity = 'idle',
       hook_activity_updated_at = datetime('now')
     WHERE id = ?`,
  ).run(chat.id);

  if (chat.tmux_session) {
    await killChatSession(chat.id, chat.tmux_session, 'closeChat');
  }

  logger.info({ chat_id: chat.id, operation: 'closeChat' }, 'closeChat: complete');
}

/**
 * Delete a chat: kill tmux, remove scratch dir, delete DB row.
 */
export async function deleteChat(chat: Agent): Promise<void> {
  const db = getDb();
  logger.info({ chat_id: chat.id, operation: 'deleteChat' }, 'deleteChat: start');

  if (chat.tmux_session) {
    await killChatSession(chat.id, chat.tmux_session, 'deleteChat');
  }

  const dir = chatDirFor(chat.id);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.info(
      { chat_id: chat.id, operation: 'deleteChat', chat_dir: dir },
      'deleteChat: scratch dir removed',
    );
  } catch (err) {
    logger.warn(
      { chat_id: chat.id, operation: 'deleteChat', chat_dir: dir, err },
      'deleteChat: scratch dir remove failed (may already be gone)',
    );
  }

  db.prepare('DELETE FROM agents WHERE id = ?').run(chat.id);

  logger.info({ chat_id: chat.id, operation: 'deleteChat' }, 'deleteChat: complete');
}
