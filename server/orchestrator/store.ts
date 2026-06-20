import { nanoid } from 'nanoid';
import { getDb } from '../db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrchestratorConversation {
  id: string;
  title: string;
  tmux_window: string | null;
  claude_session_id: string | null;
  transcript_path: string | null;
  status: string;
  /** 1 when this conversation is in global-monitor mode, 0 otherwise. */
  is_global_monitor: number;
  /** Random token authenticating the conductor's PreToolUse gate hook callbacks. */
  hook_token: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrchestratorMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface ActionCard {
  id: string;
  conversation_id: string;
  tool_use_id: string;
  tool_name: string;
  input: string;
  status: string;
  result: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface ManagedTask {
  conversation_id: string;
  task_id: string;
  phase: string;
  artifacts: string | null;
  depends_on: string | null;
  attempts: number;
  last_event_seq: number;
  artifact_lock_owner: string | null;
  updated_at: string;
}

export interface StoredEvent {
  seq: number;
  task_id: string;
  type: string;
  payload: string;
  created_at: string;
}

// ─── orchestrator_conversations ───────────────────────────────────────────────

export interface CreateConversationInput {
  title: string;
  tmux_window?: string;
  claude_session_id?: string;
  transcript_path?: string;
}

/** Create a new orchestrator conversation. Returns the new id. */
export function createConversation(input: CreateConversationInput): string {
  const id = nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO orchestrator_conversations (id, title, tmux_window, claude_session_id, transcript_path)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.title,
      input.tmux_window ?? null,
      input.claude_session_id ?? null,
      input.transcript_path ?? null,
    );
  return id;
}

/**
 * Resolve the conversation id that owns a conductor hook token, or null.
 * Used by the hook-auth middleware to authenticate the orchestrator's
 * PreToolUse gate callbacks (the conductor is not an `agents` row).
 */
export function conversationIdForHookToken(token: string): string | null {
  if (!token) return null;
  const row = getDb()
    .prepare(
      `SELECT id FROM orchestrator_conversations WHERE hook_token = ? AND hook_token IS NOT NULL AND hook_token != '' LIMIT 1`,
    )
    .get(token) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Retrieve a conversation by id. Returns undefined if not found. */
export function getConversation(id: string): OrchestratorConversation | undefined {
  return getDb().prepare(`SELECT * FROM orchestrator_conversations WHERE id = ?`).get(id) as
    | OrchestratorConversation
    | undefined;
}

/** List all conversations ordered by most recently updated. */
export function listConversations(): OrchestratorConversation[] {
  return getDb()
    .prepare(
      `SELECT * FROM orchestrator_conversations WHERE status != 'deleted' ORDER BY updated_at DESC`,
    )
    .all() as OrchestratorConversation[];
}

/** Update conversation fields (partial). */
export function updateConversation(
  id: string,
  fields: Partial<
    Pick<
      OrchestratorConversation,
      'title' | 'tmux_window' | 'claude_session_id' | 'transcript_path' | 'status' | 'hook_token'
    >
  >,
): void {
  const sets: string[] = [`updated_at = datetime('now')`];
  const vals: unknown[] = [];
  if (fields.title !== undefined) {
    sets.push('title = ?');
    vals.push(fields.title);
  }
  if (fields.hook_token !== undefined) {
    sets.push('hook_token = ?');
    vals.push(fields.hook_token);
  }
  if (fields.tmux_window !== undefined) {
    sets.push('tmux_window = ?');
    vals.push(fields.tmux_window);
  }
  if (fields.claude_session_id !== undefined) {
    sets.push('claude_session_id = ?');
    vals.push(fields.claude_session_id);
  }
  if (fields.transcript_path !== undefined) {
    sets.push('transcript_path = ?');
    vals.push(fields.transcript_path);
  }
  if (fields.status !== undefined) {
    sets.push('status = ?');
    vals.push(fields.status);
  }
  vals.push(id);
  getDb()
    .prepare(`UPDATE orchestrator_conversations SET ${sets.join(', ')} WHERE id = ?`)
    .run(...vals);
}

// ─── orchestrator_messages ────────────────────────────────────────────────────

export interface AppendMessageInput {
  conversation_id: string;
  role: string;
  content: string;
}

/** Append a message to a conversation. Returns the new message id. */
export function appendMessage(input: AppendMessageInput): string {
  const id = nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO orchestrator_messages (id, conversation_id, role, content)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, input.conversation_id, input.role, input.content);
  return id;
}

