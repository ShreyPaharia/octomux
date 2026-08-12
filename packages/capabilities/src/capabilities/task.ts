/**
 * packages/capabilities/src/capabilities/task.ts
 *
 * METADATA for the `task` noun's capabilities: list, get, create, start, move,
 * close, delete. Pure zod + plain types — no server internals, no handlers.
 * `server/registry/capabilities/task.ts` pairs each entry here with its
 * (server-only) handler via `defineCapability`, so the CLI can build its
 * command tree from `TASK_CAPABILITY_META` without importing the server.
 *
 * Design doc: spec/surface-consolidation-and-centaur.md §5.1–5.3
 *
 * See `server/registry/capabilities/task.ts`'s module doc for the full set of
 * cross-cutting discrepancies from the assigning ticket's table (no http/cli
 * projection for task.close, `:id` vs `task_id` path-param naming, the 200-only
 * HTTP projection limitation, MCP tool name collisions, task.move's schema
 * choice, and the lean-summary-by-default design for task.list/task.get) — all
 * of that reasoning stays with the handlers since it's about behaviour, not shape.
 */

import { z } from 'zod';
import { WORKFLOW_STATUSES } from '@octomux/types';
import type { WorkflowStatus } from '@octomux/types';
import type { CapabilityMeta } from '../types.js';
import { createTaskInputSchema, closeTaskInputSchema } from '../schemas.js';

const workflowStatusEnum = z.enum(
  WORKFLOW_STATUSES as unknown as [WorkflowStatus, ...WorkflowStatus[]],
);

// ─── task.list ────────────────────────────────────────────────────────────────

/**
 * Relations `task.list` can expand into — pull_requests deliberately excluded (N+1 risk).
 * Exported so the handler (server/registry/capabilities/task.ts) can reuse the same
 * allow-list for `parseInclude` rather than duplicating it.
 */
export const LIST_INCLUDE_VALUES = ['workers', 'pending_prompts', 'user_terminals'] as const;

export const taskListInputSchema = z.object({
  repo_path: z.string().optional().describe('Filter by repo path'),
  // Query-string values are always strings over HTTP; the route itself compares
  // with `=== 'true'`, so the schema mirrors that instead of declaring
  // z.boolean() (which a querystring can never satisfy — see mergeInput).
  trash: z.string().optional().describe("'true' to list trashed tasks"),
  includeAutomated: z.string().optional().describe("'true' to include automated review tasks"),
  include: z
    .string()
    .optional()
    .describe(
      `Comma-separated relations to expand each task to its full row: ${LIST_INCLUDE_VALUES.join(', ')}. ` +
        'Omit for the lean summary {id, title, runtime_state, workflow_status, created_at, updated_at} ' +
        '— the default for every caller (dashboard, CLI, and agents alike). pull_requests is not ' +
        "offered here (would be an N+1 query across every listed task); use task.get's include for " +
        "a single task's pull_requests.",
    ),
});

// ─── task.get ─────────────────────────────────────────────────────────────────

/** Relations/extras `task.get` can expand into. Exported for the same reason as LIST_INCLUDE_VALUES. */
export const GET_INCLUDE_VALUES = [
  'workers',
  'pending_prompts',
  'user_terminals',
  'pull_requests',
  'worktree',
  'existing_review_id',
] as const;

export const taskGetInputSchema = z.object({
  id: z.string().describe('The octomux task id'),
  include: z
    .string()
    .optional()
    .describe(
      `Comma-separated relations to expand to the full task row: ${GET_INCLUDE_VALUES.join(', ')}. ` +
        'Omit for the lean summary {id, title, runtime_state, workflow_status, created_at, updated_at, ' +
        'agent_count, phase, current_summary, current_summary_updated_at} — the default for every ' +
        'caller (dashboard, CLI, and agents alike).',
    ),
});

// ─── task.create ────────────────────────────────────────────────────────────
//
// Extends createTaskInputSchema (schemas.ts) with the fields POST /api/tasks
// accepts that the canonical schema lacks: draft, agent, harness_id,
// workflow_status — added, not dropped. `title` is widened to optional: the
// live route allows omitting it when initial_prompt is given
// (validateCreateTaskBody enforces the real rule); the canonical schema
// requires it unconditionally, which would 400 every initial_prompt-only
// creation before the handler even ran.

