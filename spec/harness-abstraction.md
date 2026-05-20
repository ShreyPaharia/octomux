# Harness abstraction

Design for supporting multiple AI coding "harnesses" (Claude Code, Cursor CLI,
future others) in octomux. Written 2026-05-08.

## Goals

- Adding a new harness is a localised change — one new file in
  `server/harnesses/`, one small frontend panel, two registry entries.
- Custom skills authored once are visible from any harness that supports them.
  (Already true between Claude Code and Cursor CLI: `cursor-agent`'s binary
  references `.claude/skills/` directly, so they cross-share for free.)
- Custom agent definitions (`.md` with frontmatter) stay in their existing
  canonical location and are translated to per-harness layouts at worktree
  setup time when the target harness needs a different shape.
- End state: each agent inside a task can run under a different harness; for
  example Agent 1 = Claude, Agent 2 = Cursor in the same worktree.
- The refactor is delivered in **independent steps**. Step 1 is a near-pure
  refactor (see "Behavior changes in step 1" for the small exceptions).

## Non-goals

- Provider/model abstraction. We are abstracting the _CLI harness_ (binary +
  config conventions + hook protocol), not the underlying LLM. Model choice
  inside Claude or Cursor remains that harness's concern.
- Plugin auto-discovery. The registry is an explicit typed map. We can evolve
  toward auto-discovery later, but two harnesses do not justify it now.
- Schema-driven settings UI. Each harness ships a small typed React panel.
- A new web-facing public API for installing harnesses at runtime.

## End state (step 3)

```
┌─ task ────────────────────────────────────────────┐
│ harness_id: 'claude-code'  (task's default)       │
│                                                   │
│  ┌─ agent 1 (window 0) ─┐  ┌─ agent 2 (window 1) ┐│
│  │ harness_id: claude-code │  harness_id: cursor  ││
│  │ session: <uuid>         │  session: <chat-id>  ││
│  └─────────────────────┘  └─────────────────────┘ │
└───────────────────────────────────────────────────┘
```

Both harnesses run inside the same tmux session, isolated to one window each.
Hooks from either harness call back to octomux's existing `/hooks/*` HTTP
endpoints. The permission-prompt inbox shows prompts from either, tagged with
the originating harness.

## Staged delivery

| Step | Scope                                                           | DB? | UI? | Adds harness?         |
| ---- | --------------------------------------------------------------- | --- | --- | --------------------- |
| 1    | Refactor: interface + Claude impl behind it + security baseline | Yes | No  | No                    |
| 2a   | Cursor harness (backend + bridge + `/api/harnesses` endpoint)   | No  | No  | Cursor (API/CLI only) |
| 2b   | Harness dropdown + settings panel in create-task / create-chat  | No  | Yes | Cursor in UI          |
| 3    | Per-agent harness in add-agent dialog + inbox badge             | No  | Yes | No                    |

Step 1 is the only step with a DB migration. Steps 2a/2b/3 are additive on
the schema and security baseline that step 1 establishes.

## Behavior changes in step 1

Step 1 is _not_ a strict no-op. Document them so they don't surprise anyone:

- **Settings file shape on disk changes.** Users who have hand-edited
  `~/.octomux/settings.json` will see legacy top-level keys
  (`claudeFlags`, `dangerouslySkipPermissions`) rewritten under
  `harnesses['claude-code']` on first save after upgrade.
- **Log fields rename.** Structured-log field `claude_session_id` becomes
  `harness_session_id`. Anyone with a log alert keyed on the old name should
  update before deploying.
- **New error class.** `getHarness('unknown')` throws when a DB row has an
  unrecognised `harness_id`. The setup `try/catch` in `task-runner.ts`
  catches it and marks the task errored.
- **Input validation tightens** (security baseline — see "Security model"):
  agent names get a regex check; flag strings reject shell metacharacters
  beyond just backticks/`$(`; `OCTOMUX_CLAUDE_FLAGS` env is validated.
  Existing valid configs are unaffected; obviously-malicious values that
  silently worked before now fail loudly at task creation.
- **Hook endpoint hardening.** Server binds to `127.0.0.1`; `/api/hooks/*`
  routes require a per-task token via `X-Octomux-Hook-Token` header; CORS is
  denied for hook routes. Existing Claude hooks continue to work because the
  token is written into the worktree's `.claude/settings.local.json` (URLs
  become `http://127.0.0.1:<port>/api/hooks/<event>?token=<task-token>` or
  equivalent header-bearing form, whichever Claude's HTTP hook config
  supports).

