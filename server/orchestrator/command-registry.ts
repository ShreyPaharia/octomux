/**
 * server/orchestrator/command-registry.ts
 *
 * Single DEFINE-ONCE registry for every orchestrator command (SHR-145).
 *
 * Each CommandDef pairs:
 *  - name        — MCP tool name (snake_case, e.g. "create_task")
 *  - action      — OrchestratorAction used in the API / switch routing
 *  - summary     — MCP tool description string
 *  - input       — canonical zod schema (from @octomux/capabilities/schemas.ts; or inline for resume-task)
 *  - mcp         — whether to register as an MCP write tool
 *  - handler     — executes the action, returns { result, activity? }
 *
 * The MCP server (mcp/server.ts) and the action dispatcher (actions.ts) are both
 * generated from this registry — no more hand-written duplicate lists.
 *
 * resume-task is intentionally mcp:false (it has no stable MCP schema — the conductor
 * resumes tasks via the API or by calling close_task + create_task instead).
 */

import { z } from 'zod';
import {
  createTaskInputSchema,
  sendMessageInputSchema,
  setStatusInputSchema,
  addAgentInputSchema,
  closeTaskInputSchema,
  deleteTaskInputSchema,
} from '@octomux/capabilities';
import {
  runCreateTask,
  runSendMessage,
  runAddAgent,
  runSetStatus,
  runCloseTask,
  runResumeTask,
  runDeleteTask,
} from './exec.js';
import { handleCreateSchedule } from '../routes/schedules.js';
import { createLoopRun } from '../routes/runs.js';
import type { WorkflowStatus } from '../types.js';

// ─── OrchestratorAction ───────────────────────────────────────────────────────
//
// Defined here (not in actions.ts) to avoid a circular dependency:
//   command-registry.ts  ↔  actions.ts  (cycle breaker: actions.ts re-exports this).

export type OrchestratorAction =
  | 'create-task'
  | 'send-message'
  | 'add-agent'
  | 'set-status'
  | 'close-task'
  | 'resume-task'
  | 'delete-task'
  | 'create-schedule'
  | 'start-loop';

// ─── Minimal schema for resume-task (no canonical schema in @octomux/capabilities/schemas.ts) ─

const resumeTaskInputSchema = z.object({
  task_id: z.string().describe('The octomux task id'),
});

// ─── Advisor write schemas (SHR advisor) ─────────────────────────────────────
//
// Inline zod shapes for the MCP tool surface; the deep validation (cron,
// timezone, ajv config schema, preset prompt rules) is the SAME code path as
// `POST /api/schedules` / `POST /api/runs` — the handlers below delegate to
// the exported route helpers, so MCP and REST can never drift.

const createScheduleInputSchema = z.object({
  kind: z.string().describe('Schedule kind (see list_schedule_kinds)'),
  repo_path: z.string().describe('Absolute path to the git repo the schedule runs against'),
  cron: z.string().describe("5-field cron expression, e.g. '0 9 * * 1-5'"),
  name: z.string().optional().describe('Display name (required for promptRequired kinds)'),
  timezone: z.string().optional().describe('IANA timezone (default UTC)'),
  enabled: z.boolean().optional().describe('Default true'),
  model: z.string().optional().describe('Model id override'),
  timeout_ms: z.number().optional().describe('Session timeout in ms (session kinds only)'),
  prompt: z
    .string()
    .optional()
    .describe('Prompt override (required for kinds with promptRequired:true)'),
  config: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Kind-specific config, validated against the kind's config schema"),
});

const startLoopInputSchema = z.object({
  task_id: z.string().describe('Existing octomux task id to loop (create_task first if needed)'),
  prompt: z.string().describe('The loop prompt each fresh-context iteration starts from'),
  verify: z.string().describe('Shell command that must exit 0 for the loop to be done'),
  max_iterations: z.number().describe('Maximum number of iterations'),
  budget_tokens: z.number().optional().describe('Optional token budget ceiling'),
  stall_after: z.number().optional().describe('Stop after N consecutive no-progress iterations'),
});

// ─── Policy tier ──────────────────────────────────────────────────────────────

/** Gate classification tier (spec §5). Declared once per command in the registry. */
export type PolicyTier = 'auto' | 'ask' | 'always-ask';

// ─── CommandDef type ──────────────────────────────────────────────────────────