/** List messages for a conversation in chronological order. */
export function listMessages(conversation_id: string): OrchestratorMessage[] {
  return getDb()
    .prepare(
      `SELECT * FROM orchestrator_messages WHERE conversation_id = ? ORDER BY created_at ASC`,
    )
    .all(conversation_id) as OrchestratorMessage[];
}

// ─── action_cards ─────────────────────────────────────────────────────────────

export interface CreateCardInput {
  conversation_id: string;
  tool_use_id: string;
  tool_name: string;
  input: string;
}

/** Create a pending action card. Returns the new card id. */
export function createCard(input: CreateCardInput): string {
  const id = nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO action_cards (id, conversation_id, tool_use_id, tool_name, input)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, input.conversation_id, input.tool_use_id, input.tool_name, input.input);
  return id;
}

/** Get a card by id. Returns undefined if not found. */
export function getCard(id: string): ActionCard | undefined {
  return getDb().prepare(`SELECT * FROM action_cards WHERE id = ?`).get(id) as
    | ActionCard
    | undefined;
}

/** List pending cards for a conversation. */
export function listPendingCards(conversation_id: string): ActionCard[] {
  return getDb()
    .prepare(
      `SELECT * FROM action_cards WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at ASC`,
    )
    .all(conversation_id) as ActionCard[];
}

/**
 * Resolve a card to a terminal status.
 * @param status - One of: 'approved' | 'edited' | 'rejected' | 'executed'
 * @param result - JSON result string, or null.
 */
export function resolveCard(
  id: string,
  status: 'approved' | 'edited' | 'rejected' | 'executed',
  result: string | null,
): void {
  getDb()
    .prepare(
      `UPDATE action_cards SET status = ?, result = ?, decided_at = datetime('now') WHERE id = ?`,
    )
    .run(status, result, id);
}

// ─── managed_tasks ────────────────────────────────────────────────────────────

export interface UpsertManagedTaskInput {
  conversation_id: string;
  task_id: string;
  phase?: string;
  artifacts?: string;
  depends_on?: string;
  attempts?: number;
  last_event_seq?: number;
  artifact_lock_owner?: string | null;
}

/**
 * Insert or update a managed_tasks row.
 * On conflict (conversation_id, task_id), updates the provided fields only.
 */
export function upsertManagedTask(input: UpsertManagedTaskInput): void {
  getDb()
    .prepare(
      `INSERT INTO managed_tasks
         (conversation_id, task_id, phase, artifacts, depends_on, attempts, last_event_seq, artifact_lock_owner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, task_id) DO UPDATE SET
         phase               = COALESCE(excluded.phase, phase),
         artifacts           = COALESCE(excluded.artifacts, artifacts),
         depends_on          = COALESCE(excluded.depends_on, depends_on),
         attempts            = COALESCE(excluded.attempts, attempts),
         last_event_seq      = COALESCE(excluded.last_event_seq, last_event_seq),
         artifact_lock_owner = excluded.artifact_lock_owner,
         updated_at          = datetime('now')`,
    )
    .run(
      input.conversation_id,
      input.task_id,
      input.phase ?? 'planning',
      input.artifacts ?? null,
      input.depends_on ?? null,
      input.attempts ?? 0,
      input.last_event_seq ?? 0,
      input.artifact_lock_owner ?? null,
    );
}

/** Get the managed_tasks row for a task_id. Returns undefined if not found. */
export function getManagedTask(task_id: string): ManagedTask | undefined {
  return getDb().prepare(`SELECT * FROM managed_tasks WHERE task_id = ?`).get(task_id) as
    | ManagedTask
    | undefined;
}

/** Check whether a task is orchestrator-managed (used to gate Stop handler). */
export function isOrchestratorManaged(task_id: string): boolean {
  const row = getDb().prepare(`SELECT 1 FROM managed_tasks WHERE task_id = ? LIMIT 1`).get(task_id);
  return row !== undefined;
}

// ─── events ───────────────────────────────────────────────────────────────────

export interface AppendEventInput {
  task_id: string;
  type: string;
  payload: string;
}

/**
 * Append a durable event to the events log.
 * Returns the assigned seq number.
 */
