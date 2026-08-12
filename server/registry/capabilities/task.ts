/**
 * server/registry/capabilities/task.ts
 *
 * Defines the `task` noun's capabilities: list, get, create, start, move,
 * close, delete. Registered by `registerTaskCapabilities()`, which
 * `server/registry/mount.ts` dynamically imports — this module does NOT
 * self-register at module load (see the `TODO(registry)` in mount.ts).
 *
 * Design doc: spec/surface-consolidation-and-centaur.md §5.1–5.3
 *
 * ─── Cross-cutting discrepancies from the assigning ticket's table ──────────
 *
 * 1. `task.close` has NO `http` projection. There is no `POST /api/tasks/:id/close`
 *    route — close happens via `PATCH /api/tasks/:id { runtime_state: 'idle' }`
 *    or inside `/move`'s done-transition (both in server/routes/*.ts). Inventing
 *    a route was explicitly out of scope for this ticket, so it stays undeclared
 *    at the HTTP layer. Consequently `task.close` ALSO has no `cli` projection:
 *    `server/registry/projections/cli.ts`'s `registerOne` throws
 *    (`"... has a cli projection but no http projection for the CLI to call"`)
 *    for any capability with `cli` set and `http` unset, because the generated
 *    CLI subcommand always proxies to the capability's own HTTP route rather
 *    than calling `cap.handler` in-process. The ticket's table asked for
 *    `cli: task close`, which is not satisfiable without either inventing a
 *    route (disallowed) or changing cli.ts (out of scope — existing file). The
 *    legacy `close-task` CLI command is unaffected: it is a fully separate,
 *    hand-written commander command (`cli/src/commands/close-task.ts`) that
 *    this registry does not touch and continues to work exactly as today.
 *
 * 2. Path-param field naming: every capability with an `:id`-shaped HTTP route
 *    names that field `id` (not `task_id`), because `mergeInput`
 *    (server/registry/projections/http.ts) merges the real Express
 *    `req.params` object verbatim, and the real routes this mirrors
 *    (server/routes/tasks.ts, server/routes/task-workflow.ts) all use `:id`.
 *    `mount.test.ts`'s own fixtures confirm this convention
 *    (`http: { path: '/api/things/:id' }, input: z.object({ id: z.string() })`).
 *    This is why `task.get` / `task.delete` do NOT reuse the canonical
 *    `task_id`-shaped schemas from `orchestrator/command-schemas.ts` even
 *    though those exist — using them would make every real HTTP request to
 *    those routes fail zod validation (`req.params.id` !== `task_id`).
 *    `task.close` has no such constraint (no http projection) and DOES reuse
 *    `closeTaskInputSchema` verbatim.
 *
 * 3. The generic HTTP projection (`handlerFor` in projections/http.ts) always
 *    responds `res.json(result)` — it cannot express a different status code
 *    or an empty body. The real routes it mirrors use `201` (task.create) and
 *    `204` (task.delete). This is a framework-level limitation of
 *    projections/http.ts (an existing file, not modifiable here), not
 *    something a capability definition can opt out of. Each handler below
 *    returns the closest useful JSON body instead.
 *
 * 4. `task.list` / `task.get` / `task.move` mcp names (`list_tasks`, `get_task`,
 *    `set_task_status`) collide by NAME with tools already hand-registered in
 *    `server/orchestrator/mcp/server.ts` (a lean `list_tasks`/`get_task` pair
 *    always registered, and a `set_task_status` write tool gated behind
 *    `orchestratorWriteEnabled()`, sourced from the OLD
 *    `orchestrator/command-registry.ts`). Those existing tools have DIFFERENT
 *    shapes (lean summaries, `task_id`-keyed args, narrower semantics) than the
 *    capabilities below. `registerCapabilityMcpTools` is not wired into
 *    `mcp/server.ts` yet (verified: no references), so there is no live
 *    collision today — but wiring it in later requires either renaming one
 *    side or removing the hand-written tool, or the MCP SDK will throw on
 *    duplicate tool-name registration. Flagged for the integration step, not
 *    fixed here (mcp/server.ts is an existing file this ticket must not touch).
 *
 * 5. `task.move`'s `mcp: 'set_task_status'` intentionally does NOT reuse
 *    `setStatusInputSchema` / `runSetStatus` from command-schemas.ts / exec.ts.
 *    That old pair's `{ task_id, status }` shape and handler are a narrow
 *    direct `setWorkflowStatus` write; the real `/move` route (which this
 *    capability mirrors, per the "behaviour preservation outranks reuse"
 *    steer in the ticket) also enforces a `note` requirement for
 *    human_review/planned, closes the task first when moving to `done`,
 *    writes a `task_updates` transition row, fires the `workflow_status_changed`
 *    webhook, and auto-starts/resumes the task when moving to `in_progress`.
 *    Reusing the old schema/handler would silently drop all of that on
 *    migration, so this capability defines its own schema/handler mirroring
 *    the route instead.
 */

