/**
 * server/orchestrator/gate.ts
 *
 * Bash PreToolUse deny-now gate (Task 3.2 / SHR-131).
 *
 * This module implements the two-sided gate mechanism (spec §5):
 *
 *   1. handlePreToolUse — called by the POST /api/hooks/pre-tool-use HTTP hook.
 *      Classifies the Bash(octomux ...) call via the policy engine and returns
 *      either an `allow` decision or a `deny` decision + creates a pending
 *      action_cards row + pushes a `card` ws event to the conversation.
 *
 *   2. executeCard — called when the user Approves, Edits, or Rejects a card
 *      in the UI. On Approve/Edit the backend runs the octomux operation
 *      server-side (via exec.ts) and pushes an injection note. On Reject it
 *      pushes a rejection note. The card.status is the sole authority.
 *
 *   3. rehydratePendingCards — returns all pending action_cards rows (called
 *      on backend boot so pending cards survive restarts).
 *
 * Fail-closed: deny is the default until the user explicitly approves.
 * Fail-open on backend restart: if the hook endpoint is unreachable, Claude Code
 * treats it as non_blocking_error and the Bash call runs. This is a documented
 * operational risk (Phase-0 finding § Spike 3); mitigated by 127.0.0.1 URL and
 * fast backend restarts.
 *
 * The response format for Claude Code's PreToolUse hook (Phase-0 verified):
 *   { hookSpecificOutput: { hookEventName: 'PreToolUse',
 *                           permissionDecision: 'allow' | 'deny',
 *                           permissionDecisionReason?: string } }
 *
 * Pointers-not-contents: the orchestrator never receives plan/diff body
 * contents — only command args that are pointers (task ids, paths).
 */

import { childLogger } from '../logger.js';
import { getDb } from '../db.js';
import { classify } from './policy.js';
import { createCard, getCard, resolveCard } from './store.js';
import type { ActionCard } from './store.js';
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

const logger = childLogger('orchestrator/gate');

// ─── Types ────────────────────────────────────────────────────────────────────

/** Input to handlePreToolUse. Mirrors the Claude Code PreToolUse hook payload. */
export interface PreToolUseInput {
  /** The orchestrator conversation that owns this hook call. May be absent if
   *  the conductor session hasn't been associated with a conversation yet —
   *  in that case we fail-open (allow) because we can't create a card. */
  conversation_id: string | undefined;
  /** Tool name from the hook payload (e.g. 'Bash', 'list_tasks'). */
  tool_name: string;
  /** Parsed tool input object (e.g. { command: 'octomux create-task ...' }). */
  tool_input: Record<string, unknown>;
  /** Claude's tool_use_id for this call — stored on the card for correlation. */
  tool_use_id: string;
}

/** Result returned by handlePreToolUse. */
export interface PreToolUseResult {
  /** 'allow' → let the command run; 'deny' → block it (card created). */
  decision: 'allow' | 'deny';
  /** Present when decision === 'deny'. The id of the newly-created action_cards row. */
  card_id?: string;
  /** Human-readable reason — included in the deny response payload sent to Claude. */
  reason?: string;
}

/** Input to executeCard. */
export interface ExecuteCardInput {
  card_id: string;
  /** 'approve' — run the command as-is.
   *  'edit'    — run the command with edited_input substituted for card.input.
   *  'reject'  — do not run; inject a rejection note.
   *  'respond' — inject a free-text follow-up turn (respond_text). */
  decision: 'approve' | 'edit' | 'reject' | 'respond';
  /** For 'edit': the user-adjusted command/args object to run instead. */
  edited_input?: Record<string, unknown>;
  /** For 'reject'/'respond': optional text to include in the injection note. */
  respond_text?: string;
}

// ─── Command parsing ──────────────────────────────────────────────────────────

/**
 * Extract the octomux subcommand and positional args from a Bash command string.
 *
 * For 'Bash' tool calls: tool_input.command is a shell string like
 *   "octomux create-task --title 'Fix bug'"
 * We extract the first word after 'octomux' as the subcommand, and pass the
 * rest as args to the policy classifier.
 *
 * For MCP-style tool calls (tool_name !== 'Bash'): the tool_name itself is the
 * command; args are derived from tool_input keys.
 */
