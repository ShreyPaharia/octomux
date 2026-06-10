/**
 * Shared SELECT clause for loading Task rows.
 *
 * After Phase 2a dropped the denormalised worktree columns off `tasks`, the
 * Task type's flat shape (branch, base_branch, worktree path, base_sha,
 * repo_path, run_mode) is populated by LEFT JOIN-ing the linked worktrees
 * row. Every reader in the codebase uses this to keep consumers unchanged.
 */
export const SELECT_TASK_SQL = `
  SELECT t.id, t.title, t.description, t.runtime_state, t.workflow_status,
         t.tmux_session,
         t.pr_url, t.pr_number, t.pr_head_sha, t.user_window_index,
         t.initial_prompt, t.last_viewed_at, t.deleted_at, t.source, t.worktree_id,
         t.harness_id, t.agent, t.model, t.notify_task_id, t.error, t.current_summary, t.current_summary_updated_at,
         t.created_at, t.updated_at,
         w.path AS worktree,
         w.repo_path AS repo_path,
         w.branch AS branch,
         w.base_branch AS base_branch,
         w.base_sha AS base_sha,
         COALESCE(w.mode, 'new') AS run_mode
    FROM tasks t
    LEFT JOIN worktrees w ON t.worktree_id = w.id
`;

/** Predicate on the joined worktree's path column (was `tasks.worktree`). */
export const WHERE_WORKTREE_PATH_NOT_NULL = 'w.path IS NOT NULL';
/** Predicate on the joined worktree's branch column (was `tasks.branch`). */
export const WHERE_WORKTREE_BRANCH_NOT_NULL = 'w.branch IS NOT NULL';
/** Predicate on the joined worktree's repo_path (was `tasks.repo_path`). */
export const WHERE_WORKTREE_REPO_PATH_EQUALS = 'w.repo_path = ?';
