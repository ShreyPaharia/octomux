/**
 * server/orchestrator/command-registry.ts
 *
 * Single DEFINE-ONCE registry for every orchestrator command (SHR-145).
 *
 * Each CommandDef pairs:
 *  - name        — MCP tool name (snake_case, e.g. "create_task")
 *  - action      — OrchestratorAction used in the API / switch routing
 *  - summary     — MCP tool description string
 *  - input       — canonical zod schema (from command-schemas.ts; or inline for resume-task)
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
} from './command-schemas.js';
import {
  runCreateTask,
  runSendMessage,
  runAddAgent,
  runSetStatus,
  runCloseTask,
  runResumeTask,
  runDeleteTask,
} from './exec.js';
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
  | 'delete-task';

// ─── Minimal schema for resume-task (no canonical schema in command-schemas.ts) ─

const resumeTaskInputSchema = z.object({
  task_id: z.string().describe('The octomux task id'),
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
  { mcpName: 'pull_linear_issue', tier: 'auto' },
  { mcpName: 'search_learnings', tier: 'auto' },
  { cliSubcommand: 'recent-repos', tier: 'auto' },
  { cliSubcommand: 'default-branch', tier: 'auto' },
  { cliSubcommand: 'list-skills', tier: 'auto' },
  { cliSubcommand: 'get-skill', tier: 'auto' },
  { cliSubcommand: 'task-summary', tier: 'auto' },
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