import { z } from 'zod';
import { defineCapability } from '../index.js';
import {
  startTask,
  closeTask,
  softDeleteTask,
  deleteTask,
  resumeTask,
} from '../../task-engine/index.js';
import { broadcast } from '../../events.js';
import { ensureHookToken } from '../../hook-token.js';
import { fireHook } from '../../hook-dispatcher.js';
import {
  getTask as getTaskRepo,
  listTasks,
  setRuntimeState,
  setWorkflowStatus,
  addTaskUpdate,
  listAgentsByTasks,
  listPendingPromptsByTasks,
  listUserTerminalsByTasks,
  getWorktree,
  hardDeleteTask,
} from '../../repositories/index.js';
import type { PermissionPromptRow } from '../../repositories/permission-prompts.js';
import { createTask } from '../../services/task-service.js';
import { badRequest, conflict, notFound } from '../../services/errors.js';
import {
  fetchTaskWithRelations,
  fetchTaskBundle,
  formatTaskResponse,
  lookupExistingReviewId,
  validateCreateTaskBody,
  resolveTaskTitleAndDescription,
  throwIfValidationError,
} from '../../routes/_shared.js';
import { runCloseTask } from '../../orchestrator/exec.js';
import { closeTaskInputSchema, createTaskInputSchema } from '../../orchestrator/command-schemas.js';
import { WORKFLOW_STATUSES } from '../../types.js';
import type {
  Worker,
  UserTerminal,
  RunMode,
  WorkflowStatus,
  CreateTaskRequest,
} from '../../types.js';

const workflowStatusEnum = z.enum(
  WORKFLOW_STATUSES as unknown as [WorkflowStatus, ...WorkflowStatus[]],
);

// ─── task.list ────────────────────────────────────────────────────────────────
//
// No dedicated service function exists for "tasks + their related rows" — the
// logic is inline in GET /api/tasks (server/routes/tasks.ts). Mirrored here by
// calling the same repository functions the route calls (per the ticket's
// point 4), not reimplemented from scratch.

const taskListInputSchema = z.object({
  repo_path: z.string().optional().describe('Filter by repo path'),
  // Query-string values are always strings over HTTP; the route itself compares
  // with `=== 'true'`, so the schema mirrors that instead of declaring
  // z.boolean() (which a querystring can never satisfy — see mergeInput).
  trash: z.string().optional().describe("'true' to list trashed tasks"),
  includeAutomated: z.string().optional().describe("'true' to include automated review tasks"),
});

