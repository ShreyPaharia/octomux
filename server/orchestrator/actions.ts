/**
 * server/orchestrator/actions.ts
 *
 * Orchestrator write-action dispatcher (SHR-142).
 *
 * The conductor takes write actions via typed MCP tools (`mcp__octomux__*`)
 * instead of gated `octomux` Bash commands. Each MCP write tool RPCs to the main
 * server (POST /api/hooks/orchestrator-action), which runs the action here —
 * reusing the same exec.ts executors the gate used — and pushes an **activity
 * update** to the conversation (a receipt, not an approval prompt).
 *
 * This runs IN THE MAIN SERVER PROCESS (not the MCP stdio subprocess) so the
 * task lifecycle (worktree/tmux) and the supervisor's event relay stay owned by
 * the main process. The MCP subprocess is a thin RPC client.
 *
 * No approval gate: actions execute immediately. Structured args mean there is
 * no Bash string to re-parse (the source of the create-task flag bugs).
 *
 * Validation is done via the canonical schemas in command-schemas.ts — the same
 * schemas that power the MCP tool inputSchemas and are tested by the CLI drift
 * test. Any field mismatch is caught at parse time, not at runtime worker launch.
 */

import { childLogger } from '../logger.js';
import { pushToConversation } from './stream.js';
import {
  runCreateTask,
  runSendMessage,
  runAddAgent,
  runSetStatus,
  runCloseTask,
  runResumeTask,
  runDeleteTask,
} from './exec.js';
import {
  createTaskInputSchema,
  sendMessageInputSchema,
  setStatusInputSchema,
  addAgentInputSchema,
  closeTaskInputSchema,
  deleteTaskInputSchema,
} from './command-schemas.js';
import type { WorkflowStatus } from '../types.js';

const logger = childLogger('orchestrator/actions');

export type OrchestratorAction =
  | 'create-task'
  | 'send-message'
  | 'add-agent'
  | 'set-status'
  | 'close-task'
  | 'resume-task'
  | 'delete-task';

export const ORCHESTRATOR_ACTIONS: ReadonlySet<string> = new Set<OrchestratorAction>([
  'create-task',
  'send-message',
  'add-agent',
  'set-status',
  'close-task',
  'resume-task',
  'delete-task',
]);

/** Push a concise activity update (receipt) for a completed action. */
function pushActivity(conversationId: string, text: string): void {
  pushToConversation(
    conversationId,
    JSON.stringify({ type: 'message', role: 'assistant', text: `✓ ${text}` }),
  );
}

/**
 * Run an orchestrator write action with structured input and report it to the
 * conversation. `conversationId` attaches the task to the conversation so the
 * supervisor relays its phase/error events (when absent, the action still runs
 * but isn't tracked — e.g. a non-conductor caller).
 *
 * Validation uses the canonical schemas from command-schemas.ts. Unknown extra
 * fields are stripped (zod .strip() default). Missing required fields throw.
 */
export async function runOrchestratorAction(
  conversationId: string | undefined,
  action: OrchestratorAction,
  input: Record<string, unknown>,
): Promise<unknown> {
  logger.info({ conversation_id: conversationId ?? null, action }, 'orchestrator action: run');

  switch (action) {
    case 'create-task': {
      // The conductor's MCP create_task tool sends the goal-oriented brief as
      // `description`. That brief IS the worker's prompt, so default
      // `initial_prompt` to the description when no explicit prompt is given —
      // otherwise the worker launches with NO prompt and does nothing. (runCreateTask
      // uses initial_prompt for the worker and description for display.)
      //
      // Apply the description→initial_prompt default BEFORE schema.parse so the
      // validator sees the resolved value.
      const withDefault = {
        ...input,
        initial_prompt:
          input['initial_prompt'] ??
          (typeof input['description'] === 'string' ? input['description'] : undefined),
      };
      // conversation_id is server-injected (not from the tool input).
      const parsed = createTaskInputSchema.parse(withDefault);
      const result = await runCreateTask({
        ...parsed,
        conversation_id: conversationId,
      });
      pushActivity(conversationId ?? '', `created task \`${result.task_id}\` — ${result.title}`);
      return result;
    }

    case 'send-message': {
      const parsed = sendMessageInputSchema.parse(input);
      await runSendMessage(parsed.task_id, parsed.message);
      if (conversationId)
        pushActivity(conversationId, `sent a message to task \`${parsed.task_id}\``);
      return { task_id: parsed.task_id };
    }

    case 'add-agent': {
      const parsed = addAgentInputSchema.parse(input);
      const { task_id, ...opts } = parsed;
      const result = await runAddAgent(task_id, opts);
      if (conversationId)
        pushActivity(conversationId, `added agent \`${result.agent_id}\` to task \`${task_id}\``);
      return result;
    }

    case 'set-status': {
      const parsed = setStatusInputSchema.parse(input);
      await runSetStatus(parsed.task_id, parsed.status as WorkflowStatus);
      if (conversationId)
        pushActivity(
          conversationId,
          `set task \`${parsed.task_id}\` status to \`${parsed.status}\``,
        );
      return { task_id: parsed.task_id, status: parsed.status };
    }

    case 'close-task': {
      const parsed = closeTaskInputSchema.parse(input);
      await runCloseTask(parsed.task_id);
      if (conversationId) pushActivity(conversationId, `closed task \`${parsed.task_id}\``);
      return { task_id: parsed.task_id };
    }

    case 'resume-task': {
      // resume-task is not exposed as an MCP tool (no schema), so accept task_id directly.
      const taskId = String(input['task_id'] ?? input['taskId'] ?? '');
      if (!taskId) throw new Error('resume-task requires task_id');
      await runResumeTask(taskId);
      if (conversationId) pushActivity(conversationId, `resumed task \`${taskId}\``);
      return { task_id: taskId };
    }

    case 'delete-task': {
      const parsed = deleteTaskInputSchema.parse(input);
      await runDeleteTask(parsed.task_id);
      if (conversationId) pushActivity(conversationId, `deleted task \`${parsed.task_id}\``);
      return { task_id: parsed.task_id };
    }

    default:
      throw new Error(`unknown orchestrator action: ${action as string}`);
  }
}
