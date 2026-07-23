import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';
import type { PrExtract, PrExtractRisk } from '../types.js';

const logger = childLogger('repositories/pr-extracts');

interface PrExtractRow {
  id: string;
  task_id: string;
  repo_path: string;
  pr_number: number;
  pr_head_sha: string;
  area: string;
  risk: string;
  has_migration: number;
  surface: string;
  loc: number;
  created_at: string;
}

function toPrExtract(row: PrExtractRow): PrExtract {
  return {
    id: row.id,
    task_id: row.task_id,
    repo_path: row.repo_path,
    pr_number: row.pr_number,
    pr_head_sha: row.pr_head_sha,
    area: row.area,
    risk: row.risk as PrExtractRisk,
    has_migration: row.has_migration === 1,
    surface: row.surface,
    loc: row.loc,
    created_at: row.created_at,
  };
}

export interface CreateExtractInput {
  id?: string;
  taskId: string;
  repoPath: string;
  prNumber: number;
  prHeadSha: string;
  area: string;
  risk: PrExtractRisk;
  hasMigration: boolean;
  surface: string;
  loc: number;
}

export function createExtract(input: CreateExtractInput): PrExtract {
  const id = input.id ?? nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO pr_extracts
         (id, task_id, repo_path, pr_number, pr_head_sha, area, risk, has_migration, surface, loc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.taskId,
      input.repoPath,
      input.prNumber,
      input.prHeadSha,
      input.area,
      input.risk,
      input.hasMigration ? 1 : 0,
      input.surface,
      input.loc,
    );
  logger.info({ task_id: input.taskId, extract_id: id }, 'pr_extract created');
  return getExtract(id)!;
}

export function getExtract(id: string): PrExtract | undefined {
  const row = getDb().prepare(`SELECT * FROM pr_extracts WHERE id = ?`).get(id) as
    | PrExtractRow
    | undefined;
  return row ? toPrExtract(row) : undefined;
}

export function getExtractByTaskId(taskId: string): PrExtract | undefined {
  const row = getDb().prepare(`SELECT * FROM pr_extracts WHERE task_id = ?`).get(taskId) as
    | PrExtractRow
    | undefined;
  return row ? toPrExtract(row) : undefined;
}

export function listExtracts(): PrExtract[] {
  const rows = getDb()
    .prepare(`SELECT * FROM pr_extracts ORDER BY rowid DESC`)
    .all() as PrExtractRow[];
  return rows.map(toPrExtract);
}
