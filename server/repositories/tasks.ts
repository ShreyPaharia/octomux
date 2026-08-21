/**
 * Repository layer for the `tasks`, `task_updates`, and `task_external_refs` tables.
 * Plain exported functions — no base class, no ORM, no new dependencies.
 * Always calls getDb() inside each function so setDb() test swaps work.
 */
import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';
import { SELECT_TASK_SQL } from '../task-select.js';
import { deleteFactsForTask } from './plugin-facts.js';
import { SQL_EXCLUDE_AUTO_REVIEW } from '../task-query.js';
import type { Task, TaskUpdate, TaskExternalRef } from '../types.js';
import type { SQLQueryBindings } from '../sqlite.js';

const logger = childLogger('repositories/tasks');

// ─── Allowed writable columns for dynamic SET builders ────────────────────────
// Explicit allowlists prevent injection via caller-supplied keys.

const TASK_WRITABLE_COLUMNS = new Set([
  'title',
  'description',
  'initial_prompt',
  'runtime_state',
  'workflow_status',
  'tmux_session',
  'pr_url',
  'pr_number',
  'pr_head_sha',
  'user_window_index',
  'last_viewed_at',
  'deleted_at',
  'error',
  'worktree_id',
  'agent',
  'model',
  'notify_task_id',
  'harness_id',
  'source',
]);

// ─── Task reads ───────────────────────────────────────────────────────────────

/** Fetch a single task by id (returns undefined if not found). */
export function getTask(id: string): Task | undefined {
  return getDb().prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(id) as Task | undefined;
}

export interface ListTasksOpts {
  /**
   * When false (default) auto_review tasks are excluded — reviews use the
   * /api/reviews endpoint.  Pass true to include them.
   */
  includeAutoReview?: boolean;
  /**
   * When false (default) tasks created by an automated workflow (any non-null
   * `source` other than 'auto_review', which has its own `includeAutoReview`
   * flag) are excluded — the Tasks board shows manual work only, automated
   * runs live on /runs. Pass true to include them (CLI, orchestrator, pollers).
   */
  includeAutomated?: boolean;
  /** When true, include soft-deleted tasks only (trash view). */
  trash?: boolean;
  /** Filter by exact repo_path. */
  repoPath?: string;
}

/** List tasks with optional filtering. Results ordered newest-first by created_at (or deleted_at for trash). */
export function listTasks(opts: ListTasksOpts = {}): Task[] {
  const db = getDb();
  const { includeAutoReview = false, includeAutomated = false, trash = false, repoPath } = opts;

  const trashPredicate = trash ? 't.deleted_at IS NOT NULL' : 't.deleted_at IS NULL';
  const orderBy = trash ? 'ORDER BY t.deleted_at DESC' : 'ORDER BY t.created_at DESC';
  const autoReviewClause = includeAutoReview ? '' : `AND ${SQL_EXCLUDE_AUTO_REVIEW}`;
  const automatedFlag = includeAutomated ? 1 : 0;

  if (repoPath) {
    return db
      .prepare(
        `${SELECT_TASK_SQL} WHERE ${trashPredicate} ${autoReviewClause}
                              AND (? = 1 OR t.source IS NULL OR t.source = 'auto_review') AND w.repo_path = ? ${orderBy}`,
      )
      .all(automatedFlag, repoPath) as Task[];
  }

  return db
    .prepare(
      `${SELECT_TASK_SQL} WHERE ${trashPredicate} ${autoReviewClause} AND (? = 1 OR t.source IS NULL OR t.source = 'auto_review') ${orderBy}`,
    )
    .all(automatedFlag) as Task[];
}

/** List soft-deleted tasks that have passed their grace window. */
export function listExpiredSoftDeletes(graceHours: number): Task[] {
  return getDb()
    .prepare(
      `${SELECT_TASK_SQL} WHERE t.deleted_at IS NOT NULL
                            AND t.deleted_at <= datetime('now', ?)`,
    )
    .all(`-${graceHours} hours`) as Task[];
}

/** List tasks whose source='auto_review' and that are in the walkthrough handoff queue. */
export function listWalkthroughHandoffTasks(): Task[] {
  return getDb()
    .prepare(
      `${SELECT_TASK_SQL}
         WHERE t.id IN (
           SELECT task_id FROM review_runs
            WHERE walkthrough IS NOT NULL AND deep_review_attached = 0 AND status = 'running'
         ) AND t.source = 'auto_review'`,
    )
    .all() as Task[];
}

/**
 * List all running/setting_up/looping tasks regardless of tmux_session.
 * Used by startup recovery (recoverTasks) — 'looping' tasks are routed to
 * the loop's fresh-context resume, never the normal --resume ladder.
 */
export function listRecoverableTasks(): Task[] {
  return getDb()
    .prepare(`${SELECT_TASK_SQL} WHERE t.runtime_state IN ('running', 'setting_up', 'looping')`)
    .all() as Task[];
}

/**
 * List running/setting_up/looping tasks that have a tmux session (for status
 * polling). 'looping' tasks are included so the poller keeps checking their
 * session, but pollStatuses must never act on a dead result for them — a loop
 * respawn briefly swaps tmux windows and must not be torn down for that gap.
 */
export function listRunningTasks(): Task[] {
  return getDb()
    .prepare(
      `${SELECT_TASK_SQL} WHERE t.runtime_state IN ('running', 'setting_up', 'looping') AND t.tmux_session IS NOT NULL`,
    )
    .all() as Task[];
}

