/**
 * server/orchestrator/mcp/gate.ts
 *
 * `onGatedInvoke` — makes the capability registry's `ask`/`always-ask` tiers
 * actually block, instead of running immediately (the gap this module closes).
 *
 * Runs INSIDE the MCP stdio subprocess (server/orchestrator/mcp/server.ts),
 * so it cannot await an in-memory promise held by the main Express process.
 * Split accordingly:
 *  - CREATE the card over HTTP RPC (`callGateCard`, ./write.ts) — the main
 *    process owns the live WebSocket clients (stream.ts's `convClients`) that
 *    actually push the card to the browser; this subprocess has none.
 *  - POLL the card's resolution directly off this subprocess's OWN `getDb()`
 *    connection to the same SQLite file (WAL mode makes that safe and cheap —
 *    no RPC needed just to read a row).
 *
 * FAIL CLOSED — the whole point of this module. Three distinct outcomes, and
 * `cap.handler` runs in exactly one of them:
 *   1. card created, human approves  → resolves (undefined, or {answer} for
 *      ask_human) → the caller (registerOne in projections/mcp.ts) proceeds.
 *   2. card created, human rejects, OR the wait times out → THROWS. Rejection
 *      and timeout get distinct messages (never conflated — a caller reading
 *      the error can tell "no" from "nobody answered").
 *   3. card creation itself fails (server restart, bad token, network) →
 *      THROWS a message naming the RPC failure, distinct from #2 — the human
 *      was never even asked, which is a different failure than being told no.
 * None of the three ever lets `cap.handler` run silently — unlike the Bash
 * PreToolUse gate's hook-error catch (server/hooks.ts's `/pre-tool-use`
 * route), which deliberately fails OPEN on an unexpected error so the
 * conductor never wedges on a transport hiccup. That tradeoff is wrong here:
 * `always-ask` exists specifically for destructive/irreversible actions, so a
 * gate error must deny, never allow.
 */

import { childLogger } from '../../logger.js';
import { getCard } from '../../repositories/orchestrator.js';
import { listPermissionRulesByToolName } from '../../repositories/orchestrator.js';
import { findFirstActiveAgent, setAgentHookActivity } from '../../repositories/workers.js';
import { approvalTimeoutMs } from '../approval-timeout.js';
import { capabilityToolName } from '../policy.js';
import { getStoredCapabilityGateEnabled } from '../../settings.js';
import { callGateCard } from './write.js';
import type { Capability, PolicyTier } from '../../registry/types.js';

const logger = childLogger('orchestrator/mcp/gate');

/** How often the subprocess re-reads the card row while waiting. */
export const POLL_INTERVAL_MS = 1000;

/**
 * Grace window added on top of the configured approval timeout before this
 * subprocess gives up client-side. The durable, restart-safe source of truth
 * for "this card has timed out" is the main process's periodic sweep
 * (server/orchestrator/approval-timeout.ts's `sweepExpiredApprovalCards`,
 * poller-driven — see server/poller/index.ts), which flips the row to
 * 'auto_rejected'; this grace period exists only so that sweep — which acts on
 * the SAME `action_cards` table our new cards land in, unmodified — has a
 * realistic chance to have run before this belt-and-suspenders local deadline
 * fires too. Either one alone is sufficient to guarantee "never hang forever".
 */
export const POLL_GRACE_MS = 10_000;

// ─── Kill switch ──────────────────────────────────────────────────────────────

/**
 * KILL SWITCH for this gate. Default ON (gating enabled). Env var wins over
 * the stored setting, mirroring `approvalTimeoutMs()`'s own env-over-settings
 * pattern.
 *
 *   OCTOMUX_CAPABILITY_GATE_ENABLED=false  → every ask/always-ask capability
 *   call runs immediately, no card, no human decision — the pre-this-change
 *   behaviour. Anything other than the literal strings 'false'/'0' counts as
 *   enabled, matching the truthy-string convention other OCTOMUX_* toggles in
 *   this codebase use.
 */
export function capabilityGateEnabled(): boolean {
  const raw = process.env.OCTOMUX_CAPABILITY_GATE_ENABLED;
  if (raw !== undefined) return raw !== 'false' && raw !== '0';
  const stored = getStoredCapabilityGateEnabled();
  if (stored !== undefined) return stored;
  return true;
}

// ─── Rule promotion check (read side) ────────────────────────────────────────

/**
 * True when a blanket allow-rule already promotes this capability to auto.
 * Only ever consulted for `tier === 'ask'` — see `onGatedInvoke` below.
 * `always-ask` capabilities never reach this check, so no rule — however it
 * got there — can ever silence one. That is the property under test.
 */
function isPromoted(capabilityId: string): boolean {
  return listPermissionRulesByToolName(capabilityToolName(capabilityId)).some(
    (r) => r.match === null,
  );
}

// ─── Best-effort monitor-grid signal ──────────────────────────────────────────

/**
 * Resolve a task id from a capability's input, if the shape has one
 * (task.start/move use `id`, task.close uses `task_id`; task.create and
 * human.ask have neither). Best-effort only — used purely to flip a worker's
 * hook_activity so the monitor grid shows "blocked on human"; never affects
 * the gate decision.
 */
