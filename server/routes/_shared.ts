/**
 * Shared helpers used across multiple route modules.
 * This file MUST NOT import any router or api.ts.
 */
import type { Request, Response } from 'express';
import { getTask as getTaskRepo, listAllAgents, listUserTerminals } from '../repositories/index.js';
import { findReviewTaskByPrNumber, findReviewTaskBySource } from '../repositories/index.js';
import { nanoid } from 'nanoid';
import fs from 'fs';
import type {
  Task,
  DerivedTaskStatus,
  CreateTaskRequest,
  UpdateTaskRequest,
  RunMode,
} from '../types.js';
import { RUN_MODES } from '../types.js';
import type { OctomuxSettings } from '../settings.js';
import { generateTitleAndDescription } from '../title-gen.js';
import { validateAgentName } from '../harnesses/types.js';
import { getHarness } from '../harnesses/index.js';
import {
  updateTaskFields,
  insertWorktree as insertWorktreeRepo,
  updateWorktreeFields,
} from '../repositories/index.js';

/** Load a task by :id param; respond 404 and return null if missing. */
export function loadTaskOrFail(req: Request, res: Response): Task | null {
  const task = getTaskRepo(req.params.id as string);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return null;
  }
  return task;
}

/** Map a thrown domain error to an HTTP response. */
export function sendDomainError(res: Response, err: unknown): void {
  const e = err as NodeJS.ErrnoException;
  const msg = e.message || 'Unknown error';
  if (e.code === 'ENOENT' || msg.includes('not found') || msg.includes('does not exist')) {
    res.status(404).json({ error: msg });
  } else if (msg.includes('already exists')) {
    res.status(409).json({ error: msg });
  } else if (msg.startsWith('Invalid') || msg.includes('required')) {
    res.status(400).json({ error: msg });
  } else {
    res.status(500).json({ error: msg });
  }
}

/**
 * Return the id of a live auto_review task pointing at this source — either
 * keyed on `pr_number` (poller-created) or on `review_of_task_id` (manual).
 * Used by both GET /api/tasks/:id and the manual-trigger endpoint.
 */
export function lookupExistingReviewId(task: {
  id: string;
  pr_number: number | null;
}): string | null {
  if (task.pr_number != null) {
    const byPr = findReviewTaskByPrNumber(task.pr_number);
    if (byPr) return byPr.id;
  }
  const byLink = findReviewTaskBySource(task.id);
  return byLink?.id ?? null;
}

/** Recursively merge `incoming` into `base` (objects merged, primitives overwritten). */
export function deepMerge(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(incoming)) {
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as Record<string, unknown>,
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}

/** Reload a task with its related agents and user_terminals. */
export function fetchTaskBundle(taskId: string): Task {
  const task = getTaskRepo(taskId) as Task;
  task.agents = listAllAgents(taskId);
  task.user_terminals = listUserTerminals(taskId);
  return task;
}

export function derivedStatus(task: {
  runtime_state: string;
  agents: Array<{ status: string; hook_activity: string }>;
}): DerivedTaskStatus | null {
  if (task.runtime_state !== 'running') return null;
  const activities = task.agents.filter((a) => a.status !== 'stopped').map((a) => a.hook_activity);
  if (activities.length === 0) return 'done';
  if (activities.includes('active')) return 'working';
  if (activities.includes('waiting')) return 'needs_attention';
  return 'done';
}

/** Flat Claude launch aliases for `/api/settings` responses (dashboard reads these keys). */
export function augmentDashboardSettings(settings: OctomuxSettings): OctomuxSettings & {
  dangerouslySkipPermissions: boolean;
  claudeFlags: string;
} {
  const cc = settings.harnesses?.['claude-code'] ?? {};
  const dsp = (cc as { dangerouslySkipPermissions?: unknown }).dangerouslySkipPermissions;
  const flagsRaw = (cc as { flags?: unknown }).flags;
  return {
    ...settings,
    dangerouslySkipPermissions: typeof dsp === 'boolean' ? dsp : Boolean(dsp),
    claudeFlags: typeof flagsRaw === 'string' ? flagsRaw : '',
  };
}

/**
 * Validate the body of POST /api/tasks (create task).
 * Returns `{ status, message }` if validation fails, or `null` if valid.
 * Also derives and returns `storedRepoPath` and `storedWorktree` on success.
 */
export function validateCreateTaskBody(
  body: CreateTaskRequest,
  runMode: RunMode,
): { status: number; message: string } | null {
  if ((!body.title || !body.description) && !body.initial_prompt) {
    return { status: 400, message: 'title and description are required' };
  }
  if (!RUN_MODES.includes(runMode)) {
    return { status: 400, message: `invalid run_mode: ${String(runMode)}` };
  }

  // Per-mode field requirements
  if (runMode === 'new' || runMode === 'none') {
    if (!body.repo_path) {
      return { status: 400, message: `repo_path is required for run_mode=${runMode}` };
    }
  }
  if (runMode === 'existing') {
    if (!body.worktree_path) {
      return { status: 400, message: 'worktree_path is required for run_mode=existing' };
    }
    if (body.base_branch) {
      return { status: 400, message: 'base_branch is not allowed for run_mode=existing' };
    }
  }
  if (runMode === 'none') {
    if (body.branch || body.worktree_path) {
      return { status: 400, message: 'branch and worktree_path are not allowed for run_mode=none' };
    }
    // base_branch is allowed for none mode (triggers branch switch at setup)
  }
  if (runMode === 'scratch') {
    if (body.repo_path || body.base_branch || body.branch || body.worktree_path) {
      return {
        status: 400,
        message:
          'repo_path, base_branch, branch, worktree_path are not allowed for run_mode=scratch',
      };
    }
  }

  if (body.agent != null) {
    try {
      validateAgentName(body.agent);
    } catch (err) {
      return { status: 400, message: (err as Error).message };
    }
  }

  if (body.harness_id != null) {
    try {
      getHarness(body.harness_id);
    } catch (err) {
      return { status: 400, message: (err as Error).message };
    }
  }

  return null;
}

