/**
 * server/registry/index.ts
 *
 * The capability registry. Capabilities are defined once here and projected
 * onto transports by the generators in `server/registry/projections/`.
 *
 * Design doc: docs/superpowers/specs/2026-08-12-surface-consolidation-and-centaur-design.md
 */

import { childLogger } from '../logger.js';
import type { Capability, CallerClass, PolicyTier, RouteExemption, HttpMethod } from './types.js';

export type {
  Capability,
  CallerClass,
  PolicyTier,
  RouteExemption,
  CapabilityContext,
  HttpMethod,
  HttpProjection,
  ExemptionReason,
} from './types.js';

const logger = childLogger('registry');

const capabilities = new Map<string, Capability>();
const exemptions: RouteExemption[] = [];

// ─── Definition ───────────────────────────────────────────────────────────────

/** Register a capability. Throws on duplicate id or duplicate projection name. */
export function defineCapability<TInput, TResult>(cap: Capability<TInput, TResult>): void {
  if (capabilities.has(cap.id)) {
    throw new Error(`duplicate capability id: ${cap.id}`);
  }
  for (const existing of capabilities.values()) {
    if (cap.mcp && existing.mcp === cap.mcp) {
      throw new Error(`duplicate MCP tool name '${cap.mcp}' (${existing.id} and ${cap.id})`);
    }
    if (cap.cli && existing.cli === cap.cli) {
      throw new Error(`duplicate CLI command '${cap.cli}' (${existing.id} and ${cap.id})`);
    }
    if (
      cap.http &&
      existing.http?.method === cap.http.method &&
      existing.http.path === cap.http.path
    ) {
      throw new Error(
        `duplicate route ${cap.http.method.toUpperCase()} ${cap.http.path} (${existing.id} and ${cap.id})`,
      );
    }
  }
  capabilities.set(cap.id, cap as Capability);
}

/**
 * Declare a route that deliberately stays hand-written. See `RouteExemption` —
 * declaring is what keeps the surface *complete* rather than merely smaller.
 */
export function exemptRoute(exemption: RouteExemption): void {
  exemptions.push(exemption);
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

export function getCapability(id: string): Capability | undefined {
  return capabilities.get(id);
}

export function listCapabilities(): Capability[] {
  return [...capabilities.values()];
}

export function listExemptions(): RouteExemption[] {
  return [...exemptions];
}

/** Capabilities carrying a given projection, for the generators. */
export function listHttpCapabilities(): Capability[] {
  return listCapabilities().filter((c) => c.http);
}

export function listCliCapabilities(): Capability[] {
  return listCapabilities().filter((c) => c.cli);
}

export function listMcpCapabilities(): Capability[] {
  return listCapabilities().filter((c) => c.mcp);
}

// ─── Authorization ────────────────────────────────────────────────────────────

export type Decision = { allowed: true; tier: PolicyTier } | { allowed: false; reason: string };

/**
 * Decide whether `caller` may invoke `cap`, and at what tier.
 *
 * The tier only applies to agents — a human in the UI or at a terminal has
 * already expressed intent by clicking or typing, so gating them would be
 * theatre. Agents get the declared tier; `auto` runs, anything else needs a
 * human decision from the caller's transport.
 */
/** Tier ordering, least to most restrictive. `resolveTier` never moves left. */
const TIER_RANK: Record<PolicyTier, number> = { auto: 0, ask: 1, 'always-ask': 2 };

/**
 * The tier for one specific invocation: the capability's declared tier, raised
 * if `tierFor` says this particular input is more dangerous than the default.
 *
 * RAISE-ONLY, deliberately. If `tierFor` could also lower the tier, a
 * capability could quietly opt itself out of the gate it declares, and the
 * declared tier would stop being the guarantee the registry's whole gating
 * story rests on. `Math.max` over the rank enforces that structurally rather
 * than by convention, so a `tierFor` that returns 'auto' for an 'always-ask'
 * capability is simply ignored instead of being trusted.
 */
export function resolveTier(cap: Capability, declared: PolicyTier, input: unknown): PolicyTier {
  if (!cap.tierFor) return declared;
  const requested = cap.tierFor(input);
  return TIER_RANK[requested] > TIER_RANK[declared] ? requested : declared;
}

export function authorize(cap: Capability, caller: CallerClass): Decision {
  if (!cap.callers.includes(caller)) {
    return { allowed: false, reason: `${cap.id} is not available to ${caller} callers` };
  }
  // 'worker' is gated exactly like 'agent' — both are autonomous Claude Code
  // sessions with no standing human intent behind the call. What keeps a
  // worker off task.create/task.delete/task.move is `cap.callers` (they don't
  // list 'worker'), not the tier collapsing here — see CallerClass's doc.
  const isAutonomous = caller === 'agent' || caller === 'worker';
  return { allowed: true, tier: isAutonomous ? cap.tier : 'auto' };
}

/**
 * Resolve caller class from request context.
 *
 * FAIL-CLOSED: anything unrecognised is an agent. A wrong `agent` verdict
 * costs an extra approval prompt; a wrong `ui` verdict ungates an autonomous
 * agent, which is the failure that matters.
 */
export function resolveCaller(opts: {
  /** True when the request carried a valid same-origin dashboard session. */
  isDashboard?: boolean;
  /** True when the request came from an interactive terminal (CLI, TTY attached). */
  isInteractiveCli?: boolean;
  /** True when the request arrived over an agent's MCP or hook-token path. */
  isAgentToken?: boolean;
}): CallerClass {
  if (opts.isAgentToken) return 'agent';
  if (opts.isDashboard) return 'ui';
  if (opts.isInteractiveCli) return 'human';
  return 'agent';
}

// ─── Test support ─────────────────────────────────────────────────────────────

/** Clear the registry. Tests only — never call from production code. */
export function resetRegistry(): void {
  capabilities.clear();
  exemptions.length = 0;
  logger.debug({ operation: 'resetRegistry' }, 'registry cleared');
}

/**
 * Every production route must either be a capability or a declared exemption.
 * Returns the routes that are neither — the drift test asserts this is empty.
 */
export function findUndeclaredRoutes(
  mounted: Array<{ method: HttpMethod; path: string }>,
): Array<{ method: HttpMethod; path: string }> {
  const known = new Set<string>();
  for (const cap of listHttpCapabilities()) {
    known.add(`${cap.http!.method} ${cap.http!.path}`);
  }
  for (const ex of exemptions) {
    known.add(`${ex.method} ${ex.path}`);
  }
  return mounted.filter((r) => !known.has(`${r.method} ${r.path}`));
}