## Step 1 — Architecture

New module layout:

```
server/harnesses/
  types.ts          interface Harness, HarnessLaunchOpts, validation helpers
  registry.ts       HARNESSES map, getHarness(id), listHarnesses(), DEFAULT_HARNESS_ID
  claude-code.ts    the only impl in step 1
  index.ts          re-exports
```

Touched call sites become harness-agnostic:

- `task-runner.ts` / `chats.ts` — every literal `claude --session-id ...`
  invocation goes through `harness.buildLaunchCommand(...)` /
  `buildResumeCommand` / `buildContinueCommand`. The renamed helper
  `sendHarnessCommand` (formerly `sendClaudeCommand`) is otherwise unchanged.
  Both call sites are rewritten — the chats.ts site was missed in earlier
  drafts.
- `hook-settings.ts` — body moves into `claude-code.ts::installHooks`. A new
  exported `hookBaseUrl()` helper (returning `http://127.0.0.1:<port>`)
  replaces the private `hookPort()`. All harnesses receive the base URL via
  parameter — no harness reads `process.env.PORT` directly.
- `agents.ts::syncAgents` — becomes a thin shim that delegates to the
  harness. Claude impl keeps current behavior (writes canonical `.md` files
  into `.claude/agents/`). `createTask` calls `syncAgents` unconditionally;
  harnesses that don't support custom agents implement it as a no-op.
- `hooks.ts` — lookup changes from `claude_session_id = ?` to
  `harness_session_id = ?`. Adds token verification on every hook route.
- `settings.ts` — per-harness sub-object plus deprecated-key fallback (see
  "Settings shape & migration"). New `validateSettings` dispatched per
  harness on save _and_ on read (for registered harnesses only — unknown
  harness blobs are preserved verbatim but never read).
- `index.ts` — `server.listen()` binds to `127.0.0.1` explicitly; CORS
  middleware denies origins for `/api/hooks/*`.

Step 1 does NOT change:

- Hook HTTP endpoint _payloads_ (`server/hooks.ts` request/response shapes).
  Auth is added; semantics are unchanged.
- Skill code (`server/skills.ts`). Skills are already canonical; both Claude
  Code and Cursor CLI read `~/.claude/skills/`.
- The Express API surface (no new routes in step 1).
- The frontend.

## Harness interface

