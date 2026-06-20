/**
 * server/orchestrator/exec.ts
 *
 * Gated octomux write-command executor for the orchestrator (Tasks 2.3 / SHR-126,
 * 2.5 / SHR-128).
 *
 * This module runs approved octomux operations server-side, without going through
 * an external CLI subprocess. It reuses the existing task-runner and DB functions
 * directly — the orchestrator's gated Bash-deny path in Phase 3 will call these
 * same functions on approval.
 *
 * Phase 2.3 scope: `create-task` with `kind:plan` support.
 *  - When `kind:'plan'`, the worker's `initial_prompt` is prefixed with a
 *    planning template that instructs the worker to write a conforming `plan.json`
 *    and call `signal_phase_complete(plan)` when done.
 *  - The template injects the schema_version so the worker produces a conforming
 *    artifact.
 *  - The orchestrator receives only the task_id pointer — never plan contents.
 *
 * Phase 2.5 scope: `send-message` relay.
 *  - `runSendMessage(taskId, message)` sends a turn to the first running agent of
 *    a task via `sendMessageToAgent` (tmux send-keys). Used by the supervisor to
 *    continue a worker at phase boundaries (e.g. "implement the approved plan.json").
 *  - Returns only success/failure; never relays plan/diff/file body contents.
 *
 * Pointers-not-contents (spec §1): this module returns task IDs and paths only.
 * It never returns plan/diff/file body contents to the orchestrator.
 *
 * JSON Schema ownership: `plan-schema.json` is the single source of truth for the
 * plan artifact shape. `validatePlanJson` checks worker-produced plans on read by
 * the artifact endpoint (§6.5); on failure the UI picks prose-fallback rendering.
 */

import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import { startTask, closeTask, deleteTask, resumeTask, addAgent } from '../task-runner.js';
import { sendMessageToAgent } from '../tmux-input.js';
import { upsertManagedTask } from './store.js';
import { childLogger } from '../logger.js';
import { SELECT_TASK_SQL } from '../task-select.js';
import { WORKFLOW_STATUSES } from '../types.js';
import type { Task, Agent, RunMode, WorkflowStatus } from '../types.js';

const logger = childLogger('orchestrator/exec');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Schema version embedded in plan.json and injected into the planning template. */
export const PLAN_SCHEMA_VERSION = '1.0.0';

/** The `kind` value that triggers planning-template injection. */
export const PLAN_KIND = 'plan' as const;

/** The `kind` value that triggers the full spec→plan→implement workflow. */
export const WORKFLOW_KIND = 'workflow' as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  /** Task title. Defaults to the first line of initial_prompt if omitted. */
  title?: string;
  /** Task description. Defaults to initial_prompt if omitted. */
  description?: string;
  /** Repo path for run_mode='new'|'none'. */
  repo_path?: string;
  /** Existing worktree path for run_mode='existing'. */
  worktree_path?: string;
  /** Branch name for run_mode='new'. */
  branch?: string;
  /** Base branch. */
  base_branch?: string;
  /** The user's intent / task instructions sent as the initial agent prompt. */
  initial_prompt?: string;
  /** 'new' | 'existing' | 'none' | 'scratch'. Defaults to 'new'. */
  run_mode?: RunMode;
  /** When 'plan': injects the planning template into initial_prompt and registers
   *  the task in managed_tasks with phase='planning'.
   *  When 'workflow': injects the workflow template and registers with phase='speccing'. */
  kind?: typeof PLAN_KIND | typeof WORKFLOW_KIND | string;
  /** Optional model override (e.g. 'claude-sonnet-4-6'). */
  model?: string | null;
  /**
   * Optional effort hint for model right-sizing (§6.7).
   * Values: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
   * This is an advisory hint from the orchestrator — it controls how the
   * model is chosen when model is null (e.g. 'xhigh' suggests Opus-class).
   * When model is explicitly set, effort is informational only.
   * The hint is logged and available to callers but is not stored in the DB
   * (no schema column); it guides the orchestrator's model-selection policy.
   */
  effort?: string;
  /** Orchestrator conversation that owns this task. Required to register the task
   *  in managed_tasks so the supervisor can route events to it. */
  conversation_id?: string;
}

export interface CreateTaskResult {
  /** The newly created task's id. The orchestrator holds only this pointer. */
  task_id: string;
  /** Title for UI display. */
  title: string;
}

// ─── Plan validation ──────────────────────────────────────────────────────────

