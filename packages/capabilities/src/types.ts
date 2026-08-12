/**
 * @octomux/capabilities — capability METADATA, shared by the server and the CLI.
 *
 * Why this package exists: the CLI is a thin HTTP client, but the CLI command
 * generator needs a capability's name, flags, schema and route. If that
 * metadata lived beside the handlers in `server/`, importing it from `cli/`
 * would drag in `db`, `task-engine` and `node-pty` — 113 TS6059 errors against
 * `cli/tsconfig.json`'s `rootDir: "src"`, and a CLI that depends on the whole
 * server to print `--help`.
 *
 * `handler` is the only field that needs server internals, so it stays behind
 * in `server/registry/types.ts`, which composes:
 *
 *   Capability = CapabilityMeta & { handler }
 *
 * Everything here must be importable by a browser or a thin CLI: zod and
 * plain types only, no filesystem, no database, no Node built-ins.
 */

import type { z } from 'zod';

// ─── Caller identity ──────────────────────────────────────────────────────────
//
// One capability row serves the dashboard, the CLI and MCP, so it must know who
// is calling: an agent invoking `task.create` should hit the `ask` tier, while a
// human clicking the same button should not.
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
  /**
   * Success status code. Defaults to 200.
   *
   * Required for behaviour preservation when a capability replaces a
   * hand-written route: the migrated routes answer 201 on create and 204 on
   * delete, and silently downgrading those to 200 would change the contract
   * for every existing client.
   *
   * 204 sends no body, per RFC 9110 — the handler's return value is discarded.
   */
  status?: number;
}

// ─── Capability metadata ──────────────────────────────────────────────────────

export interface CapabilityMeta<TInput = unknown> {
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
   * Baked into third-party prompts and configs outside this repo, so they are
   * never removed — only hidden from `--help`.
   */
  cliAliases?: string[];

  /**
   * MCP tool name, e.g. 'create_task'. Omit → not an MCP tool.
   * The narrowest projection: every tool costs context on every agent turn, so
   * this is set only where an agent genuinely needs it.
   */
  mcp?: string;

  /** Gate tier applied when `caller === 'agent'`. */
  tier: PolicyTier;

  /** Caller classes permitted to invoke this at all. */
  callers: CallerClass[];

  /** Canonical input schema. The one source for validation across transports. */
  input: z.ZodType<TInput>;
}
