/**
 * server/registry/capabilities/task.ts
 *
 * Defines the `task` noun's capabilities: list, get, create, start, move,
 * close, delete. Registered by `registerTaskCapabilities()`, which
 * `server/registry/mount.ts` dynamically imports — this module does NOT
 * self-register at module load (see the `TODO(registry)` in mount.ts).
 *
 * METADATA (id, summary, http, cli, cliAliases, mcp, tier, callers, input) for
 * all seven capabilities lives in `@octomux/capabilities`'s
 * `TASK_CAPABILITY_META` — pure zod + plain types, importable by the CLI
 * without dragging in the server. This module pairs each metadata entry with
 * its handler (below), which needs `db`, `task-engine`, and friends and so
 * must stay behind in `server/`. See `packages/capabilities/src/types.ts` for
 * why the split exists.
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
 *    `task_id`-shaped schemas from `@octomux/capabilities`'s schemas.ts even
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
 *    `set_task_status`) collide by NAME with tools that used to be hand-registered
 *    in `server/orchestrator/mcp/server.ts` (a lean `list_tasks`/`get_task` pair
 *    always registered, and a `set_task_status` write tool gated behind
 *    `orchestratorWriteEnabled()`, sourced from the OLD
 *    `orchestrator/command-registry.ts`). `server/orchestrator/mcp/server.ts` now
 *    calls `registerCapabilityMcpTools()` instead of hand-registering those six
 *    names — see point 6 below for how `task.list`/`task.get` were redesigned so
 *    the capability version doesn't regress the conductor's lean-summary contract.
 *
 * 5. `task.move`'s `mcp: 'set_task_status'` intentionally does NOT reuse
 *    `setStatusInputSchema` / `runSetStatus` from schemas.ts / exec.ts.
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
 *
 * 6. `task.list` / `task.get` default to the SAME lean summary shape the old
 *    hand-written MCP tools returned (`{id, title, runtime_state, workflow_status,
 *    created_at, updated_at}` for list; `+ agent_count, phase, current_summary,
 *    current_summary_updated_at` for get) — for EVERY caller (dashboard, CLI,
 *    MCP), not a special case for MCP. A caller that wants the full task row +
 *    relations (workers/pending_prompts/user_terminals/pull_requests/worktree/
 *    existing_review_id) opts in via `include` (comma-separated relation names)
 *    on the SAME capability — there is deliberately no second "lean" capability
 *    or handler. The dashboard's `GET /api/tasks` and `GET /api/tasks/:id` calls
 *    (`src/lib/api/taskApi.ts`'s `listTasks`/`getTask`) do NOT currently send
 *    `include` and therefore now get the lean shape too — see the integration
 *    report for the exact query-string fix required there (out of scope here:
 *    `src/` is another agent's tree). `task.get`'s hook_token backfill
 *    (`ensureHookToken`) only runs when `include` is non-empty — it's a real DB
 *    write, not just display formatting, so the lean/frequent-polling path skips
 *    it rather than paying for it on every call. `pull_requests` is intentionally
 *    NOT an offered include value for `task.list` (would be an N+1 query across
 *    every listed task, same reasoning as the ponytail note in `listTasksHandler`
 *    below); use `task.get` with `include=pull_requests` for a single task's PRs.
 */

import { z } from 'zod';
import {
  TASK_CAPABILITY_META,
  LIST_INCLUDE_VALUES,
  GET_INCLUDE_VALUES,
  taskListInputSchema,
  taskGetInputSchema,
  taskCreateInputSchema,
  taskStartInputSchema,
  taskMoveInputSchema,
  taskDeleteInputSchema,
  closeTaskInputSchema,
} from '@octomux/capabilities';
import type { CapabilityMeta } from '@octomux/capabilities';
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
  setDependsOn,
  validateDependsOn,
  isDependencyUnmet,
  addTaskUpdate,
  listAgentsByTasks,
  listPendingPromptsByTasks,
  listUserTerminalsByTasks,
  getWorktree,
  hardDeleteTask,
  countAgentsForTask,
} from '../../repositories/index.js';
import { getManagedTask } from '../../repositories/orchestrator.js';
import { getArtifactSummary } from '../../artifact.js';
import type { PermissionPromptRow } from '../../repositories/permission-prompts.js';
import { createTask, unblockDependents } from '../../services/task-service.js';
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
import type { Task, Worker, UserTerminal, RunMode, CreateTaskRequest } from '../../types.js';

// ─── include= parsing (shared by task.list / task.get) ────────────────────────
//
// One capability, one handler, parameterised — not a second lean tool/route
// (see module doc point 6). `include` is a comma-separated string (not an
// array) so the SAME zod field works unchanged over HTTP querystrings, CLI
// flags, and MCP tool args.

/** Parse a comma-separated `include` value against an allow-list. Throws 400 on any unknown entry. */
function parseInclude(raw: string | undefined, allowed: readonly string[]): Set<string> {
  if (!raw) return new Set();
  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = requested.filter((r) => !allowed.includes(r));
  if (unknown.length > 0) {
    throw badRequest(
      `unknown include value(s): ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`,
    );
  }
  return new Set(requested);
}

