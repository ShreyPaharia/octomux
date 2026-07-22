import { octomuxSkillRef } from '../../octomux-plugin.js';
import { nanoid } from 'nanoid';
import { insertTask, insertWorktree } from '../../repositories/index.js';

export interface TriagePromptInput {
  /** Id of THIS triage task — pinned in the prompt like extract/loop task ids. */
  triageTaskId: string;
  repoShort: string;
  /** Command the agent runs to fetch prod logs (e.g. `flyctl logs -a my-app`). */
  logCommand: string;
}

/** Prompt for the scheduled prod-log-triage agent. */
export function buildTriagePrompt(input: TriagePromptInput): string {
  return [
    octomuxSkillRef('prod-log-triage'),
    '',
    `Triage task id: ${input.triageTaskId}`,
    `Repo: ${input.repoShort}`,
    `Log command: ${input.logCommand}`,
  ].join('\n');
}

export interface InsertTriageTaskParams {
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
 * Shared triage-task creation: materialises a worktree row and a task row in
 * the `prod_log_triage` source class. Returns the new task id.
 */
export function insertTriageTask(params: InsertTriageTaskParams): string {
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
    source: 'prod_log_triage',
    worktree_id: worktreeId,
    schedule_id: params.scheduleId ?? null,
  });

  return id;
}
