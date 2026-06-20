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
  type CreateTaskInput,
} from './exec.js';
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
 */
export async function runOrchestratorAction(
  conversationId: string | undefined,
  action: OrchestratorAction,
  input: Record<string, unknown>,
): Promise<unknown> {
  logger.info({ conversation_id: conversationId ?? null, action }, 'orchestrator action: run');

  const s = (k: string, ...alts: string[]): string | undefined => {
    for (const key of [k, ...alts]) {
      const v = input[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
  };
  const taskId = () => {
    const id = s('task_id', 'taskId', 'task');
    if (!id) throw new Error(`${action} requires task_id`);
    return id;
  };

  switch (action) {
    case 'create-task': {
      const result = await runCreateTask({
        ...(input as CreateTaskInput),
        // accept either repo_path or repoPath etc. — CreateTaskInput uses snake_case
        repo_path: s('repo_path', 'repoPath', 'repo'),
        base_branch: s('base_branch', 'baseBranch'),
        initial_prompt: s('initial_prompt', 'initialPrompt', 'prompt'),
        run_mode: (s('run_mode', 'runMode', 'mode') as CreateTaskInput['run_mode']) ?? 'new',
        conversation_id: conversationId,
      });
      pushActivity(conversationId ?? '', `created task \`${result.task_id}\` — ${result.title}`);
      return result;
    }
    case 'send-message': {
      const id = taskId();
      const message = s('message', 'text');
      if (!message) throw new Error('send-message requires message');
      await runSendMessage(id, message);
      if (conversationId) pushActivity(conversationId, `sent a message to task \`${id}\``);
      return { task_id: id };
    }
    case 'add-agent': {
      const id = taskId();
      const result = await runAddAgent(id, {
        prompt: s('prompt'),
        agent: s('agent') ?? null,
        label: s('label'),
        model: s('model') ?? null,
        skeleton: s('skeleton'),
      });
      if (conversationId)
        pushActivity(conversationId, `added agent \`${result.agent_id}\` to task \`${id}\``);
      return result;
    }
    case 'set-status': {
      const id = taskId();
      const status = s('status');
      if (!status) throw new Error('set-status requires status');
      await runSetStatus(id, status as WorkflowStatus);
      if (conversationId)
        pushActivity(conversationId, `set task \`${id}\` status to \`${status}\``);
      return { task_id: id, status };
    }
    case 'close-task': {
      const id = taskId();
      await runCloseTask(id);
      if (conversationId) pushActivity(conversationId, `closed task \`${id}\``);
      return { task_id: id };
    }
    case 'resume-task': {
      const id = taskId();
      await runResumeTask(id);
      if (conversationId) pushActivity(conversationId, `resumed task \`${id}\``);
      return { task_id: id };
    }
    case 'delete-task': {
      const id = taskId();
      await runDeleteTask(id);
      if (conversationId) pushActivity(conversationId, `deleted task \`${id}\``);
      return { task_id: id };
    }
    default:
      throw new Error(`unknown orchestrator action: ${action as string}`);
  }
}