function listTasksHandler(input: z.infer<typeof taskListInputSchema>) {
  const tasks = listTasks({
    trash: input.trash === 'true',
    repoPath: input.repo_path,
    includeAutoReview: false,
    includeAutomated: input.includeAutomated === 'true',
  });

  if (tasks.length === 0) return [];

  const taskIds = tasks.map((t) => t.id);
  const allAgents = listAgentsByTasks(taskIds);
  const allPrompts = listPendingPromptsByTasks(taskIds);
  const allTerminals = listUserTerminalsByTasks(taskIds);

  const workersByTask = new Map<string, Worker[]>();
  for (const agent of allAgents) {
    if (!agent.task_id) continue;
    const list = workersByTask.get(agent.task_id) || [];
    list.push(agent);
    workersByTask.set(agent.task_id, list);
  }

  const promptsByTask = new Map<string, PermissionPromptRow[]>();
  for (const pp of allPrompts) {
    const taskId = pp.task_id as string;
    const list = promptsByTask.get(taskId) || [];
    list.push(pp);
    promptsByTask.set(taskId, list);
  }

  const terminalsByTask = new Map<string, UserTerminal[]>();
  for (const ut of allTerminals) {
    const list = terminalsByTask.get(ut.task_id) || [];
    list.push(ut);
    terminalsByTask.set(ut.task_id, list);
  }

  return tasks.map((task) =>
    formatTaskResponse(task, {
      workers: workersByTask.get(task.id) || [],
      pending_prompts: promptsByTask.get(task.id) || [],
      user_terminals: terminalsByTask.get(task.id) || [],
      // ponytail (mirrored from the route): list omits pull_requests to avoid
      // an N+1 — see the matching comment in server/routes/tasks.ts.
      pull_requests: [],
    }),
  );
}

// ─── task.get ─────────────────────────────────────────────────────────────────

const taskGetInputSchema = z.object({
  id: z.string().describe('The octomux task id'),
});

async function getTaskHandler(input: z.infer<typeof taskGetInputSchema>) {
  const task = getTaskRepo(input.id);
  if (!task) throw notFound('Task not found');

  const { relations } = fetchTaskWithRelations(task.id);
  // Backfill hook_token for pre-step-1 agents that have an empty token.
  const needsBackfill = relations.workers.some((w) => !w.hook_token);
  let workers: Worker[];
  if (needsBackfill) {
    workers = await Promise.all(
      relations.workers.map(async (agent) => {
        if (agent.hook_token) return agent;
        const token = await ensureHookToken(agent, task.worktree ?? null);
        return { ...agent, hook_token: token };
      }),
    );
  } else {
    workers = relations.workers;
  }

  const worktreeRow = task.worktree_id ? (getWorktree(task.worktree_id) ?? null) : null;
  return formatTaskResponse(
    task,
    { ...relations, workers },
    { worktree_row: worktreeRow, existing_review_id: lookupExistingReviewId(task) },
  );
}

// ─── task.create ────────────────────────────────────────────────────────────
//
// Extends createTaskInputSchema (command-schemas.ts) with the fields
// POST /api/tasks accepts that the canonical schema lacks: draft, agent,
// harness_id, workflow_status (ticket point 3) — added, not dropped. `title`
// is widened to optional: the live route allows omitting it when
// initial_prompt is given (validateCreateTaskBody enforces the real rule);
// the canonical schema requires it unconditionally, which would 400 every
// initial_prompt-only creation before the handler even ran.
//
// NOTE: this reuses createTaskInputSchema's `notify_task` field name (not the
// wire route's `notify_task_id`) — reuse-over-duplication for a rarely-used
// field; the real POST /api/tasks route currently reads `notify_task_id` from
// the body, so an HTTP caller using this capability's generated route must
// send `notify_task`, not `notify_task_id`. Flagged as a discrepancy.

const taskCreateInputSchema = createTaskInputSchema.extend({
  title: z.string().optional().describe('Short task title (< 60 chars)'),
  draft: z.boolean().optional().describe('Create as a draft (idle) task'),
  agent: z.string().optional().nullable().describe('Agent persona name'),
  harness_id: z.string().optional().describe('Harness id (default: claude-code)'),
  workflow_status: workflowStatusEnum.optional().describe('Initial workflow_status override'),
});