export function appendEvent(input: AppendEventInput): number {
  const result = getDb()
    .prepare(`INSERT INTO events (task_id, type, payload) VALUES (?, ?, ?)`)
    .run(input.task_id, input.type, input.payload);
  return result.lastInsertRowid as number;
}

/**
 * Return all events with seq > sinceSeq, in ascending seq order.
 * Supervisors call this on (re)connect to replay missed events.
 */
export function eventsSince(sinceSeq: number): StoredEvent[] {
  return getDb()
    .prepare(`SELECT * FROM events WHERE seq > ? ORDER BY seq ASC`)
    .all(sinceSeq) as StoredEvent[];
}

// ─── conversation_usage ───────────────────────────────────────────────────────

export interface ConversationUsage {
  conversation_id: string;
  tasks_spawned: number;
  tool_calls: number;
  started_at: string;
  last_activity_at: string;
}

/**
 * Insert a conversation_usage row for this conversation.
 * Idempotent — does nothing if a row already exists (INSERT OR IGNORE).
 */
export function initConversationUsage(conversationId: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO conversation_usage (conversation_id) VALUES (?)`)
    .run(conversationId);
}

/** Return the conversation_usage row, or undefined if none exists. */
export function getConversationUsage(conversationId: string): ConversationUsage | undefined {
  return getDb()
    .prepare(`SELECT * FROM conversation_usage WHERE conversation_id = ?`)
    .get(conversationId) as ConversationUsage | undefined;
}

/**
 * Increment tasks_spawned by 1 and update last_activity_at.
 * Auto-creates the row if missing (upsert so callers need not call initConversationUsage first).
 */
export function incrementTasksSpawned(conversationId: string): void {
  getDb()
    .prepare(
      `INSERT INTO conversation_usage (conversation_id, tasks_spawned)
         VALUES (?, 1)
         ON CONFLICT(conversation_id) DO UPDATE SET
           tasks_spawned    = tasks_spawned + 1,
           last_activity_at = datetime('now')`,
    )
    .run(conversationId);
}

/**
 * Increment tool_calls by 1 and update last_activity_at.
 * Auto-creates the row if missing.
 */
export function incrementToolCalls(conversationId: string): void {
  getDb()
    .prepare(
      `INSERT INTO conversation_usage (conversation_id, tool_calls)
         VALUES (?, 1)
         ON CONFLICT(conversation_id) DO UPDATE SET
           tool_calls       = tool_calls + 1,
           last_activity_at = datetime('now')`,
    )
    .run(conversationId);
}

// ─── listActiveConversations ──────────────────────────────────────────────────

/**
 * List all conversations with status='active' (not stopped, deleted, or other
 * terminal states). Used by rehydrateConversations on boot.
 */
export function listActiveConversations(): OrchestratorConversation[] {
  return getDb()
    .prepare(
      `SELECT * FROM orchestrator_conversations WHERE status = 'active' ORDER BY updated_at DESC`,
    )
    .all() as OrchestratorConversation[];
}

// ─── global-monitor mode ──────────────────────────────────────────────────────

/**
 * Designate a conversation as the global-monitor.
 * Exactly one conversation may be in global-monitor mode at a time.
 * Clears any previously designated conversation before setting the new one.
 */
export function setGlobalMonitor(conversationId: string): void {
  const db = getDb();
  db.transaction(() => {
    // Clear any existing global-monitor designation
    db.prepare(
      `UPDATE orchestrator_conversations SET is_global_monitor = 0 WHERE is_global_monitor = 1`,
    ).run();
    // Set the new global-monitor
    db.prepare(`UPDATE orchestrator_conversations SET is_global_monitor = 1 WHERE id = ?`).run(
      conversationId,
    );
  })();
}

/**
 * Clear the global-monitor designation from all conversations.
 */
export function clearGlobalMonitor(): void {
  getDb()
    .prepare(
      `UPDATE orchestrator_conversations SET is_global_monitor = 0 WHERE is_global_monitor = 1`,
    )
    .run();
}

/**
 * Return the id of the conversation currently in global-monitor mode, or null if none.
 */
export function getGlobalMonitorConversation(): string | null {
  const row = getDb()
    .prepare(
      `SELECT id FROM orchestrator_conversations WHERE is_global_monitor = 1 AND status != 'deleted' LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}