export interface CommandContext {
  conversationId?: string;
}

export interface CommandResult {
  /** The executor return value. */
  result: unknown;
  /**
   * Receipt text for the activity push (e.g. "created task `ID` — TITLE").
   * When absent, no activity is pushed (used by callers that handle pushing
   * themselves, or for actions that never push — currently unused).
   */
  activity?: string;
}

// We use `z.ZodTypeAny` here so each CommandDef can hold any zod schema.
export interface CommandDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** MCP tool name (snake_case). Ignored when mcp:false. */
  name: string;
  /** OrchestratorAction discriminant used in API routing. */
  action: OrchestratorAction;
  /** MCP tool description string. Ignored when mcp:false. */
  summary: string;
  /** Canonical zod schema for this command's input. */
  input: S;
  /** Whether to register this command as an MCP write tool. */
  mcp: boolean;
  /** PreToolUse gate tier for this command (octomux CLI subcommand + MCP write tool). */
  tier: PolicyTier;
  /**
   * When set, the MCP write tool blocks on a human approval card FIRST — via
   * the same `onGatedInvoke` gate the capability-registry tools use (this
   * string is the card's capability id) — and only RPCs the action after
   * approval. The legacy conductor writes (send_message, add_agent) are
   * deliberately ungated (pre-gate behaviour); anything that can reach a
   * shell or create standing automation must set this.
   */
  gateCapabilityId?: string;
  /**
   * Execute the action. Receives the parsed input and the server-injected context.
   * Returns the result and optionally the activity receipt text.
   */
  handler: (parsedInput: z.infer<S>, ctx: CommandContext) => Promise<CommandResult>;
}

/**
 * Read-only CLI / MCP commands that are not orchestrator write actions but still
 * need a policy tier. Keeps AUTO_TOOLS and READ_SUBCOMMANDS in sync with COMMANDS.
 */
export interface PolicyOnlyCommand {
  /** MCP tool name when invoked as a direct tool (snake_case). */
  mcpName?: string;
  /** octomux CLI subcommand when invoked via Bash (kebab-case). */
  cliSubcommand?: string;
  tier: PolicyTier;
}

export const POLICY_ONLY_COMMANDS: PolicyOnlyCommand[] = [
  { mcpName: 'list_tasks', cliSubcommand: 'list-tasks', tier: 'auto' },
  { mcpName: 'get_task', cliSubcommand: 'get-task', tier: 'auto' },
  { mcpName: 'monitor_status', tier: 'auto' },
  { mcpName: 'get_task_output', tier: 'auto' },
  { mcpName: 'get_agent_output', tier: 'auto' },
  { mcpName: 'pull_linear_issue', tier: 'auto' },
  { mcpName: 'search_learnings', tier: 'auto' },
  { mcpName: 'list_schedules', tier: 'auto' },
  { mcpName: 'list_schedule_kinds', tier: 'auto' },
  { mcpName: 'get_settings', tier: 'auto' },
  { cliSubcommand: 'recent-repos', tier: 'auto' },
  { cliSubcommand: 'default-branch', tier: 'auto' },
  { cliSubcommand: 'list-skills', tier: 'auto' },
  { cliSubcommand: 'get-skill', tier: 'auto' },
  // 'task-summary' CLI subcommand retired with the `octomux task-summary`
  // command (spec §5.5) — the narrative it wrote moved into the per-task
  // `.octomux/artifact.md`, which has no CLI write surface in this pass.
  { cliSubcommand: 'task-updates', tier: 'auto' },
  { cliSubcommand: 'hooks-list', tier: 'auto' },
  { cliSubcommand: 'list-integrations', tier: 'auto' },
  { cliSubcommand: 'request-review', tier: 'ask' },
];

// ─── Registry ─────────────────────────────────────────────────────────────────