/**
 * Mirrors POST /api/tasks (server/routes/tasks.ts) exactly, including its
 * response envelope — NOT runCreateTask's narrow `{ task_id, title }`.
 * Behaviour preservation outranks reuse here (ticket point 2).
 *
 * Correction to the ticket's prior-research note: the live route responds
 * `res.status(201).json(created)` with `created` being exactly what
 * `createTask()` (task-service.ts) returns — that function only sets
 * `.workers = []` and `.user_terminals = []` on the row, NOT `pull_requests`
 * / `pending_prompts` / `derived_status` (those come from
 * `formatTaskResponse`, which POST /api/tasks never calls). So the real
 * envelope is task + workers + user_terminals, not the fuller GET envelope.
 */
async function createTaskHandler(input: z.infer<typeof taskCreateInputSchema>) {
  const runMode: RunMode = (input.run_mode as RunMode | undefined) ?? 'new';

  throwIfValidationError(validateCreateTaskBody(input as unknown as CreateTaskRequest, runMode));

  let storedRepoPath: string;
  let storedWorktree: string | null;
  if (runMode === 'scratch') {
    storedRepoPath = '';
    storedWorktree = null;
  } else if (runMode === 'existing') {
    storedRepoPath = input.repo_path ?? '';
    storedWorktree = input.worktree_path!;
  } else {
    storedRepoPath = input.repo_path!;
    storedWorktree = null;
  }

  const { resolvedTitle, resolvedDescription } = await resolveTaskTitleAndDescription(input);

  const isDraft = !!input.draft;

  const stagedPath =
    runMode === 'existing' ? storedWorktree! : runMode === 'none' ? storedRepoPath : '';

  let initialWorkflowStatus: string;
  if (input.workflow_status) {
    initialWorkflowStatus = input.workflow_status;
  } else if (isDraft && !input.initial_prompt) {
    initialWorkflowStatus = 'backlog';
  } else if (isDraft && input.initial_prompt) {
    initialWorkflowStatus = 'planned';
  } else {
    initialWorkflowStatus = 'planned';
  }

  return createTask({
    resolved_title: resolvedTitle,
    resolved_description: resolvedDescription,
    initial_prompt: input.initial_prompt ?? null,
    run_mode: runMode,
    stored_repo_path: storedRepoPath,
    staged_path: stagedPath,
    branch: input.branch ?? null,
    base_branch: input.base_branch ?? null,
    worktree_status: 'available',
    runtime_state: isDraft ? 'idle' : 'setting_up',
    workflow_status: initialWorkflowStatus,
    agent: input.agent ?? null,
    harness_id: input.harness_id ?? 'claude-code',
    model: input.model ?? null,
    notify_task_id: input.notify_task ?? null,
    is_draft: isDraft,
  });
}

// ─── task.start ───────────────────────────────────────────────────────────────

const taskStartInputSchema = z.object({
  id: z.string().describe('The octomux task id'),
});

// async so a synchronous throw (not-found / not-idle) always surfaces as a
// rejected promise, consistent with every other handler here and with how
// http.ts's `await cap.handler(...)` treats it either way.
async function startTaskHandler(input: z.infer<typeof taskStartInputSchema>) {
  const task = getTaskRepo(input.id);
  if (!task) throw notFound('Task not found');

  if (task.runtime_state !== 'idle') {
    throw badRequest('Only draft tasks can be started');
  }

  setRuntimeState(task.id, 'setting_up');

  const updated = fetchTaskBundle(task.id);
  broadcast({ type: 'task:updated', payload: { taskId: task.id } });

  // Fire-and-forget — mirrors POST /api/tasks/:id/start exactly: the response
  // returns immediately with runtime_state:'setting_up', and startTask's setup
  // work continues in the background, broadcasting task:updated again on
  // completion/failure. Awaiting it here would change response latency from
  // "immediate ack" to "blocks until agent setup finishes".
  startTask(task)
    .then(() => broadcast({ type: 'task:updated', payload: { taskId: task.id } }))
    .catch(() => broadcast({ type: 'task:updated', payload: { taskId: task.id } }));

  return updated;
}