function parseCommand(
  toolName: string,
  toolInput: Record<string, unknown>,
): { command: string; args: string[] } {
  if (toolName === 'Bash') {
    const raw = (toolInput['command'] as string | undefined) ?? '';
    const parts = raw.trim().split(/\s+/);
    // Parts: ['octomux', '<subcommand>', ...rest] or ['echo', ...] etc.
    if (parts[0] === 'octomux' && parts.length >= 2) {
      return { command: 'octomux', args: parts.slice(1) };
    }
    // Non-octomux Bash call: treat as generic command
    return { command: parts[0] ?? 'bash', args: parts.slice(1) };
  }

  // MCP or other tool: tool_name is the command, no subcommand args
  return { command: toolName, args: [] };
}

// ─── handlePreToolUse ─────────────────────────────────────────────────────────

/**
 * Classify a PreToolUse hook call and return an allow/deny decision.
 *
 * If denied, persists a pending action_cards row and pushes a `card` ws event
 * to the conversation so the user can approve/edit/reject/respond.
 *
 * Fail-open if conversation_id is absent (we can't create a card without it).
 */
export async function handlePreToolUse(input: PreToolUseInput): Promise<PreToolUseResult> {
  const { conversation_id, tool_name, tool_input, tool_use_id } = input;

  // Parse the command
  const { command, args } = parseCommand(tool_name, tool_input);

  logger.debug(
    { conversation_id: conversation_id ?? null, command, args, tool_use_id },
    'gate: handlePreToolUse',
  );

  // Classify using the policy engine
  const tier = classify(command, args);

  if (tier === 'auto') {
    logger.debug({ command, args, tier }, 'gate: auto-allow');
    return { decision: 'allow' };
  }

  // ask or always-ask → deny-now + create card
  // Fail-open if there's no conversation to attach the card to
  if (!conversation_id) {
    logger.warn(
      { command, args, tier },
      'gate: no conversation_id — failing open (card cannot be created)',
    );
    return { decision: 'allow' };
  }

  // Create the pending action card
  const cardId = createCard({
    conversation_id,
    tool_use_id,
    tool_name,
    input: JSON.stringify(tool_input),
  });

  logger.info(
    { conversation_id, command, args, tier, card_id: cardId, tool_use_id },
    'gate: denied + action card created',
  );

  // Push a card ws event to the conversation (UI renders it as an ActionCard)
  const cardEvent = JSON.stringify({
    type: 'card',
    id: cardId,
    command,
    args: { command: (tool_input['command'] as string | undefined) ?? '', ...tool_input },
    tier,
    tool_use_id,
  });
  pushToConversation(conversation_id, cardEvent);

  const reason = `queued for approval — card ${cardId}; you'll be notified when the user decides`;

  return { decision: 'deny', card_id: cardId, reason };
}

// ─── executeCard ──────────────────────────────────────────────────────────────

/**
 * Execute a card decision (Approve / Edit / Reject / Respond).
 *
 * - Approve: run the original command server-side + resolve to 'executed'.
 * - Edit: run with edited_input substituted + resolve to 'executed'.
 * - Reject: resolve to 'rejected'; push rejection note; nothing runs.
 * - Respond: inject respond_text as a follow-up message; resolve to 'rejected'.
 *
 * Idempotent: no-ops if the card is already resolved.
 */