/** Minimal structural validation — not a full JSON Schema validator, but covers
 *  the required fields and enum constraints defined in plan-schema.json. */
export interface ValidatePlanResult {
  valid: boolean;
  /** Human-readable error messages when valid=false. */
  errors?: string[];
}

/**
 * Validate a worker-produced plan against the octomux plan JSON Schema.
 *
 * Used by the artifact endpoint on read (§6.5): on failure the UI picks
 * prose-fallback rendering instead of the editable file-level card.
 *
 * Does NOT import a heavy JSON Schema library — keeps the server bundle lean.
 * Validates the subset of constraints defined in plan-schema.json that matter
 * for the editable card rendering.
 */
export function validatePlanJson(plan: unknown): ValidatePlanResult {
  const errors: string[] = [];

  if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) {
    return { valid: false, errors: ['plan must be a JSON object'] };
  }

  const p = plan as Record<string, unknown>;

  // schema_version: required, must equal PLAN_SCHEMA_VERSION
  if (p['schema_version'] === undefined || p['schema_version'] === null) {
    errors.push(`schema_version is required (expected "${PLAN_SCHEMA_VERSION}")`);
  } else if (p['schema_version'] !== PLAN_SCHEMA_VERSION) {
    errors.push(
      `schema_version mismatch: got "${String(p['schema_version'])}", expected "${PLAN_SCHEMA_VERSION}"`,
    );
  }

  // summary: required, non-empty string
  if (typeof p['summary'] !== 'string' || p['summary'].trim().length === 0) {
    errors.push('summary is required and must be a non-empty string');
  }

  // files: required, must be an array
  if (!Array.isArray(p['files'])) {
    errors.push('files must be an array');
  } else {
    const VALID_ACTIONS = ['create', 'modify', 'delete', 'rename'] as const;
    (p['files'] as unknown[]).forEach((entry, i) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        errors.push(`files[${i}] must be an object`);
        return;
      }
      const f = entry as Record<string, unknown>;

      if (typeof f['path'] !== 'string' || f['path'].trim().length === 0) {
        errors.push(`files[${i}].path is required and must be a non-empty string`);
      }

      if (!VALID_ACTIONS.includes(f['action'] as (typeof VALID_ACTIONS)[number])) {
        errors.push(
          `files[${i}].action must be one of ${VALID_ACTIONS.join(', ')} (got "${String(f['action'])}")`,
        );
      }
    });
  }

  // open_questions: optional, but must be an array of strings if present
  if (p['open_questions'] !== undefined) {
    if (!Array.isArray(p['open_questions'])) {
      errors.push('open_questions must be an array');
    } else {
      (p['open_questions'] as unknown[]).forEach((q, i) => {
        if (typeof q !== 'string') {
          errors.push(`open_questions[${i}] must be a string`);
        }
      });
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ─── Planning template ────────────────────────────────────────────────────────

/**
 * Build the planning template that instructs a worker to:
 *  1. Analyse the request and write a conforming plan.json to its worktree.
 *  2. Call `signal_phase_complete` via the phase-complete HTTP hook so the
 *     orchestrator can route the artifact pointer to the user.
 *
 * The worker re-reads plan.json from disk after the user approves (so user edits
 * actually take effect) — this is a hard contract enforced by the template.
 *
 * Pointers discipline: the orchestrator never receives plan body contents — only
 * the task_id. Plan contents travel worker → disk → UI (§6.5).
 */
function buildPlanningTemplate(userPrompt: string): string {
  return `## Planning Session Instructions

You are a **planning session** for an octomux orchestrator workflow. Your job is to
analyse the request below, produce a structured plan, and signal when you are done.

### Your task

${userPrompt}

### Required output: \`plan.json\`

Write a single file \`plan.json\` to your worktree root. It **must** conform to the
following structure (schema_version \`${PLAN_SCHEMA_VERSION}\`):

\`\`\`json
{
  "schema_version": "${PLAN_SCHEMA_VERSION}",
  "summary": "<1–3 sentence summary of what you will build>",
  "files": [
    {
      "path": "<relative file path from repo root>",
      "action": "<create|modify|delete|rename>",
      "steps": ["<concrete step 1>", "<concrete step 2>"]
    }
  ],
  "open_questions": ["<question for the user if anything is unclear>"],
  "detail": "<optional: full prose plan body>"
}
\`\`\`

Rules:
- \`schema_version\` must be exactly \`"${PLAN_SCHEMA_VERSION}"\`.
- \`summary\` must be a non-empty string.
- \`files\` must be an array (may be empty if no file changes are needed).
- Each \`files\` entry must have \`path\` (string) and \`action\` (one of: create, modify, delete, rename).
- \`open_questions\` is optional; include it when clarification is needed before implementation.
- You may add any extra fields — they are preserved and shown to the user.

### Signal phase complete

**You do not need to run any command to signal.** After you have written
\`plan.json\` to your worktree root, simply **finish your turn and stop**. The
orchestrator watches for \`plan.json\` and detects it automatically when your turn
ends, then presents it to the user for review.

So the contract is:
1. Write \`plan.json\` (conforming to the schema above).
2. Do nothing else and end your turn.

### After the plan is approved

**Wait at your interactive prompt.** The orchestrator will present \`plan.json\` to
the user for review. When the user approves (possibly with edits), the orchestrator
will send you an "implement" message. At that point:

1. **Re-read \`plan.json\` from disk** — do not rely on your memory of what you wrote.
   The user may have edited it, and those edits are the authoritative source of truth.
2. Implement exactly what the re-read \`plan.json\` specifies.
3. When implementation is complete, end your turn.
`;
}

/**
 * Build the workflow template for a kind:'workflow' task that runs spec→plan→implement
 * in a SINGLE worker session, with review gates at each phase boundary.
 *
 * The worker contract:
 *  1) Write spec.md (goal / why / acceptance criteria / constraints / non-goals)
 *     to the repo root and END THE TURN. Do not start planning yet — you'll be prompted.
 *  2) When prompted, produce the implementation plan and write it to plan.json
 *     (same schema as buildPlanningTemplate). Then END THE TURN.
 *  3) When the plan is approved you'll be told to implement: re-read plan.json
 *     from disk, implement it, then create .octomux/ and write an empty
 *     .octomux/implement-done file, and END THE TURN.
 *
 * Pointers discipline: orchestrator holds only task_id pointer — never spec/plan body.
 */
export function buildWorkflowTemplate(userPrompt: string): string {
  return `## Workflow Session Instructions

You are a **workflow session** for an octomux orchestrator. You will run through
three phases in sequence — **spec**, **plan**, and **implement** — in this single
session. The orchestrator will prompt you at each phase boundary.

### Your task

${userPrompt}

---

## Phase 1: SPEC

Write a concise specification to \`spec.md\` at the repo root covering:

- **Goal** — 1–2 sentences: what capability should exist when done.
- **Why / Context** — intent and how it fits, so implementers make sound tradeoffs.
- **Acceptance criteria** — verifiable: passing tests / build+lint green / concrete examples.
- **Constraints** — non-negotiables (don't break X, no new deps, follow CLAUDE.md).
- **Non-goals** — explicitly what NOT to touch (prevents scope-creep).

After writing \`spec.md\`, **end your turn immediately**. Do not start planning yet —
the orchestrator will share the spec for review and then prompt you to plan.

---

## Phase 2: PLAN (you will be prompted)

When the orchestrator prompts you to plan, write \`plan.json\` to the repo root.
It **must** conform to the following structure (schema_version \`${PLAN_SCHEMA_VERSION}\`):

\`\`\`json
{
  "schema_version": "${PLAN_SCHEMA_VERSION}",
  "summary": "<1–3 sentence summary of what you will build>",
  "files": [
    {
      "path": "<relative file path from repo root>",
      "action": "<create|modify|delete|rename>",
      "steps": ["<concrete step 1>", "<concrete step 2>"]
    }
  ],
  "open_questions": ["<question for the user if anything is unclear>"],
  "detail": "<optional: full prose plan body>"
}
\`\`\`

Rules:
- \`schema_version\` must be exactly \`"${PLAN_SCHEMA_VERSION}"\`.
- \`summary\` must be a non-empty string.
- \`files\` must be an array (may be empty if no file changes are needed).
- Each \`files\` entry must have \`path\` (string) and \`action\` (one of: create, modify, delete, rename).
- \`open_questions\` is optional; include it when clarification is needed before implementation.

After writing \`plan.json\`, **end your turn immediately**. The orchestrator will
present it for review. Do not start implementing yet.

---

## Phase 3: IMPLEMENT (you will be prompted after plan approval)

When the orchestrator tells you to implement:

1. **Re-read \`plan.json\` from disk** — do not rely on your memory of what you wrote.
   The user may have edited it, and those edits are the authoritative source of truth.
2. Implement exactly what the re-read \`plan.json\` specifies.
3. When implementation is complete, create the directory \`.octomux/\` (if it does not
   exist) and write an **empty file** \`.octomux/implement-done\` as a sentinel.
4. **End your turn.** The orchestrator detects the sentinel automatically.
`;
}

// ─── runCreateTask ────────────────────────────────────────────────────────────

/**
 * Create and start a new octomux task.
 *
 * This is the server-side executor for the orchestrator's `create-task` write
 * command (approved via the Bash/PreToolUse gate in Phase 3).
 *
 * When `kind:'plan'`:
 *  - The planning template is prepended to `initial_prompt`.
 *  - The task is registered in `managed_tasks` with `phase='planning'` so the
 *    supervisor can route phase-complete events to the owning conversation.
 *
 * Returns only the task_id pointer — never plan/diff/file body contents.
 */
export async function runCreateTask(input: CreateTaskInput): Promise<CreateTaskResult> {
  const db = getDb();
  const id = nanoid(12);
  const runMode: RunMode = input.run_mode ?? 'new';
  const isPlanning = input.kind === PLAN_KIND;
  const isWorkflow = input.kind === WORKFLOW_KIND;

  logger.info(
    {
      task_id: id,
      operation: 'runCreateTask',
      kind: input.kind ?? 'default',
      run_mode: runMode,
      model: input.model ?? null,
      effort: input.effort ?? null,
      conversation_id: input.conversation_id ?? null,
    },
    'runCreateTask: start',
  );

  // Resolve title and description from input, falling back to initial_prompt.
  const initialPromptTrimmed = input.initial_prompt?.trim() ?? '';
  const resolvedTitle =
    input.title?.trim() || initialPromptTrimmed.split('\n')[0]?.slice(0, 80) || 'Untitled task';
  const resolvedDescription = input.description?.trim() || initialPromptTrimmed || '';

  // For plan kind, inject the planning template; for workflow, inject the workflow template.
  const resolvedPrompt = isWorkflow
    ? buildWorkflowTemplate(initialPromptTrimmed)
    : isPlanning
      ? buildPlanningTemplate(initialPromptTrimmed)
      : (input.initial_prompt ?? null);

  // Phase 2a: always create a worktree row. For 'new' mode, path starts empty
  // (startTask fills it in during setup). For 'existing' mode, use worktree_path.
  // For 'scratch' mode, no repo_path.
  let storedRepoPath: string;
  let storedWorktree: string | null;

  if (runMode === 'scratch') {
    storedRepoPath = '';
    storedWorktree = null;
  } else if (runMode === 'existing') {
    storedRepoPath = input.repo_path ?? '';
    storedWorktree = input.worktree_path ?? null;
  } else {
    storedRepoPath = input.repo_path ?? '';
    storedWorktree = null;
  }

  const worktreeId = nanoid(12);
  db.prepare(
    `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, base_sha, mode, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'in_use')`,
  ).run(
    worktreeId,
    storedWorktree ?? storedRepoPath,
    storedRepoPath || null,
    input.branch ?? null,
    input.base_branch ?? null,
    null,
    runMode,
  );

  db.prepare(
    `INSERT INTO tasks
       (id, title, description, runtime_state, workflow_status, initial_prompt, worktree_id, harness_id, model)
     VALUES (?, ?, ?, 'setting_up', 'planned', ?, ?, 'claude-code', ?)`,
  ).run(id, resolvedTitle, resolvedDescription, resolvedPrompt, worktreeId, input.model ?? null);

  const created = db.prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(id) as Task;

  // Register in managed_tasks so the supervisor can route events to the
  // owning conversation (spec §6, §9). Only when a conversation is provided.
  // Phase column:
  //   kind:'workflow'  → 'speccing'    (spec → plan → implement in one session)
  //   kind:'plan'      → 'planning'    (plan → await approval → implement)
  //   default          → 'implementing' (implements directly)
  if (input.conversation_id) {
    const initialPhase = isWorkflow ? 'speccing' : isPlanning ? 'planning' : 'implementing';
    upsertManagedTask({
      conversation_id: input.conversation_id,
      task_id: id,
      phase: initialPhase,
    });
  }

  logger.info(
    {
      task_id: id,
      operation: 'runCreateTask',
      title: resolvedTitle,
      kind: input.kind ?? 'default',
      conversation_id: input.conversation_id ?? null,
      prompt_injected: isPlanning || isWorkflow,
    },
    'runCreateTask: task created, starting',
  );

  // Fire-and-forget: startTask handles the rest (worktree, tmux, agent).
  void startTask(created).catch((err: unknown) => {
    logger.error(
      { task_id: id, operation: 'runCreateTask', err },
      'runCreateTask: startTask failed',
    );
  });

  return { task_id: id, title: resolvedTitle };
}

// ─── runSendMessage ───────────────────────────────────────────────────────────

/**
 * Send a turn to the first running agent of a task via tmux send-keys.
 *
 * Used by the supervisor relay (Task 2.5 / SHR-128) to continue a worker at a
 * phase boundary — e.g. "implement the approved plan.json" after the user approves.
 *
 * The worker must be alive at its interactive tmux prompt (spec §6.5, R3-I2).
 * If the worker has exited, continuity falls back to `claude --resume` (handled
 * separately by the runner). This function only handles the alive-at-prompt case.
 *
 * Pointers-not-contents: the `message` parameter is a short directive
 * (e.g. "implement the approved plan.json") — it is a pointer, not file body
 * contents. Callers must not pass plan/diff file bodies as the message.
 */
export async function runSendMessage(taskId: string, message: string): Promise<void> {
  const db = getDb();

  logger.info(
    { task_id: taskId, operation: 'runSendMessage', messageLen: message.length },
    'runSendMessage: start',
  );

  // Look up the task to find its tmux session.
  const task = db.prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(taskId) as Task | undefined;
  if (!task) {
    logger.warn({ task_id: taskId, operation: 'runSendMessage' }, 'runSendMessage: task not found');
    throw new Error(`runSendMessage: task ${taskId} not found`);
  }

  if (!task.tmux_session) {
    logger.warn(
      { task_id: taskId, operation: 'runSendMessage' },
      'runSendMessage: task has no tmux_session — worker may have exited',
    );
    throw new Error(`runSendMessage: task ${taskId} has no active tmux session`);
  }

  // Find the first running agent for this task.
  const agent = db
    .prepare(
      `SELECT * FROM agents
       WHERE task_id = ? AND status != 'stopped'
       ORDER BY window_index ASC
       LIMIT 1`,
    )
    .get(taskId) as Agent | undefined;

  if (!agent) {
    logger.warn(
      { task_id: taskId, operation: 'runSendMessage' },
      'runSendMessage: no active agent found for task',
    );
    throw new Error(`runSendMessage: no active agent found for task ${taskId}`);
  }

  logger.info(
    {
      task_id: taskId,
      agent_id: agent.id,
      operation: 'runSendMessage',
      tmux_session: task.tmux_session,
      window_index: agent.window_index,
    },
    'runSendMessage: delivering turn to worker',
  );

  await sendMessageToAgent(task.tmux_session, agent.window_index, message);

  logger.info(
    { task_id: taskId, agent_id: agent.id, operation: 'runSendMessage' },
    'runSendMessage: turn delivered',
  );
}

// ─── runAddAgent ──────────────────────────────────────────────────────────────

export interface AddAgentInput {
  /** Optional initial prompt for the new agent. */
  prompt?: string;
  /** Optional agent persona name (matches agents/<name>.md). */
  agent?: string | null;
  /** Optional label for the agent window. */
  label?: string;
  /** Optional per-agent model override. */
  model?: string | null;
  /** Optional skeleton name to use as the agent's template. */
  skeleton?: string;
}

export interface AddAgentResult {
  /** The newly added agent's id. */
  agent_id: string;
  /** The tmux window index of the new agent. */
  window_index: number;
}

/**
 * Add a new agent window to an existing running task.
 *
 * This is the server-side executor for the orchestrator's `add-agent` write
 * command (gated: ask tier). Reuses task-runner's `addAgent` function.
 *
 * Returns only the agent_id pointer — never plan/diff/file body contents.
 */
export async function runAddAgent(taskId: string, opts: AddAgentInput): Promise<AddAgentResult> {
  const db = getDb();

  logger.info(
    { task_id: taskId, operation: 'runAddAgent', label: opts.label ?? null },
    'runAddAgent: start',
  );

  const task = db.prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(taskId) as Task | undefined;
  if (!task) {
    logger.warn({ task_id: taskId, operation: 'runAddAgent' }, 'runAddAgent: task not found');
    throw new Error(`runAddAgent: task ${taskId} not found`);
  }

  const agent = await addAgent(task, {
    prompt: opts.prompt,
    agent: opts.agent ?? null,
    label: opts.label,
    model: opts.model ?? null,
    skeleton: opts.skeleton,
  });

  logger.info(
    {
      task_id: taskId,
      agent_id: agent.id,
      operation: 'runAddAgent',
      window_index: agent.window_index,
    },
    'runAddAgent: agent added',
  );

  return { agent_id: agent.id, window_index: agent.window_index };
}

// ─── runSetStatus ─────────────────────────────────────────────────────────────

/**
 * Update the workflow_status of a task.
 *
 * This is the server-side executor for the orchestrator's `set-status` write
 * command (gated: ask tier). Directly updates the workflow_status column.
 *
 * Valid statuses: backlog | planned | in_progress | human_review | pr | done.
 */
export async function runSetStatus(taskId: string, status: WorkflowStatus): Promise<void> {
  const db = getDb();

  logger.info({ task_id: taskId, operation: 'runSetStatus', status }, 'runSetStatus: start');

  if (!WORKFLOW_STATUSES.includes(status)) {
    throw new Error(
      `runSetStatus: invalid status "${status}" (must be one of ${WORKFLOW_STATUSES.join(', ')})`,
    );
  }

  const task = db
    .prepare('SELECT id FROM tasks WHERE id = ? AND deleted_at IS NULL')
    .get(taskId) as { id: string } | undefined;
  if (!task) {
    logger.warn({ task_id: taskId, operation: 'runSetStatus' }, 'runSetStatus: task not found');
    throw new Error(`runSetStatus: task ${taskId} not found`);
  }

  db.prepare(`UPDATE tasks SET workflow_status = ?, updated_at = datetime('now') WHERE id = ?`).run(
    status,
    taskId,
  );

  logger.info(
    { task_id: taskId, operation: 'runSetStatus', status },
    'runSetStatus: status updated',
  );
}

// ─── runCloseTask ─────────────────────────────────────────────────────────────

/**
 * Close a running task (stop agents + kill tmux session).
 *
 * This is the server-side executor for the orchestrator's `close-task` write
 * command (gated: always-ask tier — destructive, never auto-allowed).
 *
 * Close preserves the worktree and branch (for resume). Use runDeleteTask for
 * full cleanup.
 */
export async function runCloseTask(taskId: string): Promise<void> {
  const db = getDb();

  logger.info({ task_id: taskId, operation: 'runCloseTask' }, 'runCloseTask: start');

  const task = db.prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(taskId) as Task | undefined;
  if (!task) {
    logger.warn({ task_id: taskId, operation: 'runCloseTask' }, 'runCloseTask: task not found');
    throw new Error(`runCloseTask: task ${taskId} not found`);
  }

  await closeTask(task);

  logger.info({ task_id: taskId, operation: 'runCloseTask' }, 'runCloseTask: complete');
}

// ─── runResumeTask ────────────────────────────────────────────────────────────

/**
 * Resume a closed/idle task (restart tmux session + agents).
 *
 * This is the server-side executor for the orchestrator's `resume-task` write
 * command (gated: ask tier).
 */
export async function runResumeTask(taskId: string): Promise<void> {
  const db = getDb();

  logger.info({ task_id: taskId, operation: 'runResumeTask' }, 'runResumeTask: start');

  const task = db.prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(taskId) as Task | undefined;
  if (!task) {
    logger.warn({ task_id: taskId, operation: 'runResumeTask' }, 'runResumeTask: task not found');
    throw new Error(`runResumeTask: task ${taskId} not found`);
  }

  await resumeTask(task);

  logger.info({ task_id: taskId, operation: 'runResumeTask' }, 'runResumeTask: complete');
}

// ─── runDeleteTask ────────────────────────────────────────────────────────────

/**
 * Hard-delete a task (kill tmux + remove worktree + delete branch + delete DB rows).
 *
 * This is the server-side executor for the orchestrator's `delete-task` write
 * command (gated: always-ask tier — fully destructive, never auto-allowed).
 *
 * Use runCloseTask to stop a task while preserving the worktree.
 */
export async function runDeleteTask(taskId: string): Promise<void> {
  const db = getDb();

  logger.info({ task_id: taskId, operation: 'runDeleteTask' }, 'runDeleteTask: start');

  const task = db.prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(taskId) as Task | undefined;
  if (!task) {
    logger.warn({ task_id: taskId, operation: 'runDeleteTask' }, 'runDeleteTask: task not found');
    throw new Error(`runDeleteTask: task ${taskId} not found`);
  }

  await deleteTask(task);

  logger.info({ task_id: taskId, operation: 'runDeleteTask' }, 'runDeleteTask: complete');
}