// ─── task.move ────────────────────────────────────────────────────────────────

const taskMoveInputSchema = z.object({
  id: z.string().describe('The octomux task id'),
  workflow_status: workflowStatusEnum.describe('Target workflow_status'),
  note: z.string().optional().describe('Note (required when moving to human_review or planned)'),
});

/** See module doc point 5 for why this does not reuse setStatusInputSchema/runSetStatus. */
async function moveTaskHandler(input: z.infer<typeof taskMoveInputSchema>) {
  const task = getTaskRepo(input.id);
  if (!task) throw notFound('Task not found');

  if (
    (input.workflow_status === 'human_review' || input.workflow_status === 'planned') &&
    !input.note?.trim()
  ) {
    throw badRequest(`note is required when moving to ${input.workflow_status}`);
  }

  // Close eagerly on every move to done — idle agents still hold a live claude
  // process (+MCP sidecars); reopening resumes via harness_session_id.
  if (input.workflow_status === 'done' && task.workflow_status !== 'done') {
    await closeTask(task);
  }

  const prevStatus = task.workflow_status;
  setWorkflowStatus(task.id, input.workflow_status);

  addTaskUpdate({
    task_id: task.id,
    kind: 'transition',
    from_status: prevStatus,
    to_status: input.workflow_status,
    body: input.note ?? null,
  });

  let autoStart: 'start' | 'resume' | null = null;
  if (
    input.workflow_status === 'in_progress' &&
    (task.runtime_state === 'idle' || task.runtime_state === 'error')
  ) {
    autoStart = task.worktree ? 'resume' : 'start';
  }
  if (autoStart) {
    setRuntimeState(task.id, 'setting_up', null);
  }

  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  fireHook('workflow_status_changed', {
    event: 'workflow_status_changed',
    task: { ...task, workflow_status: input.workflow_status },
    data: { from: prevStatus, to: input.workflow_status, note: input.note },
  });

  const updated = fetchTaskBundle(task.id);

  if (autoStart === 'start') {
    startTask(task)
      .then(() => broadcast({ type: 'task:updated', payload: { taskId: task.id } }))
      .catch(() => broadcast({ type: 'task:updated', payload: { taskId: task.id } }));
  } else if (autoStart === 'resume') {
    resumeTask(task)
      .then(() => broadcast({ type: 'task:updated', payload: { taskId: task.id } }))
      .catch(() => broadcast({ type: 'task:updated', payload: { taskId: task.id } }));
  }

  return updated;
}

// ─── task.close ───────────────────────────────────────────────────────────────
//
// No http/cli projection — see module doc point 1. Reuses closeTaskInputSchema
// verbatim (no path-param naming conflict since there's no http projection)
// and delegates straight to runCloseTask, exactly like the OLD
// orchestrator/command-registry.ts's close_task entry did.

async function closeTaskHandler(input: z.infer<typeof closeTaskInputSchema>) {
  await runCloseTask(input.task_id);
  return { task_id: input.task_id };
}

// ─── task.delete ──────────────────────────────────────────────────────────────

const taskDeleteInputSchema = z.object({
  id: z.string().describe('The octomux task id'),
  purge: z.string().optional().describe("'true' to hard-delete a previously soft-deleted task"),
});

/**
 * Mirrors DELETE /api/tasks/:id's conditional soft/hard delete exactly — NOT
 * runDeleteTask's unconditional hard delete (ticket point 5). Reuses the SAME
 * functions the route imports (softDeleteTask/deleteTask from task-engine,
 * hardDeleteTask from repositories) rather than deleteTaskInputSchema's
 * `{ task_id }` shape — see module doc point 2 for why the `id` field name is
 * required here.
 */
