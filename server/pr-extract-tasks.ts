import { nanoid } from 'nanoid';
import { insertTask, insertWorktree } from './repositories/index.js';

export interface PrExtractPromptInput {
  /** Id of THIS extract task — the id passed to `octomux pr-extract emit`. */
  extractTaskId: string;
  title: string;
  number: number;
  url: string;
  headRefOid: string;
  repoShort: string;
}

/** Prompt for the merged-PR structured-extraction agent. */
export function buildPrExtractPrompt(input: PrExtractPromptInput): string {
  return [
    `Extract structured metadata from a merged pull request.`,
    '',
    `Extract task id: ${input.extractTaskId}`,
    `PR: ${input.title} (#${input.number})`,
    `URL: ${input.url}`,
    `Merged head: ${input.headRefOid}`,
    `Repo: ${input.repoShort}`,
    '',
    'Inspect the merged diff (already checked out at the merge head in this worktree) and determine:',
    '  - area: the primary subsystem touched (e.g. "server", "frontend", "cli", "docs")',
    '  - risk: "low" | "medium" | "high" — your assessment of blast radius',
    '  - has_migration: true if the diff includes a forward-only DB migration',
    '  - surface: the user-facing surface touched (e.g. "api", "ui", "cli", "internal")',
    '  - loc: total lines changed (added + removed) across the diff',
    '',
    'Report the result with exactly one command, then stop:',
    `  octomux pr-extract emit --task ${input.extractTaskId} --area <area> --risk <low|medium|high> ` +
      '--has-migration <true|false> --surface <surface> --loc <n>',
  ].join('\n');
}

export interface InsertExtractTaskParams {
  id?: string;
  repoPath: string;
  branch: string;
  baseBranch: string;
  baseSha?: string | null;
  title: string;
  description: string;
  initialPrompt: string;
  prUrl: string | null;
  prNumber: number;
  prHeadSha: string;
}

/**
 * Shared extract-task creation: materialises a worktree row and a task row in
 * the `pr_extract` source class. Returns the new task id.
 */
export function insertExtractTask(params: InsertExtractTaskParams): string {
  const id = params.id ?? nanoid(12);
  const worktreeId = nanoid(12);

  insertWorktree({
    id: worktreeId,
    path: '',
    repo_path: params.repoPath,
    branch: params.branch,
    base_branch: params.baseBranch,
    base_sha: params.baseSha ?? null,
    mode: 'new',
    status: 'available',
  });

  insertTask({
    id,
    title: params.title,
    description: params.description,
    runtime_state: 'idle',
    workflow_status: 'backlog',
    pr_url: params.prUrl,
    pr_number: params.prNumber,
    pr_head_sha: params.prHeadSha,
    initial_prompt: params.initialPrompt,
    source: 'pr_extract',
    worktree_id: worktreeId,
  });

  return id;
}