/**
 * Apply draft field updates from PATCH /api/tasks/:id body.
 * Validates fields and writes to DB. Returns `{ status, message }` on error, `null` on success.
 */
export function applyDraftUpdates(
  task: Task,
  body: UpdateTaskRequest,
): { status: number; message: string } | null {
  const isDraft = task.runtime_state === 'idle';
  if (!isDraft) {
    return { status: 400, message: 'Can only edit fields on draft tasks' };
  }
  if (body.title !== undefined && !body.title.trim()) {
    return { status: 400, message: 'title is required' };
  }
  if (body.description !== undefined && !body.description.trim()) {
    return { status: 400, message: 'description is required' };
  }
  if (body.repo_path !== undefined) {
    if (!body.repo_path.trim()) {
      return { status: 400, message: 'repo_path is required' };
    }
    if (!fs.existsSync(body.repo_path)) {
      return { status: 400, message: 'repo_path does not exist' };
    }
  }
  if (body.run_mode !== undefined && !RUN_MODES.includes(body.run_mode)) {
    return { status: 400, message: `invalid run_mode: ${String(body.run_mode)}` };
  }

  // Route updates between tasks (title/description/initial_prompt) and
  // worktrees (repo_path/branch/base_branch/path/mode).
  const taskPatch: Partial<Record<string, unknown>> = {};
  for (const key of ['title', 'description', 'initial_prompt'] as const) {
    if (body[key] !== undefined) {
      taskPatch[key] = body[key] ?? null;
    }
  }
  if (Object.keys(taskPatch).length > 0) {
    updateTaskFields(task.id, taskPatch);
  }

  const worktreePatch: Partial<Record<string, unknown>> = {};
  if (body.repo_path !== undefined) worktreePatch['repo_path'] = body.repo_path ?? null;
  if (body.branch !== undefined) worktreePatch['branch'] = body.branch ?? null;
  if (body.base_branch !== undefined) worktreePatch['base_branch'] = body.base_branch ?? null;
  if (body.worktree_path !== undefined) worktreePatch['path'] = body.worktree_path ?? '';
  if (body.run_mode !== undefined) worktreePatch['mode'] = body.run_mode;

  if (Object.keys(worktreePatch).length > 0) {
    let wtId = task.worktree_id;
    if (!wtId) {
      // Materialise a placeholder worktree row for this draft; fields get
      // refined as the user edits or at setup time.
      wtId = nanoid(12);
      insertWorktreeRepo({
        id: wtId,
        path: '',
        mode: body.run_mode ?? task.run_mode ?? 'new',
        status: 'available',
      });
      updateTaskFields(task.id, { worktree_id: wtId });
    }
    updateWorktreeFields(wtId, worktreePatch);
  }

  return null;
}

/**
 * Resolve the task title and description from the request body.
 * Fast path: derives from initial_prompt locally.
 * Optional: if OCTOMUX_AI_TASK_NAMING=1, calls Claude CLI for polish.
 */
export async function resolveTaskTitleAndDescription(body: {
  title?: string;
  description?: string;
  initial_prompt?: string;
}): Promise<{ resolvedTitle: string; resolvedDescription: string }> {
  const hadExplicitTitle = Boolean(body.title?.trim());
  const hadExplicitDescription = Boolean(body.description?.trim());
  let resolvedTitle = body.title?.trim();
  let resolvedDescription = body.description?.trim();

  const initialPromptTrimmed = body.initial_prompt?.trim() ?? '';
  if (initialPromptTrimmed) {
    const firstLine = initialPromptTrimmed.split('\n')[0] ?? '';
    if (!resolvedTitle) resolvedTitle = firstLine.slice(0, 80) || 'Untitled task';
    if (!resolvedDescription) resolvedDescription = initialPromptTrimmed;
  }

  const aiNamingEnv = process.env.OCTOMUX_AI_TASK_NAMING ?? '';
  const aiTaskNamingEnabled = aiNamingEnv === '1' || aiNamingEnv.toLowerCase() === 'true';
  if (
    initialPromptTrimmed &&
    aiTaskNamingEnabled &&
    (!hadExplicitTitle || !hadExplicitDescription)
  ) {
    const generated = await generateTitleAndDescription(body.initial_prompt!);
    if (!hadExplicitTitle) resolvedTitle = generated.title;
    if (!hadExplicitDescription) resolvedDescription = generated.description;
  }

  resolvedTitle =
    resolvedTitle ||
    initialPromptTrimmed.split('\n')[0]?.slice(0, 80) ||
    body.initial_prompt?.split('\n')[0]?.slice(0, 80) ||
    'Untitled task';
  resolvedDescription = resolvedDescription || body.initial_prompt || '';

  return { resolvedTitle, resolvedDescription };
}