export async function executeCard(input: ExecuteCardInput): Promise<void> {
  const { card_id, decision, edited_input, respond_text } = input;

  const card = getCard(card_id);
  if (!card) {
    logger.warn({ card_id }, 'gate.executeCard: card not found, no-op');
    return;
  }

  // Idempotency: already resolved → no-op
  if (card.status !== 'pending') {
    logger.info({ card_id, status: card.status }, 'gate.executeCard: card already resolved, no-op');
    return;
  }

  if (decision === 'reject') {
    resolveCard(card_id, 'rejected', null);
    const note = respond_text ? `rejected: ${respond_text}` : 'rejected by user';
    pushToConversation(
      card.conversation_id,
      JSON.stringify({
        type: 'message',
        role: 'system',
        text: `[Gate] ${note}`,
        id: card_id,
      }),
    );
    logger.info({ card_id }, 'gate.executeCard: card rejected');
    return;
  }

  if (decision === 'respond') {
    // Inject free-text follow-up as a message (not an execution)
    resolveCard(card_id, 'rejected', JSON.stringify({ note: respond_text ?? '' }));
    if (respond_text) {
      pushToConversation(
        card.conversation_id,
        JSON.stringify({ type: 'message', role: 'user', text: respond_text, id: card_id }),
      );
    }
    logger.info({ card_id }, 'gate.executeCard: card responded');
    return;
  }

  // Approve or Edit
  const effectiveInput: Record<string, unknown> = (() => {
    if (decision === 'edit' && edited_input) {
      return edited_input;
    }
    try {
      return JSON.parse(card.input) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  logger.info(
    { card_id, decision, conversation_id: card.conversation_id },
    'gate.executeCard: executing approved command',
  );

  let execResult: unknown;
  try {
    execResult = await runCardCommand(card, effectiveInput);
  } catch (err) {
    logger.error({ card_id, err }, 'gate.executeCard: command execution failed');
    const errMsg = (err as Error).message ?? String(err);
    resolveCard(card_id, 'executed', JSON.stringify({ error: errMsg }));
    pushToConversation(
      card.conversation_id,
      JSON.stringify({
        type: 'message',
        role: 'system',
        text: `[Gate] Command failed: ${errMsg}`,
        id: card_id,
      }),
    );
    return;
  }

  resolveCard(card_id, 'executed', JSON.stringify({ result: execResult ?? null }));

  const resultText = formatResult(card, execResult);
  pushToConversation(
    card.conversation_id,
    JSON.stringify({
      type: 'message',
      role: 'system',
      text: `[Gate] Approved — ${resultText}`,
      id: card_id,
    }),
  );

  logger.info({ card_id, conversation_id: card.conversation_id }, 'gate.executeCard: done');
}

// ─── rehydratePendingCards ────────────────────────────────────────────────────

/**
 * Return all pending action_cards rows across all conversations.
 *
 * Called on backend boot to surface cards that were created before a restart
 * but not yet decided by the user. The UI re-renders them from the DB; the
 * user can then approve/reject and the backend executes.
 */
export function rehydratePendingCards(): ActionCard[] {
  // listPendingCards is conversation-scoped; we need a global query here.
  return getDb()
    .prepare(`SELECT * FROM action_cards WHERE status = 'pending' ORDER BY created_at ASC`)
    .all() as ActionCard[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run the server-side equivalent of the octomux CLI command encoded in the card.
 *
 * We decode the Bash command string and dispatch to the appropriate exec.ts
 * function. Only the currently-implemented commands are handled; unknown
 * commands reject with an error so the card is marked failed rather than
 * silently no-op'ing.
 *
 * This avoids shelling out to the CLI (avoiding a subprocess just to call back
 * into the same backend) and keeps the gate fail-closed by construction.
 */
async function runCardCommand(
  card: ActionCard,
  effectiveInput: Record<string, unknown>,
): Promise<unknown> {
  const command = (effectiveInput['command'] as string | undefined) ?? '';
  const parts = command.trim().split(/\s+/);

  if (parts[0] !== 'octomux' || parts.length < 2) {
    // Non-octomux command — we don't execute arbitrary shell; reject.
    throw new Error(
      `gate: non-octomux command cannot be approved via the gate: "${command.slice(0, 80)}"`,
    );
  }

  const subcommand = parts[1];

  switch (subcommand) {
    case 'create-task': {
      // Parse CLI-style args into CreateTaskInput
      const args = parseCliArgs(parts.slice(2));
      return await runCreateTask({
        title: args['--title'] ?? args['-t'],
        description: args['--description'] ?? args['-d'],
        repo_path: args['--repo'] ?? args['-r'],
        branch: args['--branch'] ?? args['-b'],
        initial_prompt: args['--prompt'] ?? args['-p'],
        run_mode: (args['--mode'] as import('./exec.js').CreateTaskInput['run_mode']) ?? 'new',
        kind: args['--kind'],
        model: args['--model'],
        effort: args['--effort'],
        // Attach to the conversation so the supervisor can route events
        conversation_id: card.conversation_id,
      });
    }

    case 'send-message': {
      const args = parseCliArgs(parts.slice(2));
      const taskId = args['--task'] ?? args['-t'];
      const message = args['--text'] ?? args['-m'] ?? args['--message'];
      if (!taskId || !message) {
        throw new Error('gate: send-message requires --task and --text');
      }
      await runSendMessage(taskId, message);
      return { task_id: taskId };
    }

    case 'add-agent': {
      const args = parseCliArgs(parts.slice(2));
      const taskId = args['--task'] ?? args['-t'];
      if (!taskId) {
        throw new Error('gate: add-agent requires --task');
      }
      return await runAddAgent(taskId, {
        prompt: args['--prompt'] ?? args['-p'],
        agent: args['--agent'] ?? args['-a'] ?? null,
        label: args['--label'] ?? args['-l'],
        model: args['--model'],
        skeleton: args['--skeleton'],
      });
    }

    case 'set-status': {
      const args = parseCliArgs(parts.slice(2));
      const taskId = args['--task'] ?? args['-t'];
      const status = args['--status'] ?? args['-s'];
      if (!taskId || !status) {
        throw new Error('gate: set-status requires --task and --status');
      }
      await runSetStatus(taskId, status as import('../types.js').WorkflowStatus);
      return { task_id: taskId, status };
    }

    case 'close-task': {
      const args = parseCliArgs(parts.slice(2));
      const taskId = args['--task'] ?? args['-t'];
      if (!taskId) {
        throw new Error('gate: close-task requires --task');
      }
      await runCloseTask(taskId);
      return { task_id: taskId };
    }

    case 'resume-task': {
      const args = parseCliArgs(parts.slice(2));
      const taskId = args['--task'] ?? args['-t'];
      if (!taskId) {
        throw new Error('gate: resume-task requires --task');
      }
      await runResumeTask(taskId);
      return { task_id: taskId };
    }

    case 'delete-task': {
      const args = parseCliArgs(parts.slice(2));
      const taskId = args['--task'] ?? args['-t'];
      if (!taskId) {
        throw new Error('gate: delete-task requires --task');
      }
      await runDeleteTask(taskId);
      return { task_id: taskId };
    }

    default:
      throw new Error(`gate: subcommand '${subcommand}' is not yet wired in exec.ts`);
  }
}

/**
 * Parse a flat array of CLI-style flags into a key→value map.
 * Handles:
 *   --key value   (space-separated)
 *   --key=value   (equals-sign)
 *   'quoted value with spaces' is NOT handled here — the command string has
 *   already been split on whitespace. This is intentionally simple because the
 *   orchestrator produces structured tool_input, not arbitrary shell strings;
 *   the Bash command encoding is a transport, not a shell to be parsed fully.
 */
function parseCliArgs(parts: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  let i = 0;
  while (i < parts.length) {
    const part = parts[i]!;
    if (part.startsWith('--') || (part.startsWith('-') && part.length === 2)) {
      // Check for --key=value
      const eqIdx = part.indexOf('=');
      if (eqIdx !== -1) {
        result[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
        i++;
      } else if (i + 1 < parts.length && !parts[i + 1]!.startsWith('-')) {
        result[part] = parts[i + 1]!;
        i += 2;
      } else {
        result[part] = 'true';
        i++;
      }
    } else {
      i++;
    }
  }
  return result;
}

/** Format a human-readable result note for injection into the conversation. */
function formatResult(card: ActionCard, result: unknown): string {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (r['agent_id'])
      return `added agent \`${String(r['agent_id'])}\` to task \`${String(r['task_id'] ?? '')}\``;
    if (r['task_id'] && r['title']) return `created task \`${String(r['task_id'])}\``;
    if (r['task_id'] && r['status'])
      return `set task \`${String(r['task_id'])}\` status to \`${String(r['status'])}\``;
    if (r['task_id']) return `task \`${String(r['task_id'])}\` updated`;
  }

  let input: Record<string, unknown>;
  try {
    input = JSON.parse(card.input) as Record<string, unknown>;
  } catch {
    input = {};
  }
  const command = (input['command'] as string | undefined) ?? card.tool_name;
  return `executed \`${command.slice(0, 60)}\``;
}
