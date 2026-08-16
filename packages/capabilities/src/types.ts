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
  | 'agent'
  /**
   * A task worker's Claude Code session (as opposed to the orchestrator
   * conductor, which is `'agent'`). Both are autonomous and both are subject
   * to the gate tier — `authorize()` treats `'worker'` exactly like `'agent'`
   * for tier resolution — but a worker's REACH is narrower: it is the
   * `callers` list on each capability, not the tier, that keeps a worker off
   * `task.create`/`task.delete`/`task.move` while still letting it read
   * (`task.list`/`task.get`), close its own task (`task.close`), and block on
   * a human (`owner.ask`). Introduced so a worker can reach `ask_owner`
   * without widening what a worker can destroy — see
   * spec/surface-consolidation-and-centaur.md's centaur section.
   */
  | 'worker';

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

  /**
   * Extra gate the HTTP projection must enforce BEFORE resolving a caller or
   * running the handler. Omit for the routes the generic caller-class check
   * (`authorize()`) already covers correctly.
   *
   * A closed union of known mechanisms, not a function — this package must
   * stay importable by a browser and a thin CLI (no filesystem, no Node
   * built-ins, no server internals; see the module doc above), so it cannot
   * hold actual middleware. `server/registry/projections/http.ts`'s
   * `mountCapabilities` is what turns this flag into the real
   * `requireBearerHookToken` middleware (`server/routes/hook-auth.ts`) —
   * this field only says WHICH mechanism to apply, never HOW.
   *
   * 'bearer-hook-token': reject with 401 any request whose
   * `Authorization: Bearer <token>` header is missing or does not match a
   * live agent's `hook_token`. Exists because `authorize()`'s caller-class
   * check is not an authentication check: an unrecognised request fails
   * closed to the `'agent'` caller class (see `CallerClass` below), so a
   * capability whose `callers` includes `'agent'` — every route this flag is
   * for — would otherwise authorize a request that never proved it was an
   * agent at all. This flag is what makes "no token" fail before that
   * fallback ever gets consulted.
   */
  auth?: 'bearer-hook-token';
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
   * Input field → env var supplying the CLI flag's default when it is omitted.
   * A field defaulted this way stops being a `requiredOption` whenever the env
   * var is set, so the flag becomes optional exactly where the answer is known.
   *
   * Opt-in per capability, never global. Every agent launched into a task has
   * `OCTOMUX_TASK_ID` in its env (task-engine/launch.ts), which is what lets
   * `octomux task rename --title "…"` target the task the agent is already
   * running in — the same trick `octomux learn` / `recall` / `emit` use. It is
   * deliberately NOT applied to `task.delete` or `task.close`: guessing which
   * task a destructive verb meant is how you delete the wrong one.
   */
  cliEnvDefaults?: Record<string, string>;

  /**
   * MCP tool name, e.g. 'create_task'. Omit → not an MCP tool.
   * The narrowest projection: every tool costs context on every agent turn, so
   * this is set only where an agent genuinely needs it.
   */
  mcp?: string;

  /** Gate tier applied when `caller === 'agent'`. */
  tier: PolicyTier;

  /**
   * Raises the tier for a specific invocation, when how dangerous the call is
   * depends on its INPUT rather than on the capability.
   *
   * `task.delete` is the motivating case: by default it soft-deletes (a
   * `deleted_at` stamp, undone by the restore route), but `purge: true` kills
   * the tmux session, removes the worktree, deletes the branch and drops the
   * rows. One static tier cannot describe both — pick `ask` and a stored
   * permission rule can silently promote an irreversible purge to `auto`; pick
   * `always-ask` and every routine delete blocks a human.
   *
   * Resolved per call, and may only ever RAISE the tier — see `resolveTier`.
   * A capability cannot use this to gate itself less than it declares.
   */
  tierFor?: (input: unknown) => PolicyTier;

  /** Caller classes permitted to invoke this at all. */
  callers: CallerClass[];

  /** Canonical input schema. The one source for validation across transports. */
  input: z.ZodType<TInput>;
}