// ─── task.list ────────────────────────────────────────────────────────────────
//
// No dedicated service function exists for "tasks + their related rows" — the
// logic is inline in GET /api/tasks (server/routes/tasks.ts). Mirrored here by
// calling the same repository functions the route calls (per the ticket's
// point 4), not reimplemented from scratch.

/** The lean default: id/title/status/timestamps only — no relations, no full task row. */
function leanTaskSummary(t: Task) {
  return {
    id: t.id,
    title: t.title,
    runtime_state: t.runtime_state,
    workflow_status: t.workflow_status,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

function listTasksHandler(input: z.infer<typeof taskListInputSchema>) {
  const tasks = listTasks({
    trash: input.trash === 'true',
    repoPath: input.repo_path,
    includeAutoReview: false,
    includeAutomated: input.includeAutomated === 'true',
  });

  if (tasks.length === 0) return [];

  const included = parseInclude(input.include, LIST_INCLUDE_VALUES);
  if (included.size === 0) {
    return tasks.map(leanTaskSummary);
  }

  const taskIds = tasks.map((t) => t.id);

  const workersByTask = new Map<string, Worker[]>();
  if (included.has('workers')) {
    for (const agent of listAgentsByTasks(taskIds)) {
      if (!agent.task_id) continue;
      const list = workersByTask.get(agent.task_id) || [];
      list.push(agent);
      workersByTask.set(agent.task_id, list);
    }
  }

  const promptsByTask = new Map<string, PermissionPromptRow[]>();
  if (included.has('pending_prompts')) {
    for (const pp of listPendingPromptsByTasks(taskIds)) {
      const taskId = pp.task_id as string;
      const list = promptsByTask.get(taskId) || [];
      list.push(pp);
      promptsByTask.set(taskId, list);
    }
  }

  const terminalsByTask = new Map<string, UserTerminal[]>();
  if (included.has('user_terminals')) {
    for (const ut of listUserTerminalsByTasks(taskIds)) {
      const list = terminalsByTask.get(ut.task_id) || [];
      list.push(ut);
      terminalsByTask.set(ut.task_id, list);
    }
  }

  return tasks.map((task) => {
    const workers = workersByTask.get(task.id) || [];
    const full = formatTaskResponse(task, {
      workers,
      pending_prompts: promptsByTask.get(task.id) || [],
      user_terminals: terminalsByTask.get(task.id) || [],
      // ponytail: list never fetches pull_requests, to avoid an N+1 — see
      // LIST_INCLUDE_VALUES above and the matching comment in server/routes/tasks.ts.
      pull_requests: [],
    }) as Record<string, unknown>;
    // current_summary(+_updated_at) no longer lives on the `tasks` row (spec
    // §5.5) — read from the task's .octomux/artifact.md Summary section.
    // Unconditional (not gated by `included`): BoardCard renders it on every
    // board card, same as before the migration.
    Object.assign(full, getArtifactSummary(task.worktree ?? null));
    if (!included.has('workers')) {
      // derived_status is only meaningful alongside the workers it's computed from.
      delete full.workers;
      delete full.derived_status;
    }
    if (!included.has('pending_prompts')) delete full.pending_prompts;
    if (!included.has('user_terminals')) delete full.user_terminals;
    delete full.pull_requests;
    return full;
  });
}

// ─── task.get ─────────────────────────────────────────────────────────────────

async function getTaskHandler(input: z.infer<typeof taskGetInputSchema>) {
  const task = getTaskRepo(input.id);
  if (!task) throw notFound('Task not found');

  const included = parseInclude(input.include, GET_INCLUDE_VALUES);

  if (included.size === 0) {
    return {
      id: task.id,
      title: task.title,
      runtime_state: task.runtime_state,
      workflow_status: task.workflow_status,
      created_at: task.created_at,
      updated_at: task.updated_at,
      agent_count: countAgentsForTask(task.id),
      phase: getManagedTask(task.id)?.phase ?? null,
      // current_summary(+_updated_at) sourced from .octomux/artifact.md, not
      // the (retired) tasks columns — see server/artifact.ts.
      ...getArtifactSummary(task.worktree ?? null),
    };
  }

  const { relations } = fetchTaskWithRelations(task.id);
  // Backfill hook_token for pre-step-1 agents that have an empty token. This is
  // a real DB write, not display formatting — only paid for on the rich (include
  // non-empty) path, so lean/frequent-polling callers never trigger it.
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

  const worktreeRow =
    included.has('worktree') && task.worktree_id ? (getWorktree(task.worktree_id) ?? null) : null;
  const existingReviewId = included.has('existing_review_id') ? lookupExistingReviewId(task) : null;

  const full = formatTaskResponse(
    task,
    { ...relations, workers },
    { worktree_row: worktreeRow, existing_review_id: existingReviewId },
  ) as Record<string, unknown>;
  // current_summary(+_updated_at) sourced from .octomux/artifact.md, not the
  // (retired) tasks columns — see server/artifact.ts.
  Object.assign(full, getArtifactSummary(task.worktree ?? null));

  if (!included.has('workers')) {
    delete full.workers;
    delete full.derived_status;
  }
  if (!included.has('pending_prompts')) delete full.pending_prompts;
  if (!included.has('user_terminals')) delete full.user_terminals;
  if (!included.has('pull_requests')) delete full.pull_requests;
  if (!included.has('worktree')) delete full.worktree_row;
  if (!included.has('existing_review_id')) delete full.existing_review_id;

  return full;
}

// ─── task.create ────────────────────────────────────────────────────────────
//
// NOTE: this reuses createTaskInputSchema's `notify_task` field name (not the
// wire route's `notify_task_id`) — reuse-over-duplication for a rarely-used
// field; the real POST /api/tasks route currently reads `notify_task_id` from
// the body, so an HTTP caller using this capability's generated route must
// send `notify_task`, not `notify_task_id`. Flagged as a discrepancy.

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
    depends_on: input.depends_on ?? null,
  });
}

