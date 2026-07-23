import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';
import type { AgentLearning } from '../types.js';

const logger = childLogger('agent-learnings');
export const SHARED_LANE = 'shared';
const DEFAULT_READ_LIMIT = 6;
const norm = (s: string): string => s.trim().toLowerCase();

export function laneFor(task: { schedule_id?: string | null; id: string }): string {
  return task.schedule_id ? `schedule:${task.schedule_id}` : `loop:${task.id}`;
}

export interface AddLearningInput {
  repo_path: string;
  lane: string;
  trigger: string;
  lesson: string;
  evidence?: string | null;
  source_run_id?: string | null;
  source_commit?: string | null;
}

export function addLearning(input: AddLearningInput): AgentLearning | null {
  const existing = getDb()
    .prepare(
      `SELECT id FROM agent_learnings WHERE repo_path = ? AND lane = ? AND lower(trim(lesson)) = ?`,
    )
    .get(input.repo_path, input.lane, norm(input.lesson));
  if (existing) {
    logger.info({ repo_path: input.repo_path, lane: input.lane }, 'learning deduped (skipped)');
    return null;
  }
  const id = nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO agent_learnings (id, repo_path, lane, trigger, lesson, evidence, source_run_id, source_commit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.repo_path,
      input.lane,
      input.trigger,
      input.lesson,
      input.evidence ?? null,
      input.source_run_id ?? null,
      input.source_commit ?? null,
    );
  logger.info({ learning_id: id, repo_path: input.repo_path, lane: input.lane }, 'learning added');
  return getDb().prepare(`SELECT * FROM agent_learnings WHERE id = ?`).get(id) as AgentLearning;
}

export function listForRead(
  repoPath: string,
  ownLane: string,
  opts: { limit?: number } = {},
): AgentLearning[] {
  return getDb()
    .prepare(
      `SELECT * FROM agent_learnings
         WHERE repo_path = ? AND lane IN (?, ?) AND superseded_at IS NULL
       ORDER BY (last_used_at IS NULL) ASC, last_used_at DESC, usage_count DESC, created_at DESC
       LIMIT ?`,
    )
    .all(repoPath, SHARED_LANE, ownLane, opts.limit ?? DEFAULT_READ_LIMIT) as AgentLearning[];
}

export function touchLearning(id: string): void {
  getDb()
    .prepare(
      `UPDATE agent_learnings SET usage_count = usage_count + 1, last_used_at = datetime('now') WHERE id = ?`,
    )
    .run(id);
}

export function deleteLearning(id: string): void {
  getDb().prepare(`DELETE FROM agent_learnings WHERE id = ?`).run(id);
}

export function getLearning(id: string): AgentLearning | undefined {
  return getDb().prepare(`SELECT * FROM agent_learnings WHERE id = ?`).get(id) as
    | AgentLearning
    | undefined;
}

/**
 * Soft-supersede: mark a now-false learning as retired without deleting it.
 * Reversible (the row stays, just filtered out of reads) and auditable (the
 * reason it went stale is itself signal for the weekly digest). Hard delete
 * stays a human/digest action via `deleteLearning`.
 */
export function supersedeLearning(id: string, reason: string): void {
  getDb()
    .prepare(
      `UPDATE agent_learnings SET superseded_at = datetime('now'), superseded_reason = ? WHERE id = ?`,
    )
    .run(reason, id);
  logger.info({ learning_id: id }, 'learning superseded');
}

export function searchForRead(
  repoPath: string,
  ownLane: string,
  query: string,
  opts: { limit?: number } = {},
): AgentLearning[] {
  const q = `%${query.trim()}%`;
  return getDb()
    .prepare(
      `SELECT * FROM agent_learnings
         WHERE repo_path = ? AND lane IN (?, ?) AND superseded_at IS NULL
           AND (trigger LIKE ? OR lesson LIKE ?)
       ORDER BY (last_used_at IS NULL) ASC, last_used_at DESC, usage_count DESC, created_at DESC
       LIMIT ?`,
    )
    .all(repoPath, SHARED_LANE, ownLane, q, q, opts.limit ?? 8) as AgentLearning[];
}

export function listForDigest(
  repoPath: string,
  sinceIso: string,
): { additions: AgentLearning[]; unused: AgentLearning[]; superseded: AgentLearning[] } {
  const additions = getDb()
    .prepare(
      `SELECT * FROM agent_learnings WHERE repo_path = ? AND created_at >= ? ORDER BY created_at DESC`,
    )
    .all(repoPath, sinceIso) as AgentLearning[];
  const unused = getDb()
    .prepare(
      `SELECT * FROM agent_learnings WHERE repo_path = ? AND usage_count = 0 AND superseded_at IS NULL ORDER BY created_at ASC`,
    )
    .all(repoPath) as AgentLearning[];
  const superseded = getDb()
    .prepare(
      `SELECT * FROM agent_learnings WHERE repo_path = ? AND superseded_at IS NOT NULL ORDER BY superseded_at DESC`,
    )
    .all(repoPath) as AgentLearning[];
  return { additions, unused, superseded };
}

export interface LearningsBenefit {
  seededPassRate: number;
  unseededPassRate: number;
  seededN: number;
  unseededN: number;
}

/**
 * Benefit metric for the weekly digest: verify-pass rate for loop iterations
 * that had past learnings seeded into their prompt vs. ones that didn't.
 * `tasks` has no raw `repo_path` column (it moved to `worktrees` in Phase 2a —
 * see `server/task-select.ts`), so the repo filter joins through `worktrees`.
 */
export function listBenefit(repoPath: string): LearningsBenefit {
  const rows = getDb()
    .prepare(
      `SELECT
         CASE WHEN li.learnings_seeded > 0 THEN 1 ELSE 0 END AS seeded,
         COUNT(*) AS n,
         SUM(CASE WHEN li.verify_passed = 1 THEN 1 ELSE 0 END) AS passed
       FROM loop_iterations li
       JOIN loop_runs lr ON lr.id = li.loop_run_id
       JOIN tasks t ON t.id = lr.task_id
       JOIN worktrees w ON w.id = t.worktree_id
       WHERE w.repo_path = ?
       GROUP BY seeded`,
    )
    .all(repoPath) as { seeded: number; n: number; passed: number }[];

  const seededRow = rows.find((r) => r.seeded === 1);
  const unseededRow = rows.find((r) => r.seeded === 0);
  const seededN = seededRow?.n ?? 0;
  const unseededN = unseededRow?.n ?? 0;
  return {
    seededN,
    unseededN,
    seededPassRate: seededN > 0 ? (seededRow?.passed ?? 0) / seededN : 0,
    unseededPassRate: unseededN > 0 ? (unseededRow?.passed ?? 0) / unseededN : 0,
  };
}
