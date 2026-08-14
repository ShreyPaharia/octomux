/**
 * server/orchestrator/mcp/write.ts
 *
 * MCP write-tool RPC client (SHR-142). The octomux MCP server runs as a stdio
 * subprocess of the conductor's `claude`; it cannot own the task lifecycle, so
 * each write tool RPCs to the main server's POST /api/hooks/orchestrator-action,
 * which runs the action and pushes an activity update. Structured args go over
 * the wire as JSON — no Bash, no gate, no string re-parsing.
 *
 * Config comes from env (set by the runner in the conductor's mcp-config):
 *   OCTOMUX_ACTION_BASE_URL  — e.g. http://127.0.0.1:7777
 *   OCTOMUX_ACTION_TOKEN     — the conductor's hook_token (authenticates the RPC)
 *   OCTOMUX_CONVERSATION_ID  — attaches the action to the conversation (tracking + cards)
 *
 * Writes are only exposed when base url + token are present (i.e. an
 * orchestrator-started session); a plain MCP session gets read tools only.
 *
 * Worker-mode report_complete (SHR-160):
 *   OCTOMUX_TASK_ID         — the worker's own task id (worker mode)
 *   OCTOMUX_ACTION_TOKEN    — the worker's hook_token (same env var, dual purpose)
 *   OCTOMUX_ACTION_BASE_URL — hookBaseUrl() (same env var, dual purpose)
 *
 * Worker writes are only exposed when OCTOMUX_TASK_ID is also set.
 */

import { createHash } from 'crypto';
import { childLogger } from '../../logger.js';

const logger = childLogger('orchestrator/mcp/write');

/**
 * Deterministic JSON with sorted object keys, so a given (action, input) always
 * hashes to the same idempotency key regardless of property order.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Idempotency key for a write action (SHR-163): a content hash of the action +
 * its input. A retried RPC after an ambiguous timeout sends the same key, so the
 * server replays the original result instead of double-executing.
 */
