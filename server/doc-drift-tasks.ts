import { nanoid } from 'nanoid';
import { insertTask, insertWorktree } from './repositories/index.js';

export interface DocDriftPromptInput {
  /** Id of THIS doc-drift task — pinned in the prompt like extract/loop task ids. */
  docDriftTaskId: string;
  repoShort: string;
}

/** Prompt for the scheduled doc-drift agent. */
export function buildDocDriftPrompt(input: DocDriftPromptInput): string {
  return [
    `Check ${input.repoShort} for drift between its docs and its code, and open a fix PR for what you find.`,
    '',
    `Doc-drift task id: ${input.docDriftTaskId}`,
    '',
    'Use the doc-drift skill to run this task:',
    '  1. Survey the documented surface (README, docs/, CLAUDE.md).',
    '  2. Compare it against the actual code.',
    '  3. Fix drift you find with small, targeted doc edits.',
    '  4. Open one doc-fix PR using your own `gh` — there is no octomux sink for this workflow.',
    '',
    'Read the doc-drift skill (SKILL.md) for the full verify contract before starting.',
  ].join('\n');
}

export interface InsertDocDriftTaskParams {
  id?: string;
  repoPath: string;
  branch: string;
  baseBranch: string;
  baseSha?: string | null;
  title: string;
  description: string;
  initialPrompt: string;
  /** Set when this task was fired by a schedule — stamps tasks.schedule_id. */
  scheduleId?: string;
}

/**
 * Shared doc-drift-task creation: materialises a worktree row and a task row in
 * the `doc_drift` source class. Returns the new task id.
 */
export function insertDocDriftTask(params: InsertDocDriftTaskParams): string {
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
    initial_prompt: params.initialPrompt,
    source: 'doc_drift',
    worktree_id: worktreeId,
    schedule_id: params.scheduleId ?? null,
  });

  return id;
}
