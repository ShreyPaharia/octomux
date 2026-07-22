import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';
import type { LoopGroup, LoopRun } from '../types.js';

const logger = childLogger('loop-groups');

export interface CreateLoopGroupInput {
  spec_json: string;
  n: number;
  repo_path: string;
  base_branch: string;
}

export function createLoopGroup(input: CreateLoopGroupInput): LoopGroup {
  const id = nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO loop_groups (id, spec_json, n, repo_path, base_branch)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, input.spec_json, input.n, input.repo_path, input.base_branch);
  const row = getLoopGroup(id);
  if (!row) throw new Error('failed to read loop_group after insert');
  logger.info({ loop_group_id: id, n: input.n }, 'loop_group created');
  return row;
}

export function getLoopGroup(id: string): LoopGroup | undefined {
  return getDb().prepare(`SELECT * FROM loop_groups WHERE id = ?`).get(id) as LoopGroup | undefined;
}

export function listLoopGroups(): LoopGroup[] {
  return getDb().prepare(`SELECT * FROM loop_groups ORDER BY created_at DESC`).all() as LoopGroup[];
}

export function listLoopRunsForGroup(groupId: string): LoopRun[] {
  return getDb()
    .prepare(`SELECT * FROM loop_runs WHERE group_id = ? ORDER BY created_at ASC`)
    .all(groupId) as LoopRun[];
}

export function setJudgeRunning(groupId: string): void {
  getDb()
    .prepare(
      `UPDATE loop_groups SET judge_status = 'running', updated_at = datetime('now') WHERE id = ?`,
    )
    .run(groupId);
  logger.info({ loop_group_id: groupId }, 'loop_group: judge running');
}

export function recordJudgeResult(
  groupId: string,
  winnerLoopRunId: string,
  rationale: string,
): void {
  getDb()
    .prepare(
      `UPDATE loop_groups
       SET judge_status = 'done', winner_loop_run_id = ?, judge_rationale = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(winnerLoopRunId, rationale, groupId);
  logger.info(
    { loop_group_id: groupId, winner_loop_run_id: winnerLoopRunId },
    'loop_group: judged',
  );
}
