import { nanoid } from 'nanoid';
import { insertTask, insertWorktree } from './repositories/index.js';

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
    `Triage production logs for ${input.repoShort} and open fix PRs for what you find.`,
    '',
    `Triage task id: ${input.triageTaskId}`,
    `Log command: ${input.logCommand}`,
    '',
    'Use the prod-log-triage skill to run this task:',
    '  1. Fetch recent prod logs by running the log command above.',
    '  2. Group errors into distinct classes.',
    '  3. Write an incident summary to desk/incidents/<date>.md.',
    '  4. Open one fix PR per error class using your own `gh` — there is no octomux sink for this workflow.',
    '',
    'Read the prod-log-triage skill (SKILL.md) for the full verify contract before starting.',
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
