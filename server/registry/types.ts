/**
 * server/registry/types.ts
 *
 * The capability registry: one definition per capability, projected onto every
 * transport that needs it (HTTP route, CLI subcommand, MCP tool, gate tier).
 *
 * Supersedes `server/orchestrator/command-registry.ts`, which defines 7
 * capabilities but only generates 2 of the 4 surfaces it touches — CLI
 * commander definitions and REST routes are hand-written and merely
 * drift-tested against it.
 *
 * Design doc: docs/superpowers/specs/2026-08-12-surface-consolidation-and-centaur-design.md
 */

import type { z } from 'zod';

// ─── Caller identity ──────────────────────────────────────────────────────────
//
// The load-bearing new concept. One capability row now serves the dashboard,
// the CLI, and MCP. The row must know who is calling, because an agent invoking
// `task.create` should hit the `ask` tier while a human clicking the same
// button in the UI should not.
//
// FAIL-CLOSED: an unidentified caller is treated as `agent`. Getting this
// backwards either gates the UI into uselessness or ungates agents entirely.

export type CallerClass =
  /** The React dashboard, same-origin. Trusted — the human is already present. */
  | 'ui'
  /** A human at a terminal running `octomux ...`. Trusted. */
  | 'human'
  /** An autonomous agent, via MCP or CLI. Subject to the gate tier. */
  | 'agent';

/** Gate classification. Mirrors `orchestrator/policy.ts` tiers. */
export type PolicyTier =
  /** Runs without asking. Reads, and writes with no blast radius. */
  | 'auto'
  /** Asks a human, but the answer is promotable to `auto` via permission_rules. */
  | 'ask'
  /** Always asks. Never promotable — destructive or irreversible. */
  | 'always-ask';

// ─── Transport projections ────────────────────────────────────────────────────

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface HttpProjection {
  method: HttpMethod;
  /** Express path, e.g. '/api/tasks/:id'. */
  path: string;
}

// ─── Capability ───────────────────────────────────────────────────────────────

export interface CapabilityContext {
  /** Who is invoking. Resolved per transport; defaults to 'agent'. */
  caller: CallerClass;
  /** Set when the caller is an agent working inside a task. */
  taskId?: string;
  /** Set for conductor-originated calls. */
  conversationId?: string;
}

export interface Capability<TInput = unknown, TResult = unknown> {
  /**
   * Canonical id, `noun.verb`. The single name this capability is known by;
   * every projection derives its own name from here or overrides explicitly.
   */
  id: string;

  /** One-line description. Becomes the MCP tool description and CLI help text. */
  summary: string;

  /** HTTP projection. Omit for capabilities with no REST surface. */
  http?: HttpProjection;

  /**
   * CLI projection, e.g. 'task create'. Omit → not a CLI command.
   * Deliberately narrower than `http`: not every route deserves a subcommand.
   */
  cli?: string;

  /**
   * Legacy flat CLI names kept as permanent hidden aliases (e.g. 'create-task').
   * These are baked into third-party prompts and configs outside this repo, so
   * they never get removed — only hidden from `--help`.
   */
  cliAliases?: string[];

  /**
   * MCP tool name, e.g. 'create_task'. Omit → not an MCP tool.
   * Deliberately the narrowest projection: every tool costs context on every
   * agent turn, so this is set only where an agent genuinely needs it.
   */
  mcp?: string;

  /** Gate tier applied when `caller === 'agent'`. */
  tier: PolicyTier;

  /** Caller classes permitted to invoke this at all. */
  callers: CallerClass[];

  /** Canonical input schema. The one source for validation across transports. */
  input: z.ZodType<TInput>;

  handler: (input: TInput, ctx: CapabilityContext) => Promise<TResult> | TResult;
}

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
