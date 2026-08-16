/**
 * server/registry/types.ts
 *
 * Server-side capability type. The METADATA half — id, summary, projections,
 * tier, callers, input — lives in `@octomux/capabilities` so the CLI can build
 * its command tree without importing the server. `handler` is the only field
 * that needs server internals, so it stays here.
 *
 * Design doc: spec/surface-consolidation-and-centaur.md §5.1
 */

import type { CapabilityMeta, CallerClass, HttpMethod } from '@octomux/capabilities';

export type {
  CapabilityMeta,
  CallerClass,
  PolicyTier,
  HttpMethod,
  HttpProjection,
} from '@octomux/capabilities';

// ─── Capability ───────────────────────────────────────────────────────────────

export interface CapabilityContext {
  /** Who is invoking. Resolved per transport; defaults to 'agent'. */
  caller: CallerClass;
  /** Set when the caller is an agent working inside a task. */
  taskId?: string;
  /** Set for conductor-originated calls. */
  conversationId?: string;
}

export type Capability<TInput = unknown, TResult = unknown> = CapabilityMeta<TInput> & {
  handler: (input: TInput, ctx: CapabilityContext) => Promise<TResult> | TResult;
};

// ─── Out-of-registry declarations ─────────────────────────────────────────────
//
// Some routes cannot be capability rows without inventing a fake abstraction:
// streaming, wildcard paths, binary bodies, and inbound webhooks with
// harness-dictated response envelopes.
//
// They stay hand-written — but they must be DECLARED, so that "this route is
// not in the registry" is a test failure rather than a silent gap. Declaring
// them is what makes the surface complete rather than merely smaller.

export type ExemptionReason =
  /** SSE / WebSocket / chunked response. */
  | 'streaming'
  /** Express wildcard path (e.g. '/api/tasks/:id/diff/*path'). */
  | 'wildcard-path'
  /** Non-JSON request or response body. */
  | 'binary'
  /** Inbound hook whose response envelope is dictated by a harness. */
  | 'harness-webhook';

export interface RouteExemption {
  method: HttpMethod;
  path: string;
  reason: ExemptionReason;
  /** Why this genuinely cannot be a capability row. Required — no blank cheques. */
  justification: string;
}