```ts
// server/harnesses/types.ts

export interface HarnessLaunchOpts {
  /**
   * For 'orchestrator-assigned' mode: the real session id passed to the
   * harness (e.g. via --session-id). For 'harness-issued' mode: callers
   * should pass an empty string or ignore; the harness will issue its own.
   */
  sessionId: string;
  /** Custom agent name; null launches without --agent. */
  agent?: string | null;
  /** Already-resolved per-harness flags (leading space or ''). */
  flags?: string;
}

export interface HarnessResumeOpts {
  sessionId: string;
  flags?: string;
}

export interface Harness {
  /** Stable id used in DB rows and settings keys. */
  readonly id: string;
  /** Human-readable label for the harness picker UI (added in step 2b). */
  readonly displayName: string;

  /**
   * How session ids are managed by this harness.
   *  - 'orchestrator-assigned': octomux generates the id via newSessionId()
   *    and passes it to the harness via a launch flag (e.g. Claude's
   *    `--session-id <uuid>`). Caller inserts the row with the id populated.
   *  - 'harness-issued': the harness emits its own id in an event/output
   *    stream. Caller MUST insert the row with `harness_session_id = NULL`
   *    and update it on the first hook event that carries a real id. The
   *    placeholder from newSessionId() is for internal correlation only and
   *    MUST NOT be written into the DB column.
   *
   * Step 1 has only orchestrator-assigned (Claude). The field exists so the
   * schema decision (nullable `harness_session_id`) reads as intentional.
   */
  readonly sessionIdMode: 'orchestrator-assigned' | 'harness-issued';

  /** Generate a session id. See sessionIdMode for storage semantics. */
  newSessionId(): string;

  /** Build the shell command that launches a fresh session in a tmux pane. */
  buildLaunchCommand(opts: HarnessLaunchOpts): string;

  /** Resume an existing session in a new tmux pane (by id). */
  buildResumeCommand(opts: HarnessResumeOpts): string;

  /**
   * Fallback when resume is unavailable (e.g. expired session). Starts with a
   * fresh id but preserves local context where the harness supports it.
   * Returns `null` if the harness has no continue equivalent; callers
   * (`moveAgentToTask`) fall back to launch and log a warn.
   */
  buildContinueCommand(opts: HarnessResumeOpts): string | null;

  /**
   * Write any harness-specific config into the worktree so hooks call back
   * to octomux's HTTP endpoints. Receives the local octomux base URL
   * (`http://127.0.0.1:<port>`) and a per-task hook token.
   * Claude impl writes `.claude/settings.local.json` with HTTP-typed hooks
   * carrying the token as a query string or header.
   * Future Cursor impl will write a script-bridge stub config (see step 2a).
   */
  installHooks(worktreePath: string, baseUrl: string, hookToken: string): Promise<void>;

  /**
   * Translate canonical agent definitions (frontmatter `.md`) into the
   * on-disk format the harness expects, written into the worktree. Claude
   * impl writes `.claude/agents/`. Harnesses without custom-agent support
   * implement this as a no-op. Callers invoke this unconditionally — there
   * is no capability gate at call sites in step 1.
   */
  syncAgents(worktreePath: string): Promise<void>;

  /**
   * Resolve flag string from per-harness settings. Returns a string with a
   * leading space or '', so callers can concatenate directly. MUST validate
   * the input and throw on shell-metacharacter injection (see "Security
   * model").
   */
  resolveFlags(settings: OctomuxSettings): string;

  /**
   * Validate this harness's settings sub-object and return the normalized
   * form. Called on every save AND lazily on read for registered harnesses
   * (unknown-harness blobs are preserved but never validated). Throws on
   * invalid input; the error message is surfaced to the API caller.
   */
  validateSettings(blob: unknown): Record<string, unknown>;

  /**
   * Validate a custom agent name passed via task.agent / body.agent. Returns
   * the normalized name or throws. Default implementation in
   * `validateAgentName()` enforces `/^[A-Za-z0-9_-]{1,64}$/`; harnesses may
   * override for stricter rules.
   */
  validateAgentName(name: string): string;
}
```

`capabilities` and `settingsFields` deliberately do NOT appear in the step-1
interface. They're added in step 2a (when Cursor needs the first
non-trivial capability flag) and step 2b (when the settings UI needs to
render per-harness panels), respectively. Adding them speculatively against
one impl risks the second impl forcing a different shape.

### Registry

```ts
// server/harnesses/registry.ts
import { claudeCodeHarness } from './claude-code.js';
import type { Harness } from './types.js';

const HARNESSES = new Map<string, Harness>([[claudeCodeHarness.id, claudeCodeHarness]]);

export const DEFAULT_HARNESS_ID = claudeCodeHarness.id;

export function getHarness(id: string | null | undefined): Harness {
  const key = id ?? DEFAULT_HARNESS_ID;
  const h = HARNESSES.get(key);
  if (!h) throw new Error(`Unknown harness: ${key}`);
  return h;
}

export function listHarnesses(): Harness[] {
  return Array.from(HARNESSES.values());
}
```

### Claude Code implementation

`server/harnesses/claude-code.ts` exports a single object implementing
`Harness`. `sessionIdMode: 'orchestrator-assigned'`. Behavior is a 1:1 port
of existing code paths from `task-runner.ts`, `hook-settings.ts`, and
`agents.ts`. No new logic except the security tightening (see below).

```ts
export const claudeCodeHarness: Harness = {
  id: 'claude-code',
  displayName: 'Claude Code',
  sessionIdMode: 'orchestrator-assigned',

  newSessionId: () => crypto.randomUUID(),

  buildLaunchCommand: ({ sessionId, agent, flags = '' }) => {
    const a = agent ? ` --agent ${validateAgentName(agent)}` : '';
    return `claude${a} --session-id ${sessionId}${flags}`;
  },

  buildResumeCommand: ({ sessionId, flags = '' }) => `claude --resume ${sessionId}${flags}`,

  buildContinueCommand: ({ sessionId, flags = '' }) =>
    `claude --continue --session-id ${sessionId}${flags}`,

  installHooks: async (worktreePath, baseUrl, hookToken) => {
    /* moved from server/hook-settings.ts; URLs include hookToken */
  },

  syncAgents: async (worktreePath) => {
    /* moved from server/agents.ts (current behavior) */
  },

  resolveFlags: (settings) => {
    /* moved from server/settings.ts::resolveClaudeFlags, with tightened
       validation applied to both settings value and OCTOMUX_CLAUDE_FLAGS env */
  },

  validateSettings: (blob) => {
    /* validates harnesses['claude-code'] = { flags, dangerouslySkipPermissions } */
  },

  validateAgentName: (name) => validateAgentName(name),
};
```

## Database schema (step 1)

Migrations (one `addColumn`-style step, following the existing pattern in
`server/db.ts`):

```sql
ALTER TABLE tasks  ADD COLUMN harness_id TEXT NOT NULL DEFAULT 'claude-code';
ALTER TABLE agents ADD COLUMN harness_id TEXT NOT NULL DEFAULT 'claude-code';