export const COMMANDS: CommandDef[] = [
  {
    name: 'create_task',
    action: 'create-task',
    summary:
      'Create an octomux worker task and start it. Pass a GOAL-ORIENTED brief in ' +
      'description (Goal / Why / verifiable Acceptance criteria / Hard constraints / ' +
      'Non-goals / Pointers) -- never a step-by-step plan; the worker explores the code ' +
      'and owns the implementation. ' +
      'kind="workflow" triggers spec->plan->implement with review gates at spec and plan; ' +
      'use for non-trivial/larger work. ' +
      'kind="plan" -- worker plans first for your review, then implements; use for ' +
      'plan-only or moderately ambiguous work. ' +
      'Omit kind for small/clear work (implements directly). ' +
      'initial_prompt overrides the agent first message (defaults to description). ' +
      'run_mode controls worktree: new|existing|none|scratch (default: new). ' +
      'Returns the task id (a pointer).',
    input: createTaskInputSchema,
    mcp: true,
    tier: 'ask',
    async handler(parsed, ctx) {
      const result = await runCreateTask({
        ...parsed,
        conversation_id: ctx.conversationId,
      });
      const activity = `created task \`${result.task_id}\` — ${result.title}`;
      return { result, activity };
    },
  },

  {
    name: 'send_message',
    action: 'send-message',
    summary: 'Send a message/instruction to a running task agent (e.g. nudge or redirect).',
    input: sendMessageInputSchema,
    mcp: true,
    tier: 'ask',
    async handler(parsed, _ctx) {
      await runSendMessage(parsed.task_id, parsed.message);
      const result = { task_id: parsed.task_id };
      const activity = `sent a message to task \`${parsed.task_id}\``;
      return { result, activity };
    },
  },

  {
    name: 'set_task_status',
    action: 'set-status',
    summary:
      'Set a task workflow status (backlog | planned | in_progress | human_review | pr | done).',
    input: setStatusInputSchema,
    mcp: true,
    tier: 'ask',
    async handler(parsed, _ctx) {
      await runSetStatus(parsed.task_id, parsed.status as WorkflowStatus);
      const result = { task_id: parsed.task_id, status: parsed.status };
      const activity = `set task \`${parsed.task_id}\` status to \`${parsed.status}\``;
      return { result, activity };
    },
  },

  {
    name: 'add_agent',
    action: 'add-agent',
    summary: 'Attach another agent (new tmux window) to a running task, sharing its worktree.',
    input: addAgentInputSchema,
    mcp: true,
    tier: 'ask',
    async handler(parsed, _ctx) {
      const { task_id, ...opts } = parsed;
      const result = await runAddAgent(task_id, opts);
      const activity = `added agent \`${result.agent_id}\` to task \`${task_id}\``;
      return { result, activity };
    },
  },

  {
    name: 'close_task',
    action: 'close-task',
    summary:
      'Close a task: stop its agents + kill its tmux session. Preserves the worktree/branch ' +
      'so it can be resumed. Runs immediately (no approval).',
    input: closeTaskInputSchema,
    mcp: true,
    tier: 'always-ask',
    async handler(parsed, _ctx) {
      await runCloseTask(parsed.task_id);
      const result = { task_id: parsed.task_id };
      const activity = `closed task \`${parsed.task_id}\``;
      return { result, activity };
    },
  },

  {
    name: 'resume_task',
    action: 'resume-task',
    // resume-task is not exposed as an MCP tool — the conductor uses close_task +
    // create_task instead, or the REST API. The minimal inline schema lets the
    // registry-based dispatcher parse it consistently.
    summary: '',
    input: resumeTaskInputSchema,
    mcp: false,
    tier: 'ask',
    async handler(parsed, _ctx) {
      await runResumeTask(parsed.task_id);
      const result = { task_id: parsed.task_id };
      const activity = `resumed task \`${parsed.task_id}\``;
      return { result, activity };
    },
  },

  {
    name: 'delete_task',
    action: 'delete-task',
    summary:
      'DELETE a task: kill tmux + remove worktree + delete branch + delete DB rows. Destructive ' +
      'and irreversible. Runs immediately (no approval) -- only call when the user clearly intends it.',
    input: deleteTaskInputSchema,
    mcp: true,
    tier: 'always-ask',
    async handler(parsed, _ctx) {
      await runDeleteTask(parsed.task_id);
      const result = { task_id: parsed.task_id };
      const activity = `deleted task \`${parsed.task_id}\``;
      return { result, activity };
    },
  },

  {
    name: 'create_schedule',
    action: 'create-schedule',
    summary:
      'Create a cron schedule (kind + cron + repo). Calling this raises an approval card the ' +
      'user must confirm before the schedule is created. Use list_schedule_kinds to pick a ' +
      'kind; kinds with promptRequired:true need an explicit prompt + name. Validated exactly ' +
      'like POST /api/schedules. Returns the created schedule row.',
    input: createScheduleInputSchema,
    mcp: true,
    tier: 'ask',
    gateCapabilityId: 'schedule.create',
    async handler(parsed, _ctx) {
      const row = handleCreateSchedule({
        kind: parsed.kind,
        repoPath: parsed.repo_path,
        cron: parsed.cron,
        name: parsed.name,
        timezone: parsed.timezone,
        enabled: parsed.enabled,
        model: parsed.model,
        timeoutMs: parsed.timeout_ms,
        prompt: parsed.prompt,
        config: parsed.config,
      });
      const activity = `created schedule \`${row.id}\` (${row.kind}, \`${row.cron}\`) for ${row.repo_path}`;
      return { result: row, activity };
    },
  },

  {
    name: 'start_loop',
    action: 'start-loop',
    summary:
      'Start a fresh-context Ralph loop against an EXISTING running task: the agent is respawned ' +
      'each iteration until the verify command exits 0 (or max_iterations / budget / stall). ' +
      'verify runs as a shell command on the host, so calling this raises an approval card the ' +
      'user must confirm before the loop starts. Returns the run id.',
    input: startLoopInputSchema,
    mcp: true,
    tier: 'ask',
    gateCapabilityId: 'loop.start',
    async handler(parsed, _ctx) {
      const runId = await createLoopRun({
        workflowKind: 'loop',
        taskId: parsed.task_id,
        spec: {
          prompt: parsed.prompt,
          verify: parsed.verify,
          maxIterations: parsed.max_iterations,
          ...(parsed.budget_tokens != null ? { budget: { tokens: parsed.budget_tokens } } : {}),
          ...(parsed.stall_after != null ? { noProgress: { afterIters: parsed.stall_after } } : {}),
        },
      });
      const result = { run_id: runId, task_id: parsed.task_id };
      const activity = `started loop run \`${runId}\` on task \`${parsed.task_id}\``;
      return { result, activity };
    },
  },
];