export const taskCreateInputSchema = createTaskInputSchema.extend({
  title: z.string().optional().describe('Short task title (< 60 chars)'),
  draft: z.boolean().optional().describe('Create as a draft (idle) task'),
  agent: z.string().optional().nullable().describe('Agent persona name'),
  harness_id: z.string().optional().describe('Harness id (default: claude-code)'),
  workflow_status: workflowStatusEnum.optional().describe('Initial workflow_status override'),
});

// ─── task.start ───────────────────────────────────────────────────────────────

export const taskStartInputSchema = z.object({
  id: z.string().describe('The octomux task id'),
});

// ─── task.move ────────────────────────────────────────────────────────────────

export const taskMoveInputSchema = z.object({
  id: z.string().describe('The octomux task id'),
  workflow_status: workflowStatusEnum.describe('Target workflow_status'),
  note: z.string().optional().describe('Note (required when moving to human_review or planned)'),
});

// ─── task.delete ──────────────────────────────────────────────────────────────

export const taskDeleteInputSchema = z.object({
  id: z.string().describe('The octomux task id'),
  purge: z.string().optional().describe("'true' to hard-delete a previously soft-deleted task"),
});

// ─── Metadata ─────────────────────────────────────────────────────────────────

export const TASK_CAPABILITY_META: CapabilityMeta[] = [
  {
    id: 'task.list',
    summary:
      'List tasks (lean summary by default — pass include=workers,pending_prompts,user_terminals ' +
      'for the full task rows).',
    http: { method: 'get', path: '/api/tasks' },
    cli: 'task list',
    cliAliases: ['list-tasks'],
    mcp: 'list_tasks',
    tier: 'auto',
    callers: ['ui', 'human', 'agent'],
    input: taskListInputSchema,
  },
  {
    id: 'task.get',
    summary:
      'Get a single task (lean summary by default — pass include=workers,pending_prompts,' +
      'user_terminals,pull_requests,worktree,existing_review_id for the full task row).',
    http: { method: 'get', path: '/api/tasks/:id' },
    cli: 'task get',
    cliAliases: ['get-task'],
    mcp: 'get_task',
    tier: 'auto',
    callers: ['ui', 'human', 'agent'],
    input: taskGetInputSchema,
  },
  {
    id: 'task.create',
    summary: 'Create a task (and start it immediately unless draft:true).',
    // 201 matches routes/tasks.ts:253 — see HttpProjection.status.
    http: { method: 'post', path: '/api/tasks', status: 201 },
    cli: 'task create',
    cliAliases: ['create-task'],
    mcp: 'create_task',
    tier: 'ask',
    callers: ['ui', 'human', 'agent'],
    input: taskCreateInputSchema,
  },
  {
    id: 'task.start',
    summary: 'Start a draft task (fires setup + agent launch in the background).',
    http: { method: 'post', path: '/api/tasks/:id/start' },
    cli: 'task start',
    tier: 'ask',
    callers: ['ui', 'human', 'agent'],
    input: taskStartInputSchema,
  },
  {
    id: 'task.move',
    summary: 'Move a task to a new workflow_status (may auto-start/resume/close it).',
    http: { method: 'post', path: '/api/tasks/:id/move' },
    cli: 'task move',
    cliAliases: ['task-move'],
    mcp: 'set_task_status',
    tier: 'ask',
    callers: ['ui', 'human', 'agent'],
    input: taskMoveInputSchema,
  },
  {
    id: 'task.close',
    summary:
      'Close a task: stop its agents + kill its tmux session. Preserves the worktree/branch ' +
      'so it can be resumed.',
    // No http/cli projection — server/registry/capabilities/task.ts module doc point 1.
    mcp: 'close_task',
    tier: 'always-ask',
    callers: ['human', 'agent'],
    input: closeTaskInputSchema,
  },
  {
    id: 'task.delete',
    summary:
      'Delete a task: soft-delete by default; purge:true hard-deletes a previously ' +
      'soft-deleted task (kills tmux + removes worktree + deletes branch + DB rows).',
    // 204 + empty body matches routes/tasks.ts:348.
    http: { method: 'delete', path: '/api/tasks/:id', status: 204 },
    cli: 'task delete',
    cliAliases: ['delete-task'],
    mcp: 'delete_task',
    tier: 'always-ask',
    callers: ['ui', 'human', 'agent'],
    input: taskDeleteInputSchema,
  },
];