function resolveTaskIdForActivity(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const id = obj.task_id ?? obj.id;
  return typeof id === 'string' && id ? id : undefined;
}

/**
 * Best-effort: flip the task's first active worker's hook_activity so the
 * monitor grid (GridMonitor.tsx, which renders `task.workers[].hook_activity`)
 * shows this task as blocked on a human — same signal
 * `POST /api/hooks/permission-request` sets for a worker's own permission
 * prompts (server/hooks.ts). A plain DB write (no live-client push needed —
 * the grid polls REST every 5s), so unlike card creation this is safe to do
 * directly from the subprocess. Swallows all errors: never let a monitor
 * cosmetic affect the gate's fail-closed guarantee.
 */
function bestEffortSetActivity(input: unknown, activity: 'waiting' | 'active'): void {
  try {
    const taskId = resolveTaskIdForActivity(input);
    if (!taskId) return;
    const agent = findFirstActiveAgent(taskId);
    if (!agent) return;
    setAgentHookActivity(agent.id, activity);
  } catch (err) {
    logger.debug({ err }, 'gate: best-effort hook_activity update failed (non-fatal)');
  }
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

type CardOutcome =
  | { kind: 'approved'; answer: string | null }
  | { kind: 'rejected' }
  | { kind: 'timeout' };

/**
 * Poll `action_cards` (direct DB read — see module doc) until the card leaves
 * 'pending', or our local deadline passes. Resolves, never rejects — the
 * caller (`onGatedInvoke`) turns the outcome into a throw for the deny cases.
 */
function waitForCardDecision(cardId: string): Promise<CardOutcome> {
  const deadline = Date.now() + approvalTimeoutMs() + POLL_GRACE_MS;

  return new Promise<CardOutcome>((resolve) => {
    const tick = () => {
      const card = getCard(cardId);
      if (!card) {
        // Should be unreachable (we just created it) — fail closed regardless.
        logger.warn({ card_id: cardId }, 'gate: card vanished while waiting — denying');
        resolve({ kind: 'rejected' });
        return;
      }

      if (card.status === 'pending') {
        if (Date.now() >= deadline) {
          resolve({ kind: 'timeout' });
          return;
        }
        setTimeout(tick, POLL_INTERVAL_MS);
        return;
      }

      if (card.status === 'auto_rejected') {
        resolve({ kind: 'timeout' });
        return;
      }
      if (card.status === 'rejected') {
        resolve({ kind: 'rejected' });
        return;
      }

      // 'approved' (capability cards) / 'executed' / 'edited' (legacy
      // statuses this card type never actually produces, kept here so an
      // unexpected value fails toward "approved, no answer" rather than
      // hanging) all read as approved.
      let answer: string | null = null;
      try {
        const parsed = card.result ? (JSON.parse(card.result) as { answer?: string }) : null;
        answer = parsed?.answer ?? null;
      } catch {
        answer = null;
      }
      resolve({ kind: 'approved', answer });
    };

    tick();
  });
}

// ─── onGatedInvoke ────────────────────────────────────────────────────────────

/**
 * The `onGatedInvoke` hook wired into `registerCapabilityMcpTools` by
 * server/orchestrator/mcp/server.ts. See the module doc for the fail-closed
 * contract and `projections/mcp.ts`'s doc on `onGatedInvoke` for the
 * undefined-vs-value return-value protocol.
 */
export async function onGatedInvoke(
  cap: Capability,
  tier: PolicyTier,
  input: unknown,
): Promise<unknown> {
  if (!capabilityGateEnabled()) {
    logger.debug({ capability: cap.id }, 'gate: capability gate disabled — bypassing');
    return undefined;
  }

  // Rule promotion: 'ask' tier ONLY. always-ask never even reaches this
  // check, so it can never be silenced by a rule — see isPromoted's doc.
  if (tier === 'ask' && isPromoted(cap.id)) {
    logger.debug({ capability: cap.id }, 'gate: promoted by an allow-rule — bypassing');
    return undefined;
  }

  const isQuestion = cap.mcp === 'ask_human';
  const questionText = isQuestion
    ? (input as { question?: string } | undefined)?.question
    : undefined;
  const command = cap.mcp ?? cap.id;

  let cardId: string;
  try {
    const created = await callGateCard({
      capabilityId: cap.id,
      tier: tier as 'ask' | 'always-ask',
      kind: isQuestion ? 'question' : 'action',
      command,
      args: isQuestion ? undefined : (input as Record<string, unknown>),
      question: questionText,
    });
    cardId = created.card_id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // DISTINCT from rejection/timeout below: the human was never even asked.
    throw new Error(`gate: could not create an approval card for '${cap.id}' — ${message}`);
  }

  bestEffortSetActivity(input, 'waiting');
  const outcome = await waitForCardDecision(cardId);
  bestEffortSetActivity(input, 'active');

  if (outcome.kind === 'timeout') {
    throw new Error(
      `gate: '${cap.id}' timed out waiting for a human decision (card ${cardId}) — denied`,
    );
  }
  if (outcome.kind === 'rejected') {
    throw new Error(`gate: '${cap.id}' was rejected by the human (card ${cardId})`);
  }

  // approved
  if (isQuestion) {
    return { answer: outcome.answer };
  }
  return undefined; // fall through to cap.handler
}