-- The bundled SQLite is 3.49+ (via better-sqlite3 11.x), which supports
-- ALTER TABLE ... RENAME COLUMN since 3.25. Use it instead of a table
-- rebuild; rebuild was rejected because it adds FK-pragma footguns and
-- index recreation hazards for no benefit on a pure rename.
ALTER TABLE agents RENAME COLUMN claude_session_id TO harness_session_id;

DROP INDEX IF EXISTS idx_agents_claude_session_id;
CREATE INDEX IF NOT EXISTS idx_agents_harness_session_id
  ON agents(harness_session_id);

-- permission_prompts.session_id is NOT NULL today (server/db.ts:104).
-- Step 2 (Cursor, harness-issued sessions) can produce prompts before the
-- session id is bound to the agent row, which violates NOT NULL. Resolve in
-- step 1 by relaxing the constraint — cheapest fix, no behavior change.
-- (The column is otherwise redundant with agent_id; we keep it for now
-- because hooks.ts queries it and removing it is a wider refactor.)
ALTER TABLE permission_prompts RENAME TO permission_prompts_old;
CREATE TABLE permission_prompts (
  /* ...identical columns except session_id is nullable... */
);
INSERT INTO permission_prompts SELECT * FROM permission_prompts_old;
DROP TABLE permission_prompts_old;
```

Each migration is idempotent: it runs only if the corresponding column is
absent or the rename hasn't been applied. The existing `addColumn` helper in
`server/db.ts` already gates on column presence; we'll add an analogous
`renameColumn` gate that checks for the new name's absence.

Updated type shapes:

```ts
// server/types.ts
export interface Task {
  /* ...existing fields... */
  harness_id: string;
}

export interface Agent {
  /* ...existing fields... */
  harness_id: string;
  harness_session_id: string | null; // formerly claude_session_id
  /** Per-agent token used to authenticate hook callbacks. */
  hook_token: string;
}
```

`agents.hook_token` is added in the same migration (`ALTER TABLE agents ADD
COLUMN hook_token TEXT NOT NULL DEFAULT ''` — backfill is empty; existing
agents must have tokens minted on next read — see "Security model"). Token
lives on `agents` rather than `tasks` so standalone chat agents
(`task_id = NULL`) get the same authentication path without a special case.

**Migration tests** (in `server/db.test.ts`):

- Insert a pre-migration `agents` row with old `claude_session_id`; run
  migration; assert `harness_session_id` populated, `harness_id =
'claude-code'`, index `idx_agents_harness_session_id` exists.
- **Idempotency:** run migration twice; second run is a no-op.
- **Pre-existing non-default value:** insert a row, run migration, set
  `harness_id = 'cursor'`, run migration again; value survives.
- `permission_prompts` row with non-null `session_id` survives the table
  rebuild with the same value.

Downgrade (old binary against post-migration DB) is explicitly **not
supported**. Document in spec, recommend DB backup before upgrade.

## Settings shape & migration

```ts
export interface OctomuxSettings {
  editor: EditorChoice;
  defaultHarnessId: string;
  harnesses: Record<string, Record<string, unknown>>;