/** List tasks that are in setting_up state (for boot-time reconciliation). */
export function listSettingUpTasks(): Array<{ id: string; tmux_session: string | null }> {
  return getDb()
    .prepare(`SELECT id, tmux_session FROM tasks WHERE runtime_state = 'setting_up'`)
    .all() as Array<{ id: string; tmux_session: string | null }>;
}

/** List all non-deleted auto_review tasks, newest-updated first (reviews inbox). */
export function listReviewTasks(): Task[] {
  return getDb()
    .prepare(
      `${SELECT_TASK_SQL} WHERE t.source = 'auto_review' AND t.deleted_at IS NULL ORDER BY t.updated_at DESC`,
    )
    .all() as Task[];
}

/** Fetch a single auto_review task by id (returns undefined if not found or not a review). */
export function getReviewTask(id: string): Task | undefined {
  return getDb()
    .prepare(`${SELECT_TASK_SQL} WHERE t.id = ? AND t.source = 'auto_review'`)
    .get(id) as Task | undefined;
}

/** List done (workflow_status='done') tasks that are not soft-deleted. */
export function listDoneTasks(): Task[] {
  return getDb()
    .prepare(`${SELECT_TASK_SQL} WHERE t.workflow_status = 'done' AND t.deleted_at IS NULL`)
    .all() as Task[];
}

/** List tasks for a specific worktree (for GET /api/worktrees/:id detail view). */
export function listTasksByWorktree(worktreeId: string): Task[] {
  return getDb()
    .prepare(
      `${SELECT_TASK_SQL} WHERE t.worktree_id = ? AND t.deleted_at IS NULL ORDER BY t.updated_at DESC`,
    )
    .all(worktreeId) as Task[];
}

/**
 * Distinct repo paths from worktrees that have non-deleted tasks.
 * Used by the hook registry to discover active repos.
 */
export function listActiveRepoPaths(): Array<{ repo_path: string }> {
  return getDb()
    .prepare(
      `SELECT DISTINCT w.repo_path
         FROM tasks t
         JOIN worktrees w ON w.id = t.worktree_id
        WHERE t.runtime_state IN ('running', 'setting_up')
          AND w.repo_path IS NOT NULL`,
    )
    .all() as Array<{ repo_path: string }>;
}

/**
 * Recent distinct repository paths from past tasks (for the "recent repos" picker).
 */
export function listRecentRepoPaths(limit = 10): Array<{ repo_path: string; last_used: string }> {
  return getDb()
    .prepare(
      `SELECT w.repo_path AS repo_path, MAX(t.created_at) as last_used
           FROM tasks t
           INNER JOIN worktrees w ON t.worktree_id = w.id
          WHERE w.repo_path IS NOT NULL
            AND t.deleted_at IS NULL
          GROUP BY w.repo_path
          ORDER BY last_used DESC
          LIMIT ?`,
    )
    .all(limit) as Array<{ repo_path: string; last_used: string }>;
}

/**
 * Find an existing live review task for a given repo_path + pr_number.
 * Returns only the id. Repo-scoped: PR numbers are per-repo, so a repo_path
 * filter is required to avoid matching a same-numbered PR in a different repo.
 * Used by the manual-review-create route and by lookupExistingReviewId.
 */
export function findExistingReviewTask(
  repoPath: string,
  prNumber: number,
): { id: string } | undefined {
  return getDb()
    .prepare(
      `SELECT t.id FROM tasks t JOIN worktrees w ON t.worktree_id = w.id
          WHERE w.repo_path = ? AND t.pr_number = ? AND t.source = 'auto_review'
            AND t.deleted_at IS NULL AND t.runtime_state != 'error'
          ORDER BY t.created_at DESC LIMIT 1`,
    )
    .get(repoPath, prNumber) as { id: string } | undefined;
}

/**
 * Find a live auto_review task that points back at a given source task via
 * review_of_task_id. Used by lookupExistingReviewId in the API layer.
 */
export function findReviewTaskBySource(reviewOfTaskId: string): { id: string } | undefined {
  return getDb()
    .prepare(
      `SELECT id FROM tasks
        WHERE review_of_task_id = ? AND source = 'auto_review'
          AND runtime_state != 'error' AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(reviewOfTaskId) as { id: string } | undefined;
}

/**
 * Count all non-deleted tasks.
 *
 * Verbatim SQL from mcp/read.ts:handleMonitorStatus so Pass 2 can swap that
 * inline getDb() call to this helper.
 */
export function countTasks(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NULL`).get() as {
    n: number;
  };
  return row.n;
}

