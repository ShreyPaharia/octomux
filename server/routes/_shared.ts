/**
 * Shared helpers used across multiple route modules.
 * This file MUST NOT import any router or api.ts.
 */
import type { Request, Response } from 'express';
import { getTask as getTaskRepo, listAllAgents, listUserTerminals } from '../repositories/index.js';
import { findReviewTaskByPrNumber, findReviewTaskBySource } from '../repositories/index.js';
import type { Task, DerivedTaskStatus } from '../types.js';
import type { OctomuxSettings } from '../settings.js';

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