  /** @deprecated read-only fallback; promoted into harnesses['claude-code'] on next save */
  claudeFlags?: string;
  /** @deprecated */
  dangerouslySkipPermissions?: boolean;
}
```

`getSettings()`:

1. Reads the file.
2. Lazily promotes deprecated top-level keys into
   `harnesses['claude-code']` (in-memory).
3. For each _registered_ harness key in `harnesses`, calls
   `harness.validateSettings(blob)`; if it throws, the offending key is
   dropped in-memory with a `logger.warn`. (Unknown-harness blobs are
   skipped — preserved verbatim on save.)
4. If deprecated keys were present on read, emits a one-time `logger.warn`
   per process: "Deprecated settings keys promoted; they will be removed
   from the file on next save."

`updateSettings()`:

1. Validates the patch through `validateSettings` for each modified
   registered harness.
2. Writes the cleaned shape, stripping the deprecated top-level keys.
3. Preserves unknown-harness blobs verbatim.

Settings files containing harness keys for harnesses not registered in the
current build are preserved verbatim — they must not be dropped on save, so
users who downgrade temporarily don't lose config. Per-harness validation
runs only when the harness is registered, so a poisoned blob for an
inactive harness is dormant.

## Security model

This section is the result of pulling several latent gaps in the existing
code into the open. Step 1 establishes the security baseline that step 2's
script bridge depends on.

**Command injection.** Every value interpolated into a shell command must be
validated by the harness:

- `agent`: regex `/^[A-Za-z0-9_-]{1,64}$/` via the default
  `validateAgentName`. Applied at API boundary (api.ts) AND at command
  construction time (defense in depth).
- `flags`: existing `validateClaudeFlags` is widened to reject `;`, `|`,
  `&`, `>`, `<`, `\n`, `\r`, in addition to backticks and `$(`. The same
  rules apply to `OCTOMUX_CLAUDE_FLAGS` env (currently bypasses
  validation in `settings.ts:93`).
- `sessionId` for orchestrator-assigned mode: must be a UUID (regex check
  on generation; never accepted from user input).

**Prompt file race.** The current `.claude-prompt-<agent-id>` write uses
default flags. Tighten to `fs.writeFileSync(path, content, { mode: 0o600,
flag: 'wx' })` — owner-only, fail-if-exists, fail-if-symlink. Document in
spec: "Worktrees on shared filesystems (NFS, SMB, sshfs, Dropbox/iCloud) are
unsupported. Octomux makes no guarantees about prompt confidentiality if
`<worktree>` is not on a local single-user filesystem."

**Hook endpoint auth (NEW in step 1).** Today `/api/hooks/*` routes find the
agent by session id (predictable: visible in `ps`, in `tmux` scrollback,
and in `~/.claude/settings.local.json`). Any local process can replay. Step 1
adds:

- **Per-agent hook token.** 32 random bytes
  (`crypto.randomBytes(32).toString('hex')`) minted on agent creation,
  stored in `agents.hook_token`. Each registered harness includes the
  token in the hook config it writes into the worktree (Claude: URL query
  param or header; future Cursor: env var passed via send-keys, see step
  2a).
- **Header check.** All `/api/hooks/*` routes require
  `X-Octomux-Hook-Token` matching the agent's token. Mismatch → 401.
- **127.0.0.1 bind.** `server.listen()` explicitly binds to `127.0.0.1`
  (existing default may bind all interfaces depending on platform/env).
- **CORS deny for hook routes.** Add a middleware that responds 403 to any
  cross-origin request on `/api/hooks/*`.
- **Host header check.** Reject any request whose `Host:` header isn't
  `127.0.0.1` or `localhost` (DNS-rebinding defense).

Existing agents (created before step 1) get tokens minted on first read of
the agent row; the worktree's hook config is rewritten to include the token
at that point. Agents whose parent task is in `closed` state, and chats
that have been ended, are not retroactively updated.

**Settings activation.** Per-harness `validateSettings` is called on read
for registered harnesses; unknown-harness blobs are never executed. This
defangs the "tutorial poisoned my settings.json" vector.

## Data flow — createTask (illustrative)

```ts
// server/task-runner.ts (sketch — annotations show the diff from current)
const harness = getHarness(task.harness_id); // new
const flags = harness.resolveFlags(await getSettings()); // was getClaudeFlags()
const hookToken = mintHookToken(); // new — per-agent

// Session id handling depends on the harness's sessionIdMode.
let sessionIdForDb: string | null;
let sessionIdForLaunch: string;
if (harness.sessionIdMode === 'orchestrator-assigned') {
  const id = harness.newSessionId();
  sessionIdForDb = id;
  sessionIdForLaunch = id;
} else {
  // 'harness-issued' — placeholder used only for the launch placeholder
  // (often ignored by harness). DB column stays NULL until a hook event
  // arrives carrying the real id.
  sessionIdForDb = null;
  sessionIdForLaunch = harness.newSessionId();
}

db.prepare(
  `INSERT INTO agents
     (id, task_id, window_index, label, harness_id, harness_session_id,
      hook_token, agent)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(agentId, id, windowIndex, 'Agent 1', harness.id, sessionIdForDb, hookToken, agentName);

await harness.syncAgents(setup.worktreePath); // always called
await harness.installHooks(setup.worktreePath, hookBaseUrl(), hookToken);

const baseCmd = harness.buildLaunchCommand({
  sessionId: sessionIdForLaunch,
  agent: agentName,
  flags,
});
await sendHarnessCommand({ target, baseCmd, prompt, worktreePath, agentId });
```

`moveAgentToTask`:

```ts
let baseCmd: string;
if (agent.harness_session_id) {
  baseCmd = harness.buildResumeCommand({
    sessionId: agent.harness_session_id,
    flags,
  });
} else {
  // No prior session id — try continue (preserves local context), fall back
  // to launch. Only orchestrator-assigned mode writes the new id back to
  // the DB; harness-issued mode leaves it NULL until a hook event arrives.
  const newId = harness.newSessionId();
  const continueCmd = harness.buildContinueCommand({ sessionId: newId, flags });
  if (continueCmd !== null) {
    baseCmd = continueCmd;
  } else {
    baseCmd = harness.buildLaunchCommand({ sessionId: newId, flags });
    logger.warn(
      { agent_id: agent.id, harness: harness.id },
      'continue unsupported, launching fresh',
    );
  }
  if (harness.sessionIdMode === 'orchestrator-assigned') {
    db.prepare(`UPDATE agents SET harness_session_id = ? WHERE id = ?`).run(newId, agent.id);
  }
}
```

## Error handling

- **Unknown `harness_id` in a DB row.** `getHarness()` throws; setup
  `try/catch` marks task errored. `chats.ts` surfaces as API 400.
- **Settings file with unknown harness key.** Preserved verbatim,
  validation skipped, never read at runtime.
- **`validateSettings` throws.** API returns 400 with the validator's
  message; existing settings are not overwritten.
- **Migration failure.** Wrapped in a transaction in `db.ts`. On failure,
  server fails to start; recovery is "restore DB backup."
- **`buildContinueCommand` returns `null`.** Fallback to launch with a warn
  log (see `moveAgentToTask` snippet).
- **Hook request with missing/wrong token.** 401. No DB write, no agent
  lookup. Log a `logger.warn` with the requesting IP and path.

## Testing strategy

Existing tests must pass unchanged in step 1, modulo column-name renames in
assertions.

- `server/task-runner.test.ts` — assertions on exact shell-command strings
  still match because the Claude harness produces identical commands.
  Helper signatures rename `claude_session_id` → `harness_session_id`.
- `server/chats.ts` tests — same.
- `server/hooks.test.ts` — adjust query column name; add token-required
  tests (401 without header, 401 with wrong token, 200 with right token).
- `server/db.test.ts` — migration tests as enumerated in "Database schema".

New tests:

- `server/harnesses/registry.test.ts`
  - `getHarness('claude-code')` returns the impl.
  - `getHarness('nonexistent')` throws.
  - `getHarness(null)` returns the default.
  - `listHarnesses()` enumerates.
- `server/harnesses/claude-code.test.ts` — table-driven `it.each` covering
  `buildLaunchCommand` / `buildResumeCommand` / `buildContinueCommand`
  across agent / flags / sessionId permutations. Replaces inline
  command-string assertions scattered across task-runner tests. Includes
  security cases: rejected agent names, rejected flag strings.
- `server/settings.test.ts` — extend with:
  - input with only `claudeFlags` → output with
    `harnesses['claude-code'].flags` populated.
  - input with both legacy and new keys → new wins.
  - input with extraneous unknown harness key → preserved on read AND save.
  - settings save strips deprecated keys.
  - `validateSettings` errors surface as API 400 (covered in api tests).
- `server/security.test.ts` (new) — host-header and CORS denial for
  `/api/hooks/*`; token-required behavior.

No E2E changes in step 1.

**Runtime invariant test** (step 1): after `createTask` with
`harness_id = 'claude-code'`, the agent row's `harness_session_id` is
non-null. Catches the orchestrator-assigned mode getting accidentally
treated as harness-issued.

## Step 2a — Cursor harness (backend only)

Independently shippable from step 2b. Lands the Cursor harness behind the
existing API/CLI before any UI changes.

- `server/harnesses/cursor.ts` implementing `Harness`.
  - `sessionIdMode: 'harness-issued'`. Session id is captured from the
    cursor-agent event stream; agent row inserted with `NULL`, populated
    on first event. Step 1's nullable column + insert-NULL flow already
    accommodates this.
  - `buildLaunchCommand` returns a command that sets
    `OCTOMUX_AGENT_ID=<agent-id>` in the environment before invoking
    `cursor-agent`. This is the **agent-id correlation channel** for the
    bridge stub, since Cursor's worktree-scoped hooks.json cannot encode
    per-agent identity in the `command:` field. The bridge reads
    `OCTOMUX_AGENT_ID` from env on each invocation.
  - `buildResumeCommand` returns `cursor-agent resume <chat-id>` (verify
    exact flag during impl).
  - `buildContinueCommand` likely returns `null` (verify).
  - `installHooks` writes a Cursor-format `~/.cursor/hooks.json` whose
    `command` for each event is a path to a per-task script copied into
    `<worktree>/.octomux-hooks/bridge.js` with `0o500` permissions. The
    bridge:
    1. Reads stdin JSON.
    2. Reads `OCTOMUX_AGENT_ID` from env, `<task-hook-token>` from the
       bridge script (baked in at install time).
    3. Decides the response shape locally based on a static allow/deny
       policy mirroring `hook-settings.ts::ALLOWED_TOOLS`/`DENIED_TOOLS`
       for gating events (`beforeShellExecution`, `beforeReadFile`, etc.).
       Cursor expects a JSON response of
       `{permission, userMessage, agentMessage, continue}`.
    4. POSTs to the existing `/api/hooks/*` endpoint with token header for
       notification events (`stop`, `beforeSubmitPrompt`, `afterFileEdit`).
       These endpoints' 200-empty-body shape is fine — the bridge ignores
       octomux's response for notification events.
    5. Prints the Cursor-expected response on stdout.

    **Permission parity (block-and-wait-for-human) is out of scope for
    step 2a.** Cursor's gating is allow/deny via static policy only;
    octomux's inbox-mediated approve flow remains Claude-only until a
    later step extends the bridge with a polling loop.

  - `syncAgents` mirrors octomux agent Markdown definitions into `<worktree>/.cursor/rules/`
    as `.mdc` files (`octomux-agent-{name}.mdc`) so **Cursor CLI** picks them up alongside
    project rules (`alwaysApply: false`). There is still no Cursor-native `--agent` CLI flag like
    Claude's; personas are carried via workspace rules plus optional Cursor harness flags (`--resume`,
    `--model`, `--force`).
  - `validateSettings` validates Cursor's own flags string with the same
    metacharacter ruleset as Claude.

- `bin/octomux-hook-bridge.js` template, copied into each worktree at task
  creation. Per-worktree (not global) to limit blast radius of tampering.

- `GET /api/harnesses` endpoint returning
  `listHarnesses().map(({ id, displayName, sessionIdMode }) => ...)`.
  Used by step 2b's frontend dropdown.

- One new E2E spec: create a task with `harness_id = 'cursor'` via the
  HTTP API, verify cursor-agent launches, verify hook bridge fires on a
  test event.

### New step-1 → step-2a dependencies (already provided by step 1)

- Nullable `harness_session_id`. ✓
- Nullable `permission_prompts.session_id`. ✓
- Per-task `hook_token`. ✓
- `127.0.0.1` bind + CORS deny + Host header check. ✓
- `validateSettings` on the interface. ✓
- `installHooks` receives `baseUrl` + `hookToken`. ✓

## Step 2b — Frontend (harness dropdown + settings panel)

- A small `<HarnessPicker>` component used in the create-task / create-chat
  dialogs. Populated from `GET /api/harnesses`. Defaults to
  `defaultHarnessId` from settings.
- Per-harness settings panel (`<ClaudeCodeSettingsPanel>`,
  `<CursorSettingsPanel>`) rendered in the settings page based on the
  available harnesses. Each panel is a small fixed React component — no
  schema-driven generation. Adding a harness is "ship a new
  `<XSettingsPanel>` component and import it in `SettingsPage.tsx`."
- UI label for the harness concept: **"Coding agent"** (not "harness").
  "Harness" is jargon-y; `harness_id` stays in code and DB, but the
  user-facing label and microcopy use "coding agent" or "agent CLI."
  Decided here so step 2b doesn't re-litigate.

## Step 3 — Per-agent harness

Adds per-agent selection on top of the existing schema.

- Add `<HarnessPicker>` to the add-agent dialog. Defaults to the task's
  `harness_id`; users can override per agent.
- `addAgent` already inserts `harness_id` (column exists from step 1).
- Hook routing already works — lookup is by session id + token.
- Permission-prompt UI gains a small harness badge so users can tell which
  harness raised a prompt when a task mixes them.

## Task breakdown

### Step 1 (refactor + security baseline)

1. Scaffold `server/harnesses/` directory with `types.ts` (interface +
   shared `validateAgentName`) and empty `registry.ts` / `claude-code.ts`.
2. Implement `claudeCodeHarness` by porting `buildLaunchCommand` /
   `buildResumeCommand` / `buildContinueCommand` / `resolveFlags` /
   `validateSettings` / `syncAgents` / `installHooks` from existing
   modules. Add unit tests (`harnesses/claude-code.test.ts`,
   `harnesses/registry.test.ts`).
3. Extract `hookBaseUrl()` helper. Update `installHooks` to embed token.
4. DB migration: add `tasks.harness_id`, `agents.harness_id`,
   `agents.hook_token`; `RENAME COLUMN claude_session_id`; relax
   `permission_prompts.session_id` to nullable. Update the index name and
   the column references inside `rebuildAgentsTable` in `server/db.ts` so
   future unrelated rebuilds use the new name. Add migration tests
   (idempotency, non-empty DB, pre-existing non-default value).
5. Replace call sites in `server/task-runner.ts` and `server/chats.ts`
   with `getHarness(task.harness_id).*` dispatches. Rename
   `sendClaudeCommand` → `sendHarnessCommand`. Tighten prompt-file write
   (`O_EXCL`, mode `0o600`). Update existing tests (mostly mechanical
   column renames; command strings unchanged).
6. Move `installHookSettings` body into `claudeCodeHarness.installHooks`;
   keep the public wrapper as a one-line dispatch.
7. Move `syncAgents` body in `server/agents.ts` into the harness; keep
   the public wrapper. Drop the `if (agentName)` gate at call sites — the
   harness handles "no agent specified" internally.
8. Update `hooks.ts`: rename column, add token header check, add a
   `findAgentBySessionAndToken` query.
9. Settings: split shape into `harnesses: Record<...>`. Add lazy
   migration of deprecated keys with one-time warn. Per-harness
   `validateSettings` dispatch. Update settings tests.
10. Server hardening: bind `127.0.0.1`, add Host header middleware, add
    CORS-deny middleware for `/api/hooks/*`. Add tests in
    `server/security.test.ts`.
11. Mint `hook_token` for new agents (task agents and standalone chat
    agents); backfill mint on first read for existing running agents
    (re-runs `installHooks` to refresh the worktree config); skip for
    agents whose task is `closed`.
12. Tighten `validateClaudeFlags` ruleset. Apply to
    `OCTOMUX_CLAUDE_FLAGS` env. Validate `agent` names at API boundary
    (`api.ts:596, 821, 1697`).
13. Typecheck + full test suite + manual smoke test (`bun run dev`,
    create a task, verify Claude launches identically). Document forward-
    only migration in CLAUDE.md.
14. Update CLAUDE.md "Architecture" section to mention
    `server/harnesses/`, and add a one-line note: "Existing DBs should be
    backed up before upgrade; migration is forward-only."

### Step 2a (Cursor harness backend)

1. Implement `cursorHarness` in `server/harnesses/cursor.ts`.
2. Add `bin/octomux-hook-bridge.js` template + per-worktree copy logic
   inside `cursorHarness.installHooks`.
3. Add `GET /api/harnesses`.
4. Verify cursor-agent CLI flags during impl (exact resume syntax).
5. New E2E: end-to-end Cursor task lifecycle via API.

### Step 2b (frontend harness selection)

1. `<HarnessPicker>` component, fetches from `/api/harnesses`.
2. Add picker to create-task / create-chat dialogs.
3. Per-harness settings panels in `SettingsPage.tsx`.
4. UI microcopy uses "Coding agent" label.
5. New E2E: create task with each harness via UI.

### Step 3 (per-agent harness)

1. Add `<HarnessPicker>` to add-agent dialog.
2. Wire `addAgent` API to accept `harness_id` (column already exists).
3. Add harness badge to the permission-prompt inbox.

## Open questions deferred to implementation

- Exact form of Claude's HTTP hook URL with the per-task token (query
  param vs custom header — depends on what `.claude/settings.local.json`
  supports). Resolved in step 1.
- Cursor's exact `hooks.json` `command` schema and stdin/stdout contract
  details. Resolved in step 2a (test against the actual binary).
- Whether Cursor's bridge should support block-and-wait-for-human
  permission prompts. Deferred — step 2a ships static allow/deny only.
- Whether to add a generic "custom command" harness (Claude-Squad style
  `{name, program}`) as a future fourth option. Out of scope until needed.