/** Count tasks currently in 'running' runtime_state (used by health check). */
export function countRunningTasks(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE runtime_state = 'running'`)
    .get() as { n: number };
  return row.n;
}

/** Fetch minimal tmux_session for a task (used in agent hopping). */
export function getTaskTmuxSession(id: string): { tmux_session: string | null } | undefined {
  return getDb().prepare(`SELECT tmux_session FROM tasks WHERE id = ?`).get(id) as
    | { tmux_session: string | null }
    | undefined;
}

/** Fetch just the runtime_state column from a task (used by ensureHookToken). */
export function getTaskRuntimeState(id: string): { runtime_state: string } | undefined {
  return getDb().prepare(`SELECT runtime_state FROM tasks WHERE id = ?`).get(id) as
    | { runtime_state: string }
    | undefined;
}

/**
 * List tasks for scratch GC: idle/setting_up/running scratch tasks (not deleted)
 * so the GC knows which scratch dirs are still alive.
 */
export function listActiveScratchTaskIds(): Array<{ id: string }> {
  return getDb()
    .prepare(
      `SELECT t.id AS id FROM tasks t
         LEFT JOIN worktrees w ON t.worktree_id = w.id
        WHERE w.mode = 'scratch' AND t.runtime_state IN ('idle','setting_up','running')
          AND t.deleted_at IS NULL`,
    )
    .all() as Array<{ id: string }>;
}

// ─── Task writes ──────────────────────────────────────────────────────────────

export interface InsertTaskInput {
  id?: string;
  title: string;
  description: string;
  runtime_state?: string;
  workflow_status?: string;
  initial_prompt?: string | null;
  worktree_id?: string | null;
  agent?: string | null;
  harness_id?: string;
  model?: string | null;
  notify_task_id?: string | null;
  source?: string | null;
  pr_url?: string | null;
  pr_number?: number | null;
  pr_head_sha?: string | null;
  /** Used by review tasks. */
  review_of_task_id?: string | null;
  /** Set on scheduled runs — links back to the `schedules` row that fired them. */
  schedule_id?: string | null;
  /** Another task's id this one depends on. Caller must have run validateDependsOn first. */
  depends_on?: string | null;
}

/** Insert a new task row. Returns the generated id. */
export function insertTask(input: InsertTaskInput): string {
  const id = input.id ?? nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO tasks
         (id, title, description, runtime_state, workflow_status, initial_prompt, worktree_id, agent, harness_id, model, notify_task_id, source, pr_url, pr_number, pr_head_sha, review_of_task_id, schedule_id, depends_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.title,
      input.description,
      input.runtime_state ?? 'idle',
      input.workflow_status ?? 'backlog',
      input.initial_prompt ?? null,
      input.worktree_id ?? null,
      input.agent ?? null,
      input.harness_id ?? 'claude-code',
      input.model ?? null,
      input.notify_task_id ?? null,
      input.source ?? null,
      input.pr_url ?? null,
      input.pr_number ?? null,
      input.pr_head_sha ?? null,
      input.review_of_task_id ?? null,
      input.schedule_id ?? null,
      input.depends_on ?? null,
    );
  logger.info({ task_id: id, operation: 'insertTask' }, 'task inserted');
  return id;
}

/** Set (or clear, with null) the depends_on link. Caller must have run validateDependsOn first. */
export function setDependsOn(id: string, dependsOn: string | null): void {
  getDb()
    .prepare(`UPDATE tasks SET depends_on = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(dependsOn, id);
  logger.info({ task_id: id, depends_on: dependsOn, operation: 'setDependsOn' }, 'depends_on set');
}

/**
 * Validate that `dependsOn` is safe to store as `taskId`'s depends_on.
 *
 * Checks (in order): the target task exists; it isn't `taskId` itself
 * (self-dependency); and it doesn't transitively depend back on `taskId`
 * (a longer cycle). Since a task has at most ONE depends_on, the graph is a
 * forest of chains, so cycle detection is a single forward walk from
 * `dependsOn` — bounded by a visited set so pre-existing corrupt data can't
 * spin the walk forever.
 *
 * Pure validation, no throwing (repositories don't shape HTTP errors) — returns
 * an error message on failure, or null when the edge is safe to write.
 *
 * `taskId` is null when validating for a not-yet-inserted task (task.create):
 * a brand-new id can never already appear in a depends_on chain, so only
 * existence is checked.
 */
export function validateDependsOn(taskId: string | null, dependsOn: string): string | null {
  const target = getTask(dependsOn);
  if (!target) return `depends_on task not found: ${dependsOn}`;
  if (taskId === null) return null;
  if (taskId === dependsOn) return 'a task cannot depend on itself';

  const visited = new Set<string>([taskId]);
  let current: string | null = dependsOn;
  while (current) {
    if (visited.has(current)) return 'depends_on would create a dependency cycle';
    visited.add(current);
    const row = getDb().prepare(`SELECT depends_on FROM tasks WHERE id = ?`).get(current) as
      | { depends_on: string | null }
      | undefined;
    current = row?.depends_on ?? null;
  }
  return null;
}

/**
 * True when `dependsOn` points at a task that has not reached
 * workflow_status 'done' (or points at a task that no longer exists — treated
 * as still-blocked, the safe default). False for null (no dependency).
 */
export function isDependencyUnmet(dependsOn: string | null): boolean {
  if (!dependsOn) return false;
  const dep = getDb().prepare(`SELECT workflow_status FROM tasks WHERE id = ?`).get(dependsOn) as
    | { workflow_status: string }
    | undefined;
  return !dep || dep.workflow_status !== 'done';
}

/**
 * Tasks that named `dependencyTaskId` as their depends_on and are sitting
 * idle at workflow_status='in_progress' — the shape a task is left in when
 * its own start was skipped because this dependency wasn't done yet (see
 * task-service.ts:createTask and task.move's autoStart gate). Used to
 * auto-start/resume them once the dependency completes.
 */
export function listDependentsAwaitingStart(dependencyTaskId: string): Task[] {
  return getDb()
    .prepare(
      `${SELECT_TASK_SQL} WHERE t.depends_on = ? AND t.runtime_state = 'idle'
                            AND t.workflow_status = 'in_progress' AND t.deleted_at IS NULL`,
    )
    .all(dependencyTaskId) as Task[];
}

/**
 * Dynamically update a whitelist of task fields plus always bump updated_at.
 * Keys must be from TASK_WRITABLE_COLUMNS.
 */