async function deleteTaskHandler(input: z.infer<typeof taskDeleteInputSchema>) {
  const task = getTaskRepo(input.id);
  if (!task) throw notFound('Task not found');

  if (input.purge === 'true') {
    if (task.deleted_at == null) {
      throw conflict('task must be soft-deleted before purge');
    }
    const taskId = task.id;
    await deleteTask(task);
    // ON DELETE CASCADE removes agents, permission_prompts, user_terminals.
    hardDeleteTask(taskId);
    broadcast({ type: 'task:deleted', payload: { taskId } });
    return { id: taskId, purged: true };
  }

  await softDeleteTask(task);
  broadcast({ type: 'task:updated', payload: { taskId: task.id } });
  return { id: task.id, purged: false };
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerTaskCapabilities(): void {
  defineCapability({
    id: 'task.list',
    summary: 'List tasks with their workers, pending prompts, and terminals.',
    http: { method: 'get', path: '/api/tasks' },
    cli: 'task list',
    cliAliases: ['list-tasks'],
    mcp: 'list_tasks',
    tier: 'auto',
    callers: ['ui', 'human', 'agent'],
    input: taskListInputSchema,
    handler: listTasksHandler,
  });

  defineCapability({
    id: 'task.get',
    summary: 'Get a single task with its workers, terminals, prompts, and pull requests.',
    http: { method: 'get', path: '/api/tasks/:id' },
    cli: 'task get',
    cliAliases: ['get-task'],
    mcp: 'get_task',
    tier: 'auto',
    callers: ['ui', 'human', 'agent'],
    input: taskGetInputSchema,
    handler: getTaskHandler,
  });

  defineCapability({
    id: 'task.create',
    summary: 'Create a task (and start it immediately unless draft:true).',
    http: { method: 'post', path: '/api/tasks' },
    cli: 'task create',
    cliAliases: ['create-task'],
    mcp: 'create_task',
    tier: 'ask',
    callers: ['ui', 'human', 'agent'],
    input: taskCreateInputSchema,
    handler: createTaskHandler,
  });

  defineCapability({
    id: 'task.start',
    summary: 'Start a draft task (fires setup + agent launch in the background).',
    http: { method: 'post', path: '/api/tasks/:id/start' },
    cli: 'task start',
    tier: 'ask',
    callers: ['ui', 'human', 'agent'],
    input: taskStartInputSchema,
    handler: startTaskHandler,
  });

  defineCapability({
    id: 'task.move',
    summary: 'Move a task to a new workflow_status (may auto-start/resume/close it).',
    http: { method: 'post', path: '/api/tasks/:id/move' },
    cli: 'task move',
    cliAliases: ['task-move'],
    mcp: 'set_task_status',
    tier: 'ask',
    callers: ['ui', 'human', 'agent'],
    input: taskMoveInputSchema,
    handler: moveTaskHandler,
  });

  defineCapability({
    id: 'task.close',
    summary:
      'Close a task: stop its agents + kill its tmux session. Preserves the worktree/branch ' +
      'so it can be resumed.',
    // No http/cli projection — see module doc point 1.
    mcp: 'close_task',
    tier: 'always-ask',
    callers: ['human', 'agent'],
    input: closeTaskInputSchema,
    handler: closeTaskHandler,
  });

  defineCapability({
    id: 'task.delete',
    summary:
      'Delete a task: soft-delete by default; purge:true hard-deletes a previously ' +
      'soft-deleted task (kills tmux + removes worktree + deletes branch + DB rows).',
    http: { method: 'delete', path: '/api/tasks/:id' },
    cli: 'task delete',
    cliAliases: ['delete-task'],
    mcp: 'delete_task',
    tier: 'always-ask',
    callers: ['ui', 'human', 'agent'],
    input: taskDeleteInputSchema,
    handler: deleteTaskHandler,
  });
}
