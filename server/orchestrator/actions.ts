/**
 * server/orchestrator/actions.ts
 *
 * Orchestrator write-action dispatcher (SHR-142, SHR-145).
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
 *
 * SHR-145: dispatch is now generated from COMMANDS (command-registry.ts); no
 * per-action switch. Adding a new action only requires a new CommandDef entry.
 */

import { childLogger } from '../logger.js';
import { pushToConversation } from './stream.js';
import { getActionResult, putActionResult } from './store.js';
import { COMMANDS, getCommandByAction } from './command-registry.js';
import type { OrchestratorAction } from './command-registry.js';

// Re-export OrchestratorAction so existing importers (gate.ts, api.ts, etc.)
// keep working without change. The canonical definition lives in command-registry.ts
// to avoid a circular dependency between this module and the registry.
export type { OrchestratorAction };

const logger = childLogger('orchestrator/actions');

/**
 * TTL for the action-idempotency cache (SHR-163). A retried RPC with the same
 * key within this window returns the original result instead of re-executing;
 * past it, an identical call is treated as a new intent. The window only needs
 * to cover an ambiguous-timeout retry, which happens within seconds — 10 minutes
 * is a generous bound. This also makes close-task/delete-task safe to retry
 * (same task_id → same key → cached result) without changing the executors.
 */
export const ACTION_IDEMPOTENCY_TTL_SECONDS = 10 * 60;

/** The full set of supported OrchestratorActions, derived from the registry. */
export const ORCHESTRATOR_ACTIONS: ReadonlySet<string> = new Set<OrchestratorAction>(
  COMMANDS.map((c) => c.action),
);

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
 * Validation uses the canonical schemas from command-schemas.ts (via the
 * command-registry). Unknown extra fields are stripped (zod .strip() default).
 * Missing required fields throw.
 *
 * Activity push semantics (preserved from pre-SHR-145):
 *  - create-task: always pushes, even when conversationId is undefined (uses "" fallback).
 *  - all other actions: push only when conversationId is set.
 */
export async function runOrchestratorAction(
  conversationId: string | undefined,
  action: OrchestratorAction,
  input: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<unknown> {
  logger.info(
    { conversation_id: conversationId ?? null, action, idempotency_key: idempotencyKey ?? null },
    'orchestrator action: run',
  );

  const cmd = getCommandByAction(action);
  if (!cmd) throw new Error(`unknown orchestrator action: ${action as string}`);

  // ── Idempotency: replay the original result for a retried RPC (SHR-163) ─────
  // An ambiguous HTTP timeout on the MCP write RPC could otherwise re-execute a
  // create-task and double-create a worktree/tmux/DB rows. The key is a content
  // hash of (action + input) computed by the MCP client, so a retry with the
  // same args hits the cache instead of re-running the handler.
  if (idempotencyKey) {
    const prior = getActionResult(idempotencyKey, ACTION_IDEMPOTENCY_TTL_SECONDS);
    if (prior) {
      logger.info(
        { conversation_id: conversationId ?? null, action, idempotency_key: idempotencyKey },
        'orchestrator action: idempotent replay — returning cached result (no re-execute)',
      );
      return JSON.parse(prior.result ?? 'null');
    }
  }

  // ── create-task: apply description→initial_prompt default before parse ──────
  // The conductor's MCP create_task tool sends the goal-oriented brief as
  // `description`. That brief IS the worker's prompt, so default
  // `initial_prompt` to the description when no explicit prompt is given —
  // otherwise the worker launches with NO prompt and does nothing. (runCreateTask
  // uses initial_prompt for the worker and description for display.)
  //
  // Apply BEFORE schema.parse so the validator sees the resolved value.
  const resolvedInput =
    action === 'create-task'
      ? {
          ...input,
          initial_prompt:
            input['initial_prompt'] ??
            (typeof input['description'] === 'string' ? input['description'] : undefined),
        }
      : input;

  const parsed = cmd.input.parse(resolvedInput);

  const { result, activity } = await cmd.handler(parsed, { conversationId });

  // Cache the successful result for idempotent replay (only on success — a
  // retry after a failure should re-attempt, not replay the error).
  if (idempotencyKey) {
    putActionResult(idempotencyKey, action, JSON.stringify(result ?? null));
  }

  if (activity) {
    // create-task: always push (even with no conversationId — use "" fallback).
    // All other actions: only push when conversationId is defined.
    if (action === 'create-task') {
      pushActivity(conversationId ?? '', activity);
    } else if (conversationId) {
      pushActivity(conversationId, activity);
    }
  }

  return result;
}
