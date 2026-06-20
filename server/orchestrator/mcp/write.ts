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
 */

import { childLogger } from '../../logger.js';

const logger = childLogger('orchestrator/mcp/write');

function actionConfig(): { baseUrl?: string; token?: string; conversationId?: string } {
  return {
    baseUrl: process.env.OCTOMUX_ACTION_BASE_URL,
    token: process.env.OCTOMUX_ACTION_TOKEN,
    conversationId: process.env.OCTOMUX_CONVERSATION_ID,
  };
}

/** True when the write tools should be registered (orchestrator-started session). */
export function orchestratorWriteEnabled(): boolean {
  const { baseUrl, token } = actionConfig();
  return Boolean(baseUrl && token);
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

  const url =
    `${baseUrl}/api/hooks/orchestrator-action` +
    `?token=${encodeURIComponent(token)}` +
    (conversationId ? `&conversation_id=${encodeURIComponent(conversationId)}` : '');

  logger.debug({ action, conversation_id: conversationId ?? null }, 'mcp write: RPC action');

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
