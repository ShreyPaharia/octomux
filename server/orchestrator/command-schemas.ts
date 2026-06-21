/**
 * server/orchestrator/command-schemas.ts
 *
 * SINGLE SOURCE OF TRUTH for orchestrator command inputs (SHR-144).
 *
 * The CLI (commander options), MCP tool inputSchemas, and the executor
 * (exec.ts functions) all derive from these canonical zod schemas.
 * Drift between them now fails the CLI drift test rather than silently
 * breaking workers at runtime.
 *
 * Field names use snake_case to match the executor's parameter names.
 * The CLI maps kebab-case flags → camelCase → snake_case (see drift test).
 *
 * Orchestrator-only extensions (not surfaced on the CLI):
 *   kind, effort, conversation_id
 *
 * CLI-only flags (not in the schema because the server never sees them):
 *   --draft         (translated to a truthy draft field on the REST body, not the exec input)
 *   --harness       (translated to harness_id on the REST body)
 *   --fork-from     (resolved to base_branch before the REST call)
 */

import { z } from 'zod';

// ─── create_task ──────────────────────────────────────────────────────────────

export const createTaskInputSchema = z.object({
  /** Short task title. */
  title: z.string().describe('Short task title (< 60 chars)'),
  /**
   * Goal-oriented brief (WHAT/WHY + acceptance criteria).
   * Required by the CLI and the MCP conductor tool. Optional at the executor
   * level -- runCreateTask falls back to initial_prompt when omitted.
   */
  description: z.string().optional().describe('Task description / goal-oriented brief'),
  /** Absolute path to the git repository (required for new/none modes). */
  repo_path: z.string().optional().describe('Absolute path to the git repository'),
  /** Initial prompt sent as the first agent message. Defaults to description. */
  initial_prompt: z.string().optional().describe('Initial prompt for the agent'),
  /** Branch name for new mode. */
  branch: z.string().optional().describe('Branch name (new mode only; auto-generated if omitted)'),
  /** Base branch to fork from (new mode only). */
  base_branch: z.string().optional().describe('Base branch (default: main)'),
  /**
   * Run mode for the task.
   * 'new'      — create a new worktree + branch (default)
   * 'existing' — attach to an existing worktree
   * 'none'     — no worktree; bare repo only
   * 'scratch'  — no repo at all
   */
  run_mode: z
    .enum(['new', 'existing', 'none', 'scratch'])
    .optional()
    .describe('Run mode: new | existing | none | scratch (default: new)'),
  /** Existing worktree path (required for run_mode=existing). */
  worktree_path: z
    .string()
    .optional()
    .describe('Existing worktree path (required for existing mode)'),
  /** Per-task model override (e.g. claude-opus-4-8, claude-sonnet-4-6). */
  model: z.string().optional().nullable().describe('Per-task model override'),
  /** Task ID to notify when this task finishes. */
  notify_task: z.string().optional().describe('Task ID to notify when this task finishes'),
  // ── Orchestrator-only extensions (not on the CLI) ─────────────────────────
  /**
   * Workflow kind:
   * 'plan'      → plan first for review, then implement
   * 'implement' → implement directly
   * 'workflow'  → spec→plan→implement with review gates
   * Omit for small/clear work (implements directly).
   */
  kind: z
    .enum(['plan', 'implement', 'workflow'])
    .optional()
    .describe(
      '"workflow" → spec→plan→implement; "plan" → plan first then implement; omit for direct',
    ),
  /** Effort hint for model right-sizing (low | medium | high | xhigh | max). */
  effort: z.string().optional().describe('Effort hint (low | medium | high | xhigh | max)'),
  /** Orchestrator conversation that owns this task. Injected by the server. */
  conversation_id: z.string().optional().describe('Orchestrator conversation id (server-injected)'),
});

export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

// ─── send_message ─────────────────────────────────────────────────────────────

export const sendMessageInputSchema = z.object({
  /** The octomux task id. */
  task_id: z.string().describe('The octomux task id'),
  /** The message to deliver to the agent. */
  message: z.string().describe('The message to deliver'),
});

export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

// ─── set_status ───────────────────────────────────────────────────────────────

export const setStatusInputSchema = z.object({
  /** The octomux task id. */
  task_id: z.string().describe('The octomux task id'),
  /** New workflow status. */
  status: z
    .string()
    .describe('New workflow status (backlog | planned | in_progress | human_review | pr | done)'),
});

export type SetStatusInput = z.infer<typeof setStatusInputSchema>;

// ─── add_agent ────────────────────────────────────────────────────────────────

/**
 * Agent-specific options for adding an agent (without task_id).
 * Used as the executor's parameter type (task_id is passed separately).
 */
export const addAgentOptsSchema = z.object({
  /** Initial prompt for the new agent. */
  prompt: z.string().optional().describe('Initial prompt for the new agent'),
  /** Label for the new agent window. */
  label: z.string().optional().describe('Label for the new agent'),
  /** Per-agent model override. */
  model: z.string().optional().nullable().describe('Per-agent model override'),
  /** Role skeleton name to load from <repo>/.octomux/agents/<name>.md. */
  skeleton: z.string().optional().describe('Role skeleton name'),
  /** Agent type / persona name. */
  agent: z.string().optional().nullable().describe('Agent type (e.g. code-reviewer)'),
});

export type AddAgentOpts = z.infer<typeof addAgentOptsSchema>;

/**
 * Full add_agent input schema including task_id — used as the MCP tool's
 * inputSchema. The executor takes task_id separately and receives AddAgentOpts.
 */
export const addAgentInputSchema = addAgentOptsSchema.extend({
  /** The octomux task id. */
  task_id: z.string().describe('The octomux task id'),
});

export type AddAgentInput = z.infer<typeof addAgentInputSchema>;

// ─── close_task ───────────────────────────────────────────────────────────────

export const closeTaskInputSchema = z.object({
  /** The octomux task id. */
  task_id: z.string().describe('The octomux task id'),
});

export type CloseTaskInput = z.infer<typeof closeTaskInputSchema>;

// ─── delete_task ──────────────────────────────────────────────────────────────

export const deleteTaskInputSchema = z.object({
  /** The octomux task id. */
  task_id: z.string().describe('The octomux task id'),
});

export type DeleteTaskInput = z.infer<typeof deleteTaskInputSchema>;
