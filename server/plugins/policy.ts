/**
 * `ctx.policy` — the gate between "a run wants to start" and "a run starts".
 *
 * Every other plugin registrar is additive. This one can refuse. A hook returns
 * `{ deny: reason }` to stop the intent, `{ patch: {...} }` to rewrite it, or
 * nothing at all. Hooks for a point run in registration order; the first deny
 * short-circuits and later hooks never run; a patch is merged into `data` and
 * the next hook sees it.
 *
 * ## Fail open, loudly
 *
 * A hook that throws, or that outruns `POLICY_HOOK_TIMEOUT_MS`, is logged and
 * treated as "no opinion". A crashing spend-cap plugin must not wedge every
 * launch in the install. That is a deliberate trade: this layer exists to
 * coordinate and to leave an audit trail, not to be a security boundary — a
 * plugin runs in-process and can bypass it entirely by calling what core calls.
 * Do not read a policy deny as containment.
 *
 * ## The record
 *
 * A deny or a patch on a task-scoped intent is written twice: a
 * `core:policy.decision` record (machine-readable audit, `ctx.records`) and a
 * `task_updates` row of kind `policy` (what a human sees in the task's Activity
 * panel). Recording is best-effort — a failed write is logged and never
 * propagates, because the decision itself already happened.
 */
import type { PolicyDecision, PolicyHook, PolicyIntent, PolicyPoint } from '@octomux/plugin-api';
import { childLogger } from '../logger.js';
import { publishCoreRecord } from './records.js';
import { addTaskUpdate } from '../repositories/tasks.js';

const logger = childLogger('plugins/policy');

export const POLICY_HOOK_TIMEOUT_MS = 5000;

interface HookEntry {
  pluginId: string;
  hook: PolicyHook;
}

/** point -> hooks registered for it, in registration order. A point with no
 *  live hooks has no entry at all (never an empty array) so the fast path in
 *  `evaluatePolicy` is a single `Map.get` + falsy check. */
const hooksByPoint = new Map<PolicyPoint, HookEntry[]>();

/** Registers a hook. Called by `ctx.policy.intercept` AFTER the grant check. */
export function registerPolicyHook(pluginId: string, point: PolicyPoint, hook: PolicyHook): void {
  let entries = hooksByPoint.get(point);
  if (!entries) {
    entries = [];
    hooksByPoint.set(point, entries);
  }
  entries.push({ pluginId, hook });
}

/** Drops every hook a plugin registered. Called on unmount. Returns the count. */
export function unregisterPluginPolicy(pluginId: string): number {
  let removed = 0;
  for (const [point, entries] of hooksByPoint) {
    const kept = entries.filter((entry) => entry.pluginId !== pluginId);
    removed += entries.length - kept.length;
    if (kept.length === 0) {
      hooksByPoint.delete(point);
    } else {
      hooksByPoint.set(point, kept);
    }
  }
  return removed;
}

/** Registered hook count per plugin id, for the load report / doctor. */
export function policyHookCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entries of hooksByPoint.values()) {
    for (const { pluginId } of entries) {
      counts[pluginId] = (counts[pluginId] ?? 0) + 1;
    }
  }
  return counts;
}

export interface PolicyEvaluation {
  taskId?: string;
  repoPath?: string;
  data: Record<string, unknown>;
}

export type PolicyOutcome =
  | { allowed: true; data: Record<string, unknown> }
  | { allowed: false; reason: string; pluginId: string };

/**
 * Runs the waterfall for `point`.
 *
 * FAST PATH: no hooks registered for the point -> returns `{ allowed: true }`
 * with `intent.data` untouched, no DB access and no logging. `task.launch` is
 * on the hot path of every task creation; an install with no policy plugin must
 * pay nothing for this existing.
 */