export function actionIdempotencyKey(action: string, input: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${action}:${stableStringify(input)}`)
    .digest('hex');
}

function actionConfig(): {
  baseUrl?: string;
  token?: string;
  conversationId?: string;
  taskId?: string;
} {
  return {
    baseUrl: process.env.OCTOMUX_ACTION_BASE_URL,
    token: process.env.OCTOMUX_ACTION_TOKEN,
    conversationId: process.env.OCTOMUX_CONVERSATION_ID,
    // Set for a worker session (OCTOMUX_TASK_ID), never for the conductor.
    // callGateCard sends it so the server can resolve conversation_id via
    // managed_tasks when OCTOMUX_CONVERSATION_ID isn't set — see its doc.
    taskId: process.env.OCTOMUX_TASK_ID,
  };
}

/** True when the write tools should be registered (orchestrator-started session). */
export function orchestratorWriteEnabled(): boolean {
  const { baseUrl, token } = actionConfig();
  // Must have base url + token, but must NOT be a worker session (worker has OCTOMUX_TASK_ID).
  // The worker gets report_complete instead (workerReportEnabled).
  return Boolean(baseUrl && token && !process.env.OCTOMUX_TASK_ID);
}

/**
 * True when the worker report_complete tool should be registered.
 * Requires all three worker env vars to be present.
 */
export function workerReportEnabled(): boolean {
  return Boolean(
    process.env.OCTOMUX_TASK_ID &&
    process.env.OCTOMUX_ACTION_TOKEN &&
    process.env.OCTOMUX_ACTION_BASE_URL,
  );
}

/** RPC a write action to the main server. Returns the action result. */
export async function callOrchestratorAction(
  action: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { baseUrl, token, conversationId } = actionConfig();
  if (!baseUrl || !token) {
    throw new Error('orchestrator write tools are not configured (missing base url / token)');
  }

  const idempotencyKey = actionIdempotencyKey(action, input);

  const url =
    `${baseUrl}/api/hooks/orchestrator-action` +
    `?token=${encodeURIComponent(token)}` +
    (conversationId ? `&conversation_id=${encodeURIComponent(conversationId)}` : '') +
    `&idempotency_key=${encodeURIComponent(idempotencyKey)}`;

  logger.debug(
    { action, conversation_id: conversationId ?? null, idempotency_key: idempotencyKey },
    'mcp write: RPC action',
  );

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, input }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: unknown;
    error?: string;
  };

  if (!res.ok || body.ok === false) {
    throw new Error(body.error ?? `orchestrator action '${action}' failed (HTTP ${res.status})`);
  }
  return body.result;
}

// ─── Gate card RPC (capability registry ask/always-ask gate) ────────────────

export interface CreateGateCardInput {
  /** Capability id, e.g. 'task.close' or 'owner.ask'. */
  capabilityId: string;
  tier: 'ask' | 'always-ask';
  /** 'action' → approve/reject an implied write. 'question' → free-text answer. */
  kind: 'action' | 'question';
  /** Display name for the card header (defaults to the capability's MCP tool name). */
  command: string;
  /** Displayed as editable-looking fields on an 'action' card. Omitted for 'question'. */
  args?: Record<string, unknown>;
  /** The question text for a 'question' card. Omitted for 'action'. */
  question?: string;
}

/**
 * RPC to the main server's POST /api/hooks/gate-card, creating a pending
 * action_cards row and pushing it to the conductor's conversation. Used by
 * `onGatedInvoke` (./gate.js) — CREATION must happen in the main process
 * because pushing the card to the browser needs the main process's live
 * WebSocket client registry (server/orchestrator/stream.ts's `convClients`),
 * which this stdio subprocess does not share. Once created, `onGatedInvoke`
 * polls the card's resolution straight off its OWN `getDb()` connection (WAL
 * mode makes that safe and cheap) rather than RPCing again.
 *
 * Throws on any failure (missing config, network error, non-ok response) —
 * the caller (`onGatedInvoke`) must treat that as a DISTINCT denial from the
 * owner rejecting or a timeout: the owner was never even asked.
 *
 * conversation_id resolution: the conductor always has OCTOMUX_CONVERSATION_ID
 * set and that wins when present. A worker session never has it (write.ts's
 * module doc) but does have OCTOMUX_TASK_ID, so this sends task_id instead and
 * lets the server resolve the OWNING conversation via `managed_tasks`
 * (server/hooks.ts's `/gate-card` — `findConversationForTask`). This is not a
 * fallback for locating a person — `managed_tasks` (task → conversation) IS
 * the routing table: a worker's question is addressed to the conductor
 * supervising it, and a human is however far up that chain the conductor
 * escalates to. That only resolves for an ORCHESTRATOR-MANAGED worker (it has
 * a `managed_tasks` row by definition — see the module doc on
 * `applyOrchestratorMcpConfig`, which is also why a worker with no
 * `managed_tasks` row never gets this MCP server wired up in the first place:
 * there is no case today where a worker reaches this call with neither id
 * resolvable). If somehow neither is available this throws locally rather
 * than round-tripping for a guaranteed failure.
 */
export async function callGateCard(input: CreateGateCardInput): Promise<{ card_id: string }> {
  const { baseUrl, token, conversationId, taskId } = actionConfig();
  if (!baseUrl || !token) {
    throw new Error('orchestrator write tools are not configured (missing base url / token)');
  }
  if (!conversationId && !taskId) {
    throw new Error('no conversation or task configured — no owner to route this question to');
  }

  const url =
    `${baseUrl}/api/hooks/gate-card` +
    `?token=${encodeURIComponent(token)}` +
    (conversationId ? `&conversation_id=${encodeURIComponent(conversationId)}` : '') +
    (taskId ? `&task_id=${encodeURIComponent(taskId)}` : '');

  logger.debug(
    { capability_id: input.capabilityId, tier: input.tier, kind: input.kind },
    'mcp write: RPC gate-card',
  );

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      capability_id: input.capabilityId,
      tier: input.tier,
      kind: input.kind,
      command: input.command,
      args: input.args,
      question: input.question,
    }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: { card_id?: string };
    error?: string;
  };

  if (!res.ok || body.ok === false || !body.result?.card_id) {
    throw new Error(body.error ?? `gate-card RPC failed (HTTP ${res.status})`);
  }
  return { card_id: body.result.card_id };
}

/**
 * RPC to the main server's phase-complete endpoint, signalling that this worker
 * has finished a phase. Mirrors callOrchestratorAction but targets the
 * /api/hooks/phase-complete endpoint authenticated by the worker's hook_token.
 *
 * Used exclusively by the report_complete MCP tool in worker mode.
 */
export async function callPhaseComplete(phase: string, artifacts?: string[]): Promise<void> {
  const baseUrl = process.env.OCTOMUX_ACTION_BASE_URL;
  const token = process.env.OCTOMUX_ACTION_TOKEN;
  const taskId = process.env.OCTOMUX_TASK_ID;

  if (!baseUrl || !token || !taskId) {
    throw new Error('worker report_complete is not configured (missing OCTOMUX_* env vars)');
  }

  const url = `${baseUrl}/api/hooks/phase-complete` + `?token=${encodeURIComponent(token)}`;

  logger.debug({ phase, task_id: taskId }, 'mcp write: worker callPhaseComplete');

  const body: Record<string, unknown> = { task_id: taskId, phase };
  if (artifacts !== undefined) body['artifacts'] = artifacts;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`phase-complete RPC failed (HTTP ${res.status}): ${text}`);
  }
}
