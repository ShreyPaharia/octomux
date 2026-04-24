import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { getSettings, resolveClaudeFlags } from './settings.js';
import { childLogger } from './logger.js';
import type { Agent } from './types.js';

const execFile = promisify(execFileCb);
const logger = childLogger('chats');

/**
 * A "chat" is a standalone runtime agent — a Claude instance with `task_id=NULL`.
 * Lives in its own tmux session (`octomux-chat-<id>`), with a per-agent scratch
 * working directory under `~/.octomux/chats/<id>/`.
 *
 * Orchestrator is a pinned chat seeded by the DB migration; it uses a fixed
 * session name `octomux-orchestrator` rather than `octomux-chat-<id>`.
 */

/** Root directory for chat scratch working dirs. */
export function chatRoot(): string {
  return path.join(os.homedir(), '.octomux', 'chats');
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
}

/**
 * Create a standalone agent row + tmux session + launch claude in it.
 */
export async function createChat(opts: CreateChatOptions = {}): Promise<Agent> {
  const db = getDb();
  const id = nanoid(12);
  const label = opts.label ?? 'Chat';
  const cwd = opts.cwd ?? chatDirFor(id);
  fs.mkdirSync(cwd, { recursive: true });

  const session = chatSessionName(id);
  const claudeSessionId = crypto.randomUUID();

  db.prepare(
    `INSERT INTO agents
       (id, task_id, window_index, label, status, claude_session_id,
        hook_activity, pinned, tmux_session, created_at)
     VALUES (?, NULL, 0, ?, 'running', ?, 'active', 0, ?, datetime('now'))`,
  ).run(id, label, claudeSessionId, session);

  try {
    await execFile('tmux', ['new-session', '-d', '-s', session, '-c', cwd]);
    await execFile('tmux', ['set-option', '-t', session, 'aggressive-resize', 'on']);

    const flags = resolveClaudeFlags(await getSettings());
    const cmd = `claude --session-id ${claudeSessionId}${flags}`;
    await execFile('tmux', ['send-keys', '-t', session, cmd, 'Enter']);

    logger.info(
      { chat_id: id, tmux_session: session, cwd, operation: 'createChat' },
      'createChat: complete',
    );
  } catch (err) {
    logger.error({ chat_id: id, operation: 'createChat', err }, 'createChat: failed');
    db.prepare(`UPDATE agents SET status = 'stopped' WHERE id = ?`).run(id);
    throw err;
  }

  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent;
}

/** List all standalone agents (task_id IS NULL), pinned first. */
export function listChats(): Agent[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM agents
         WHERE task_id IS NULL
         ORDER BY pinned DESC, created_at ASC`,
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
