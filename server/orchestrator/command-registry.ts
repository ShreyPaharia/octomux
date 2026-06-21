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
  /**
   * Execute the action. Receives the parsed input and the server-injected context.
   * Returns the result and optionally the activity receipt text.
   */
  handler: (parsedInput: z.infer<S>, ctx: CommandContext) => Promise<CommandResult>;
}

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
    async handler(parsed, _ctx) {
      await runDeleteTask(parsed.task_id);
      const result = { task_id: parsed.task_id };
      const activity = `deleted task \`${parsed.task_id}\``;
      return { result, activity };
    },
  },
];

// ─── Lookup helpers ───────────────────────────────────────────────────────────

/**
 * Look up a CommandDef by its OrchestratorAction.
 * Returns undefined when no matching def is found.
 */
export function getCommandByAction(action: OrchestratorAction): CommandDef | undefined {
  return COMMANDS.find((c) => c.action === action);
}