// ─── Policy set derivation ────────────────────────────────────────────────────

export interface PolicySets {
  AUTO_TOOLS: Set<string>;
  READ_SUBCOMMANDS: Set<string>;
  ASK_SUBCOMMANDS: Set<string>;
  ALWAYS_ASK_SUBCOMMANDS: Set<string>;
}

/** Build gate policy sets from the command registry at module load. */
export function buildPolicySets(
  commands: CommandDef[] = COMMANDS,
  policyOnly: PolicyOnlyCommand[] = POLICY_ONLY_COMMANDS,
): PolicySets {
  const AUTO_TOOLS = new Set<string>();
  const READ_SUBCOMMANDS = new Set<string>();
  const ASK_SUBCOMMANDS = new Set<string>();
  const ALWAYS_ASK_SUBCOMMANDS = new Set<string>();

  for (const cmd of commands) {
    switch (cmd.tier) {
      case 'auto':
        if (cmd.mcp) AUTO_TOOLS.add(cmd.name);
        READ_SUBCOMMANDS.add(cmd.action);
        break;
      case 'ask':
        ASK_SUBCOMMANDS.add(cmd.action);
        break;
      case 'always-ask':
        ALWAYS_ASK_SUBCOMMANDS.add(cmd.action);
        break;
    }
  }

  for (const cmd of policyOnly) {
    switch (cmd.tier) {
      case 'auto':
        if (cmd.mcpName) AUTO_TOOLS.add(cmd.mcpName);
        if (cmd.cliSubcommand) READ_SUBCOMMANDS.add(cmd.cliSubcommand);
        break;
      case 'ask':
        if (cmd.cliSubcommand) ASK_SUBCOMMANDS.add(cmd.cliSubcommand);
        break;
      case 'always-ask':
        if (cmd.cliSubcommand) ALWAYS_ASK_SUBCOMMANDS.add(cmd.cliSubcommand);
        break;
    }
  }

  return { AUTO_TOOLS, READ_SUBCOMMANDS, ASK_SUBCOMMANDS, ALWAYS_ASK_SUBCOMMANDS };
}

// ─── Lookup helpers ───────────────────────────────────────────────────────────

/**
 * Look up a CommandDef by its OrchestratorAction.
 * Returns undefined when no matching def is found.
 */
export function getCommandByAction(action: OrchestratorAction): CommandDef | undefined {
  return COMMANDS.find((c) => c.action === action);
}