// ─── task.start ───────────────────────────────────────────────────────────────

// async so a synchronous throw (not-found / not-idle) always surfaces as a
// rejected promise, consistent with every other handler here and with how
// http.ts's `await cap.handler(...)` treats it either way.
async function startTaskHandler(input: z.infer<typeof taskStartInputSchema>) {
  const task = getTaskRepo(input.id);
  if (!task) throw notFound('Task not found');

  if (task.runtime_state !== 'idle') {
    throw badRequest('Only draft tasks can be started');
  }
  if (isDependencyUnmet(task.depends_on)) {
    throw badRequest(`cannot start: waiting on depends_on task ${task.depends_on} to reach 'done'`);
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

  // Set/clear depends_on before evaluating auto-start, so a depends_on passed
  // in the SAME call already gates this move's own in_progress transition.
  let effectiveDependsOn = task.depends_on;
  if (input.depends_on !== undefined) {
    if (input.depends_on !== null) {
      const err = validateDependsOn(task.id, input.depends_on);
      if (err) throw badRequest(err);
    }
    setDependsOn(task.id, input.depends_on);
    effectiveDependsOn = input.depends_on;
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

  // A task becomes eligible to start once its dependency reaches 'done' —
  // the minimum useful semantics for depends_on (any earlier attempt to
  // start it was skipped, leaving it idle+in_progress; see
  // listDependentsAwaitingStart).
  if (input.workflow_status === 'done' && prevStatus !== 'done') {
    unblockDependents(task.id);
  }

  let autoStart: 'start' | 'resume' | null = null;
  if (
    input.workflow_status === 'in_progress' &&
    (task.runtime_state === 'idle' || task.runtime_state === 'error') &&
    !isDependencyUnmet(effectiveDependsOn)
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

/**
 * Mirrors DELETE /api/tasks/:id's conditional soft/hard delete exactly — NOT
 * runDeleteTask's unconditional hard delete (ticket point 5). Reuses the SAME
 * functions the route imports (softDeleteTask/deleteTask from task-engine,
 * hardDeleteTask from repositories) rather than schemas.ts's deleteTaskInputSchema
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

/**
 * Looks up a capability's METADATA from `TASK_CAPABILITY_META` by id and casts
 * it to `CapabilityMeta<TInput>`, inferring `TInput` from `schema` (passed only
 * for inference — never read). `TASK_CAPABILITY_META` is a plain
 * `CapabilityMeta[]` (TInput widened to `unknown`), so without this the spread
 * below would produce `{ input: z.ZodType<unknown>, handler: (input: Specific) => ... }`,
 * which fails `defineCapability`'s generic inference (a handler taking a
 * specific input type is not assignable where `unknown` is expected).
 */
function findMeta<TInput>(id: string, _schema: z.ZodType<TInput>): CapabilityMeta<TInput> {
  const meta = TASK_CAPABILITY_META.find((m) => m.id === id);
  if (!meta) throw new Error(`registry: missing capability metadata for '${id}'`);
  return meta as CapabilityMeta<TInput>;
}

export function registerTaskCapabilities(): void {
  defineCapability({
    ...findMeta('task.list', taskListInputSchema),
    handler: listTasksHandler,
  });

  defineCapability({
    ...findMeta('task.get', taskGetInputSchema),
    handler: getTaskHandler,
  });

  defineCapability({
    ...findMeta('task.create', taskCreateInputSchema),
    handler: createTaskHandler,
  });

  defineCapability({
    ...findMeta('task.start', taskStartInputSchema),
    handler: startTaskHandler,
  });

  defineCapability({
    ...findMeta('task.move', taskMoveInputSchema),
    handler: moveTaskHandler,
  });

  defineCapability({
    ...findMeta('task.close', closeTaskInputSchema),
    handler: closeTaskHandler,
  });

  defineCapability({
    ...findMeta('task.delete', taskDeleteInputSchema),
    handler: deleteTaskHandler,
  });
}