export function updateTaskFields(id: string, patch: Partial<Record<string, unknown>>): void {
  const fields: string[] = [];
  const values: SQLQueryBindings[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (!TASK_WRITABLE_COLUMNS.has(key)) {
      throw new Error(`updateTaskFields: column '${key}' is not in the writable allowlist`);
    }
    fields.push(`${key} = ?`);
    values.push(value as SQLQueryBindings);
  }

  if (fields.length === 0) return;

  fields.push(`updated_at = datetime('now')`);
  values.push(id);

  getDb()
    .prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
}

/** Set runtime_state (and always bump updated_at). */
export function setRuntimeState(id: string, state: string, error?: string | null): void {
  if (error !== undefined) {
    getDb()
      .prepare(
        `UPDATE tasks SET runtime_state = ?, error = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(state, error, id);
  } else {
    getDb()
      .prepare(`UPDATE tasks SET runtime_state = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(state, id);
  }
  logger.info(
    { task_id: id, runtime_state: state, operation: 'setRuntimeState' },
    'runtime state updated',
  );
}

/** Set workflow_status (and always bump updated_at). */
export function setWorkflowStatus(id: string, status: string): void {
  getDb()
    .prepare(`UPDATE tasks SET workflow_status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, id);
  logger.info(
    { task_id: id, workflow_status: status, operation: 'setWorkflowStatus' },
    'workflow status updated',
  );
}

/** Set the tmux_session column (called after the session is actually created). */
export function setTmuxSession(id: string, session: string): void {
  getDb()
    .prepare(`UPDATE tasks SET tmux_session = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(session, id);
  logger.info(
    { task_id: id, tmux_session: session, operation: 'setTmuxSession' },
    'tmux_session set',
  );
}

/** Set the linked worktree_id. */
export function setWorktreeId(id: string, worktreeId: string | null): void {
  getDb().prepare(`UPDATE tasks SET worktree_id = ? WHERE id = ?`).run(worktreeId, id);
}

/** Update pr_head_sha (called when a PR gets a new commit). */
export function setPrHeadSha(id: string, prHeadSha: string): void {
  getDb()
    .prepare(`UPDATE tasks SET pr_head_sha = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(prHeadSha, id);
}

/** Set pr_review_requested_at (latest review-request event seen for the owner). */
export function setPrReviewRequestedAt(id: string, requestedAt: string): void {
  getDb()
    .prepare(
      `UPDATE tasks SET pr_review_requested_at = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(requestedAt, id);
}

/** Touch last_viewed_at for a single task. */
export function touchLastViewed(id: string): void {
  getDb().prepare(`UPDATE tasks SET last_viewed_at = datetime('now') WHERE id = ?`).run(id);
}

/** Touch last_viewed_at for ALL tasks. Returns the number of changed rows. */
export function touchAllLastViewed(): number {
  const info = getDb().prepare(`UPDATE tasks SET last_viewed_at = datetime('now')`).run();
  return info.changes;
}

/** Soft-delete a task. */
export function softDeleteTask(id: string): void {
  getDb()
    .prepare(
      `UPDATE tasks SET deleted_at = datetime('now'),
                        runtime_state = 'idle',
                        updated_at = datetime('now')
         WHERE id = ?`,
    )
    .run(id);
  logger.info({ task_id: id, operation: 'softDeleteTask' }, 'task soft-deleted');
}

/** Restore a soft-deleted task (clear deleted_at). */
export function restoreTask(id: string): void {
  getDb()
    .prepare(`UPDATE tasks SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?`)
    .run(id);
  logger.info({ task_id: id, operation: 'restoreTask' }, 'task restored from trash');
}

/** Hard-delete a task row (call after deleteTask cleanup is done). */
export function hardDeleteTask(id: string): void {
  // Plugin facts are task-scoped and die with the task (SHR-255). `plugin_facts`
  // deliberately has no FK on task_id — the table is an observation log written
  // by out-of-process plugins, and a FK would make a fact write fail on a task
  // row that is mid-delete. Cleanup is explicit here instead. Ordered BEFORE the
  // task row goes so a crash between the two leaves orphaned facts (harmless,
  // task-keyed, never read) rather than a live task whose facts just vanished.
  deleteFactsForTask(id);
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  logger.info({ task_id: id, operation: 'hardDeleteTask' }, 'task hard-deleted');
}

/**
 * Insert a task row only when no row with the same id already exists
 * (INSERT OR IGNORE). Used by the test seed endpoint to make seeding idempotent.
 */
export function insertTaskIfAbsent(input: {
  id: string;
  title: string;
  description: string;
  runtime_state: string;
  workflow_status: string;
  source?: string | null;
  worktree_id?: string | null;
  pr_url?: string | null;
  pr_number?: number | null;
  pr_head_sha?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO tasks
         (id, title, description, runtime_state, workflow_status, source, worktree_id,
          pr_url, pr_number, pr_head_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.title,
      input.description,
      input.runtime_state,
      input.workflow_status,
      input.source ?? null,
      input.worktree_id ?? null,
      input.pr_url ?? null,
      input.pr_number ?? null,
      input.pr_head_sha ?? null,
    );
}

/**
 * Transition runtime_state to 'running', clear error, flip workflow_status from
 * backlog/planned to in_progress — mirrors the startTask sequence in task-runner.
 */
export function markTaskRunning(id: string): void {
  getDb()
    .prepare(
      `UPDATE tasks SET runtime_state = 'running', error = NULL,
       workflow_status = CASE
         WHEN workflow_status IN ('backlog', 'planned') THEN 'in_progress'
         ELSE workflow_status
       END,
       updated_at = datetime('now') WHERE id = ?`,
    )
    .run(id);
  logger.info({ task_id: id, operation: 'markTaskRunning' }, 'task marked running');
}

/** Bump updated_at without changing any other field. */
export function touchUpdatedAt(id: string): void {
  getDb().prepare(`UPDATE tasks SET updated_at = datetime('now') WHERE id = ?`).run(id);
}

/** Unlink the worktree (set worktree_id = NULL) without deleting the task. */
export function unlinkWorktree(id: string): void {
  getDb().prepare(`UPDATE tasks SET worktree_id = NULL WHERE id = ?`).run(id);
}

/** Unlink all tasks that reference a given worktree_id. */
export function unlinkWorktreeFromAllTasks(worktreeId: string): void {
  getDb().prepare('UPDATE tasks SET worktree_id = NULL WHERE worktree_id = ?').run(worktreeId);
}

/**
 * Fetch id + workflow_status for a task. Used by hook handlers to check
 * the current workflow status before emitting auto-transitions.
 */
export function getTaskWorkflowStatus(
  id: string,
): { id: string; workflow_status: string } | undefined {
  return getDb().prepare(`SELECT id, workflow_status FROM tasks WHERE id = ?`).get(id) as
    | { id: string; workflow_status: string }
    | undefined;
}

/**
 * Fetch the worktree filesystem path for a task via its linked worktree row.
 * Returns undefined when the task has no worktree or the worktree has no path.
 */
export function getWorktreePathForTask(taskId: string): { worktree: string | null } | undefined {
  return getDb()
    .prepare(
      `SELECT w.path AS worktree FROM tasks t
         JOIN worktrees w ON t.worktree_id = w.id
        WHERE t.id = ?`,
    )
    .get(taskId) as { worktree: string | null } | undefined;
}

/**
 * Distinct repo_paths from tasks+worktrees for all non-deleted tasks, ordered by
 * most recently created task. Used by pollReviewerRequests.
 */
export function listTaskRepoPaths(): Array<{ repo_path: string }> {
  return getDb()
    .prepare(
      `SELECT w.repo_path AS repo_path
         FROM tasks t
         INNER JOIN worktrees w ON t.worktree_id = w.id
        WHERE w.repo_path IS NOT NULL
          AND t.deleted_at IS NULL
        GROUP BY w.repo_path
        ORDER BY MAX(t.created_at) DESC`,
    )
    .all() as Array<{ repo_path: string }>;
}

/**
 * List tasks that are running or setting_up with a non-null worktree path.
 * Used by ensureHooksInstalled.
 */
export function listActiveTasksForHooks(): Task[] {
  return getDb()
    .prepare(
      `${SELECT_TASK_SQL} WHERE t.runtime_state IN ('running', 'setting_up') AND w.path IS NOT NULL`,
    )
    .all() as Task[];
}

/**
 * Fetch tmux_session for a parent task only when it is running or setting_up.
 * Used by notifyParentTask before sending a completion message.
 */
export function getParentTaskTmuxSession(
  taskId: string,
): { tmux_session: string | null } | undefined {
  return getDb()
    .prepare(
      `SELECT tmux_session FROM tasks WHERE id = ? AND runtime_state IN ('running', 'setting_up')`,
    )
    .get(taskId) as { tmux_session: string | null } | undefined;
}

/**
 * Transition a task from running to idle (tmux session disappeared).
 * Bumps updated_at. Used by pollStatuses.
 */
export function setRuntimeStateIdle(id: string): void {
  getDb()
    .prepare(`UPDATE tasks SET runtime_state = 'idle', updated_at = datetime('now') WHERE id = ?`)
    .run(id);
}

/**
 * Transition a task from setting_up to error with a fixed message
 * (Setup interrupted). Bumps updated_at. Used by pollStatuses.
 */
export function setRuntimeStateSetupInterrupted(id: string): void {
  getDb()
    .prepare(
      `UPDATE tasks SET runtime_state = 'error', error = 'Setup interrupted', updated_at = datetime('now') WHERE id = ?`,
    )
    .run(id);
}

/**
 * Update pr_url + pr_number and conditionally flip workflow_status from
 * in_progress/human_review to 'pr'. Bumps updated_at. Used by pollPRs.
 */
export function setTaskPrDetected(id: string, prUrl: string, prNumber: number): void {
  getDb()
    .prepare(
      `UPDATE tasks SET pr_url = ?, pr_number = ?,
       workflow_status = CASE WHEN workflow_status IN ('in_progress','human_review') THEN 'pr' ELSE workflow_status END,
       updated_at = datetime('now') WHERE id = ?`,
    )
    .run(prUrl, prNumber, id);
}

/**
 * Update pr_head_sha + initial_prompt together (idle review task SHA update).
 * Used by upsertReviewTask when the task is idle and the PR head has advanced.
 */
export function updateTaskPromptAndSha(id: string, prHeadSha: string, initialPrompt: string): void {
  getDb()
    .prepare(
      `UPDATE tasks SET pr_head_sha = ?, initial_prompt = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(prHeadSha, initialPrompt, id);
}

/**
 * Set workflow_status to 'done' (after PR merge). Bumps updated_at.
 * Used by checkMergedPRs.
 */
export function setWorkflowStatusDone(id: string): void {
  getDb()
    .prepare(`UPDATE tasks SET workflow_status = 'done', updated_at = datetime('now') WHERE id = ?`)
    .run(id);
}

/**
 * Find an existing review task for a repo + PR number (any runtime_state).
 * Returns minimal fields needed by upsertReviewTask.
 * Unlike findExistingReviewTask (which filters source/deleted), this returns the
 * first non-deleted task for the pr_number across any source.
 */
export function findExistingPrTask(
  repoPath: string,
  prNumber: number,
):
  | {
      id: string;
      runtime_state: string;
      source: string | null;
      pr_head_sha: string | null;
      pr_review_requested_at: string | null;
      initial_prompt: string | null;
      tmux_session: string | null;
      worktree_path: string | null;
    }
  | undefined {
  return getDb()
    .prepare(
      `SELECT t.id AS id, t.runtime_state AS runtime_state,
              t.source AS source,
              t.pr_head_sha AS pr_head_sha,
              t.pr_review_requested_at AS pr_review_requested_at,
              t.initial_prompt AS initial_prompt,
              t.tmux_session AS tmux_session,
              w.path AS worktree_path
         FROM tasks t
         INNER JOIN worktrees w ON t.worktree_id = w.id
        WHERE w.repo_path = ? AND t.pr_number = ?
          AND t.deleted_at IS NULL
        ORDER BY t.created_at DESC LIMIT 1`,
    )
    .get(repoPath, prNumber) as
    | {
        id: string;
        runtime_state: string;
        source: string | null;
        pr_head_sha: string | null;
        pr_review_requested_at: string | null;
        initial_prompt: string | null;
        tmux_session: string | null;
        worktree_path: string | null;
      }
    | undefined;
}

/**
 * True when a soft-deleted (trashed) auto-review task still exists for the
 * repo+PR. Used by the reviewer poller to avoid resurrecting a review the user
 * just deleted — the trashed task's worktree is only removed when the trash
 * purges, so recreating early would also collide with the leftover worktree.
 */
export function hasTrashedPrReviewTask(repoPath: string, prNumber: number): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM tasks t
         INNER JOIN worktrees w ON t.worktree_id = w.id
        WHERE w.repo_path = ? AND t.pr_number = ?
          AND t.source = 'auto_review' AND t.deleted_at IS NOT NULL
        LIMIT 1`,
    )
    .get(repoPath, prNumber);
  return row !== undefined;
}

/**
 * List idle auto-review draft tasks for a given repo_path.
 * Used by cleanupResolvedReviews to find and purge drafts whose PR is no
 * longer awaiting review. "Draft" = never started: a task that has worker rows
 * is a closed-but-resumable review session, kept until its PR merges/closes.
 */
export function listAutoReviewDrafts(
  repoPath: string,
): Array<{ id: string; pr_number: number | null; worktree_id: string | null }> {
  return getDb()
    .prepare(
      `SELECT t.id AS id, t.pr_number AS pr_number, t.worktree_id AS worktree_id FROM tasks t
         LEFT JOIN worktrees w ON t.worktree_id = w.id
        WHERE w.repo_path = ? AND t.source = 'auto_review' AND t.runtime_state = 'idle'
          AND t.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM workers wk WHERE wk.task_id = t.id)`,
    )
    .all(repoPath) as Array<{ id: string; pr_number: number | null; worktree_id: string | null }>;
}

/**
 * List idle (closed or never-started) auto-review tasks that still point at a
 * PR. Used by cleanupResolvedReviews to trash review sessions once their PR is
 * merged or closed, so reviews never dangle past the PR's life.
 */
export function listIdleAutoReviewTasksWithPr(
  repoPath: string,
): Array<{ id: string; pr_number: number }> {
  return getDb()
    .prepare(
      `SELECT t.id AS id, t.pr_number AS pr_number FROM tasks t
         LEFT JOIN worktrees w ON t.worktree_id = w.id
        WHERE w.repo_path = ? AND t.source = 'auto_review' AND t.runtime_state = 'idle'
          AND t.pr_number IS NOT NULL AND t.deleted_at IS NULL`,
    )
    .all(repoPath) as Array<{ id: string; pr_number: number }>;
}

/**
 * List tasks whose runtime_state = 'running' and pr_number IS NOT NULL.
 * Used by checkMergedPRs to find tasks that might have had their PR merged.
 */
export function listRunningTasksWithPr(): Task[] {
  return getDb()
    .prepare(
      `${SELECT_TASK_SQL} WHERE t.runtime_state = 'running' AND t.pr_number IS NOT NULL AND t.workflow_status != 'done'`,
    )
    .all() as Task[];
}

/**
 * List running/idle tasks with a branch set. Used by pollPRs to detect PRs.
 * We intentionally keep polling AFTER the first PR is found (no `pr_url IS NULL`
 * gate): a long-running task can open several slice PRs over its life, and the
 * poller discovers each `agents/<id>*` branch's PR. The workflow → 'pr'
 * transition is guarded on the null→non-null flip in pollPRs, so re-polling an
 * already-PR'd task is idempotent.
 */
export function listTasksNeedingPrDetection(): Task[] {
  return getDb()
    .prepare(
      `${SELECT_TASK_SQL} WHERE t.runtime_state IN ('running', 'idle') AND w.branch IS NOT NULL`,
    )
    .all() as Task[];
}

/**
 * List active (running/setting_up) none-mode tasks sharing a root worktree at
 * repoPath, with their branch. Optionally excludes a single task id. Used by
 * preflightNoneMode to detect checkout conflicts.
 */
export function listNoneModeActiveTasks(
  repoPath: string,
  excludeTaskId?: string,
): Array<{ task_id: string; title: string; runtime_state: string; branch: string | null }> {
  if (excludeTaskId) {
    return getDb()
      .prepare(
        `SELECT t.id AS task_id, t.title, t.runtime_state, w.branch
             FROM tasks t
             INNER JOIN worktrees w ON t.worktree_id = w.id
            WHERE t.runtime_state IN ('running', 'setting_up')
              AND w.repo_path = ?
              AND w.mode = 'none'
              AND t.id != ?`,
      )
      .all(repoPath, excludeTaskId) as Array<{
      task_id: string;
      title: string;
      runtime_state: string;
      branch: string | null;
    }>;
  }
  return getDb()
    .prepare(
      `SELECT t.id AS task_id, t.title, t.runtime_state, w.branch
             FROM tasks t
             INNER JOIN worktrees w ON t.worktree_id = w.id
            WHERE t.runtime_state IN ('running', 'setting_up')
              AND w.repo_path = ?
              AND w.mode = 'none'`,
    )
    .all(repoPath) as Array<{
    task_id: string;
    title: string;
    runtime_state: string;
    branch: string | null;
  }>;
}

/**
 * List tasks that are candidates for the quiescence → human_review transition.
 * A task qualifies when:
 *   - workflow_status = 'in_progress'
 *   - runtime_state = 'running' (excludes looping / idle / etc.)
 *   - NOT deleted
 *   - has at least one worker
 *   - every non-stopped worker has hook_activity = 'idle'
 *   - the most-recent hook_activity_updated_at across all non-stopped workers is
 *     older than debounceMs (continuous idle for at least the debounce window)
 *
 * The orchestrator-managed guard and pending-prompt guard are applied in JS
 * after fetching (simpler to test, no extra joins needed).
 *
 * Returns task ids only — callers load full state via getTaskWorkflowStatus.
 */
export function listTasksAwaitingQuiescence(debounceMs: number): Array<{ id: string }> {
  return getDb()
    .prepare(
      `SELECT t.id
         FROM tasks t
        WHERE t.workflow_status = 'in_progress'
          AND t.runtime_state = 'running'
          AND t.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM workers w WHERE w.task_id = t.id AND w.status != 'stopped'
          )
          AND NOT EXISTS (
            SELECT 1 FROM workers w
             WHERE w.task_id = t.id
               AND w.status != 'stopped'
               AND w.hook_activity != 'idle'
          )
          AND (
            SELECT MAX(w.hook_activity_updated_at)
              FROM workers w
             WHERE w.task_id = t.id AND w.status != 'stopped'
          ) <= datetime('now', ? || ' seconds')`,
    )
    .all(`-${Math.ceil(debounceMs / 1000)}`) as Array<{ id: string }>;
}

/**
 * Auto-review tasks whose agent looks stalled: still running, but no hook
 * activity for stallMs. A turn that dies on a dropped API stream never fires
 * the Stop hook, so hook_activity stays 'active' with a stale timestamp —
 * unlike quiescence, this deliberately does NOT require hook_activity='idle'.
 *
 * Nudge bookkeeping lives in task_updates (kind='note', body='auto: stall
 * nudge'): tasks already nudged maxNudges times, or nudged within the last
 * stallMs, are excluded so the sweep can't spam a dead session.
 */
export function listStalledAutoReviewTasks(
  stallMs: number,
  maxNudges: number,
): Array<{ id: string; tmux_session: string }> {
  const cutoff = `-${Math.ceil(stallMs / 1000)}`;
  return getDb()
    .prepare(
      `SELECT t.id, t.tmux_session
         FROM tasks t
        WHERE t.source = 'auto_review'
          AND t.runtime_state = 'running'
          AND t.deleted_at IS NULL
          AND t.tmux_session IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM workers w WHERE w.task_id = t.id AND w.status != 'stopped'
          )
          AND (
            SELECT MAX(w.hook_activity_updated_at)
              FROM workers w
             WHERE w.task_id = t.id AND w.status != 'stopped'
          ) <= datetime('now', ? || ' seconds')
          AND (
            SELECT COUNT(*) FROM task_updates u
             WHERE u.task_id = t.id AND u.kind = 'note' AND u.body = 'auto: stall nudge'
          ) < ?
          AND NOT EXISTS (
            SELECT 1 FROM task_updates u
             WHERE u.task_id = t.id AND u.kind = 'note' AND u.body = 'auto: stall nudge'
               AND u.created_at > datetime('now', ? || ' seconds')
          )`,
    )
    .all(cutoff, maxNudges, cutoff) as Array<{ id: string; tmux_session: string }>;
}

/**
 * Tasks that need the user's attention right now: pending permission prompts,
 * or errored tasks whose error hasn't been viewed. Used by the inbox.
 */
export function listNeedsYouTasks(): Task[] {
  return getDb()
    .prepare(
      `SELECT DISTINCT t.*
       FROM tasks t
       WHERE t.deleted_at IS NULL
         AND (t.source IS NULL OR t.source <> 'auto_review')
         AND (
           EXISTS (
             SELECT 1 FROM permission_prompts pp
             WHERE pp.task_id = t.id AND pp.status = 'pending'
           )
         OR (
           t.runtime_state = 'error'
           AND (t.last_viewed_at IS NULL OR t.last_viewed_at < t.updated_at)
         )
       )
       ORDER BY t.updated_at DESC`,
    )
    .all() as Task[];
}

/**
 * Closed tasks from the last 7 days that the user hasn't seen since they were
 * updated. Excludes anything already in the needs-you bucket. Used by the inbox.
 */
export function listActivityTasks(): Task[] {
  return getDb()
    .prepare(
      `SELECT t.*
       FROM tasks t
       WHERE t.deleted_at IS NULL
         AND (t.source IS NULL OR t.source <> 'auto_review')
         AND t.runtime_state = 'idle'
         AND (t.last_viewed_at IS NULL OR t.last_viewed_at < t.updated_at)
         AND t.updated_at > datetime('now', '-7 days')
         AND NOT EXISTS (
           SELECT 1 FROM permission_prompts pp
           WHERE pp.task_id = t.id AND pp.status = 'pending'
         )
       ORDER BY t.updated_at DESC
       LIMIT 50`,
    )
    .all() as Task[];
}

// ─── task_updates ─────────────────────────────────────────────────────────────

export interface AddTaskUpdateInput {
  id?: string;
  task_id: string;
  agent_id?: string | null;
  kind: 'transition' | 'summary' | 'note';
  from_status?: string | null;
  to_status?: string | null;
  body?: string | null;
}

/** Insert a new task_updates row. Returns the generated id. */
export function addTaskUpdate(input: AddTaskUpdateInput): string {
  const id = input.id ?? nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO task_updates (id, task_id, agent_id, kind, from_status, to_status, body) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.task_id,
      input.agent_id ?? null,
      input.kind,
      input.from_status ?? null,
      input.to_status ?? null,
      input.body ?? null,
    );
  return id;
}

/**
 * List recent task_updates of kind summary/transition/note for a task, newest
 * first, capped at `limit`. Used by summarize.ts to build the agent transcript.
 */
export function listTaskUpdatesForTranscript(
  taskId: string,
  limit = 30,
): Array<{
  kind: string;
  from_status: string | null;
  to_status: string | null;
  body: string | null;
  created_at: string;
}> {
  return getDb()
    .prepare(
      `SELECT kind, from_status, to_status, body, created_at
         FROM task_updates
        WHERE task_id = ? AND kind IN ('summary', 'transition', 'note')
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(taskId, limit) as Array<{
    kind: string;
    from_status: string | null;
    to_status: string | null;
    body: string | null;
    created_at: string;
  }>;
}

/** List task_updates for a task, newest first, with optional limit. */
export function listTaskUpdates(taskId: string, limit = 100): TaskUpdate[] {
  const safeLimit = Math.min(Math.max(limit, 1), 1000);
  return getDb()
    .prepare(`SELECT * FROM task_updates WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(taskId, safeLimit) as TaskUpdate[];
}

// ─── task_external_refs ───────────────────────────────────────────────────────

/** Raw DB row shape (metadata is stored as JSON text). */
interface ExternalRefRow {
  task_id: string;
  integration: string;
  ref: string;
  url: string | null;
  metadata: string | null;
  created_at: string;
}

function parseRefRow(row: ExternalRefRow): TaskExternalRef {
  return {
    ...row,
    metadata: JSON.parse(row.metadata ?? 'null') as Record<string, unknown> | null,
  };
}

/** Get all external refs for a task, ordered by created_at ASC. */
export function getTaskExternalRefs(taskId: string): TaskExternalRef[] {
  const rows = getDb()
    .prepare('SELECT * FROM task_external_refs WHERE task_id = ? ORDER BY created_at ASC')
    .all(taskId) as ExternalRefRow[];
  return rows.map(parseRefRow);
}

/** Get a single external ref by task_id + integration. */
export function getTaskExternalRef(
  taskId: string,
  integration: string,
): TaskExternalRef | undefined {
  const row = getDb()
    .prepare('SELECT * FROM task_external_refs WHERE task_id = ? AND integration = ?')
    .get(taskId, integration) as ExternalRefRow | undefined;
  return row ? parseRefRow(row) : undefined;
}

export interface UpsertTaskExternalRefInput {
  task_id: string;
  integration: string;
  ref: string;
  url?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Upsert (INSERT OR REPLACE) an external ref. */
export function upsertTaskExternalRef(input: UpsertTaskExternalRefInput): TaskExternalRef {
  const metadataJson =
    input.metadata != null && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? JSON.stringify(input.metadata)
      : null;

  getDb()
    .prepare(
      `INSERT OR REPLACE INTO task_external_refs (task_id, integration, ref, url, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(input.task_id, input.integration, input.ref, input.url ?? null, metadataJson);

  logger.info(
    { task_id: input.task_id, integration: input.integration, operation: 'upsertTaskExternalRef' },
    'external ref upserted',
  );

  return getTaskExternalRef(input.task_id, input.integration)!;
}

/**
 * Insert an external ref only when no row already exists (INSERT OR IGNORE).
 * Used by the branch-name ref-inference path.
 */
export function insertTaskExternalRefIfAbsent(input: {
  task_id: string;
  integration: string;
  ref: string;
  url?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO task_external_refs (task_id, integration, ref, url, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
    .run(input.task_id, input.integration, input.ref, input.url ?? null);
}

/** Delete an external ref. */
export function deleteTaskExternalRef(taskId: string, integration: string): void {
  getDb()
    .prepare('DELETE FROM task_external_refs WHERE task_id = ? AND integration = ?')
    .run(taskId, integration);
  logger.info(
    { task_id: taskId, integration, operation: 'deleteTaskExternalRef' },
    'external ref deleted',
  );
}