export async function evaluatePolicy(
  point: PolicyPoint,
  intent: PolicyEvaluation,
): Promise<PolicyOutcome> {
  const entries = hooksByPoint.get(point);
  if (!entries || entries.length === 0) {
    return { allowed: true, data: intent.data };
  }

  let data = intent.data;
  for (const { pluginId, hook } of entries) {
    const hookIntent: PolicyIntent = {
      point,
      taskId: intent.taskId,
      repoPath: intent.repoPath,
      data,
    };

    let decision: PolicyDecision;
    try {
      decision = await callHookWithTimeout(hook, hookIntent);
    } catch (err) {
      // Fail open: a crashing or hung hook is logged and treated as "no
      // opinion", never as a deny or an allow-through-patch. This layer
      // coordinates and audits — it does not contain a plugin, so a broken
      // hook must not be able to wedge every launch in the install.
      logger.warn(
        { plugin_id: pluginId, point, err },
        'policy hook failed; treating as no opinion',
      );
      continue;
    }

    if (decision == null) continue;

    if (isDenyDecision(decision)) {
      const reason =
        typeof decision.deny === 'string' && decision.deny.trim().length > 0
          ? decision.deny
          : `plugin "${pluginId}" denied ${point} without giving a reason`;
      logger.info({ task_id: intent.taskId, point, plugin_id: pluginId, reason }, 'policy denied');
      await recordDecision(intent.taskId, point, pluginId, { decision: 'deny', reason });
      return { allowed: false, reason, pluginId };
    }

    if (isPatchDecision(decision)) {
      data = { ...data, ...decision.patch };
      await recordDecision(intent.taskId, point, pluginId, {
        decision: 'patch',
        patch: decision.patch,
      });
    }
    // Anything else (junk that names neither `deny` nor a usable `patch`) is
    // no opinion — fall through to the next hook untouched.
  }

  return { allowed: true, data };
}

/** Races a hook against `POLICY_HOOK_TIMEOUT_MS`. A synchronous throw is
 *  funneled through the same rejection path as an async one via the
 *  `Promise.resolve().then()` wrapper, so the caller has one failure mode
 *  to handle, not two. */
function callHookWithTimeout(hook: PolicyHook, intent: PolicyIntent): Promise<PolicyDecision> {
  const hookPromise = Promise.resolve().then(() => hook(intent));
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    setTimeout(
      () => reject(new Error(`policy hook exceeded ${POLICY_HOOK_TIMEOUT_MS}ms`)),
      POLICY_HOOK_TIMEOUT_MS,
    );
  });
  return Promise.race([hookPromise, timeoutPromise]);
}

function isDenyDecision(decision: unknown): decision is { deny: unknown } {
  return typeof decision === 'object' && decision !== null && 'deny' in decision;
}

function isPatchDecision(decision: unknown): decision is { patch: Record<string, unknown> } {
  if (typeof decision !== 'object' || decision === null || !('patch' in decision)) return false;
  const patch = (decision as { patch: unknown }).patch;
  return typeof patch === 'object' && patch !== null;
}

type DecisionDetail =
  | { decision: 'deny'; reason: string }
  | { decision: 'patch'; patch: Record<string, unknown> };

/** Writes the `core:policy.decision` record and the `policy` task-update row
 *  for a task-scoped deny/patch. No-ops (nothing to record against) when the
 *  intent carries no `taskId` — records and task updates are both
 *  task-scoped. Each write is independently best-effort: a failed audit
 *  write is logged and never propagates, because the actual policy decision
 *  already happened and must not be reversed by a broken log statement. */
async function recordDecision(
  taskId: string | undefined,
  point: PolicyPoint,
  pluginId: string,
  detail: DecisionDetail,
): Promise<void> {
  if (!taskId) return;

  try {
    publishCoreRecord('core:policy.decision', taskId, { point, pluginId, ...detail });
  } catch (err) {
    logger.warn(
      { task_id: taskId, point, plugin_id: pluginId, err },
      'failed to record policy decision record',
    );
  }

  const body =
    detail.decision === 'deny'
      ? `Policy denied ${point}: plugin "${pluginId}" — ${detail.reason}`
      : `Policy patched ${point}: plugin "${pluginId}" adjusted ${Object.keys(detail.patch).join(', ')}`;

  try {
    addTaskUpdate({ task_id: taskId, kind: 'policy', body });
  } catch (err) {
    logger.warn(
      { task_id: taskId, point, plugin_id: pluginId, err },
      'failed to record policy task update',
    );
  }
}

/**
 * `evaluatePolicy` + throw on deny. For the call sites whose surrounding
 * try/catch already surfaces an error correctly (`startTask` and `resumeTask`
 * write `tasks.error`; `publishReview` propagates to HTTP). Returns the
 * possibly-patched data on allow.
 */
export async function enforcePolicy(
  point: PolicyPoint,
  intent: PolicyEvaluation,
): Promise<Record<string, unknown>> {
  const outcome = await evaluatePolicy(point, intent);
  if (!outcome.allowed) {
    throw new Error(`policy denied ${point}: plugin "${outcome.pluginId}" — ${outcome.reason}`);
  }
  return outcome.data;
}

/** Test-only: clears every registered hook. */
export function resetPolicy(): void {
  hooksByPoint.clear();
}
