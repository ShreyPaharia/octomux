# Harness abstraction — step 2a (Cursor backend) design

Concrete design for step 2a of `spec/harness-abstraction.md`. Step 1 (refactor +
security baseline) is merged. This document refines the high-level "step 2a"
section of the parent spec with implementation-ready detail, grounded in
verification of the installed `cursor-agent` binary
(`2026.05.16-0338208`) and the public docs at `cursor.com/docs/hooks`.

Scope: backend-only. UI changes are step 2b; per-agent harness is step 3.

## Verification of Cursor's hook protocol

The original step-2a section assumed Cursor's hooks consume stdin JSON and
return stdout JSON. Verification against the binary and docs confirms that and
adds three corrections that shape the implementation.

1. **Config locations** (highest to lowest precedence): enterprise paths;
   project `<worktree>/.cursor/hooks.json`; user `~/.cursor/hooks.json`.
   We write per-worktree only. We never touch `~/.cursor/hooks.json` —
   it would clobber the user's interactive Cursor configuration.

2. **Top-level schema:**
   ```json
   {
     "version": 1,
     "hooks": {
       "<eventName>": [
         {
           "command": "<absolute path>",
           "type": "command",
           "timeout": <seconds>,
           "failClosed": false,
           "loop_limit": null,
           "matcher": "<regex, optional>"
         }
       ]
     }
   }
   ```
   Exit-code semantics: `0` → use stdout JSON; `2` → block (`permission:
   "deny"` equivalent); other → fail-open unless `failClosed: true`.

3. **Common stdin base** (every event except `workspaceOpen`):
   `conversation_id`, `generation_id`, `model`, `hook_event_name`,
   `cursor_version`, `workspace_roots`, `user_email`, `transcript_path`.
   Event-specific fields are layered on top.

4. **Env passed to hook scripts** — *correction to the parent spec*.
   Decompiled `agent-cli/hooks-exec` builds a fresh env object:
   ```js
   Object.assign({CURSOR_PROJECT_DIR, CURSOR_VERSION},
     user_email && {CURSOR_USER_EMAIL},
     transcript_path && {CURSOR_TRANSCRIPT_PATH},
     {CLAUDE_PROJECT_DIR},
     sessionEnv)
   ```
   No spread of `process.env`. **Variables exported in the shell that
   launched `cursor-agent` do NOT reach the bridge.** The parent spec's
   `OCTOMUX_AGENT_ID` env-var correlation channel is therefore not
   viable. Step 2a uses an alternative — see "Correlation channel" below.

5. **CLI flags**:
   - Resume specific chat: `cursor-agent --resume <chatId>`.
   - Continue: `cursor-agent --continue` — latest-only, no id arg.
   - Force / skip-permissions: `--force` (alias `--yolo`).
   - Interactive (default) vs `--print` (one-shot non-interactive). We
     stay interactive (tmux pane).

## Module layout

```
server/harnesses/cursor.ts        new — Harness impl
server/harnesses/cursor.test.ts   new — unit tests
bin/octomux-hook-bridge.js        new — bridge script template
server/hooks.ts                   edit — findAgentByTokenAndSession, new endpoint
server/api.ts                     edit — GET /api/harnesses
server/harnesses/registry.ts      edit — register cursorHarness
e2e/cursor-harness.spec.ts        new — with fake cursor-agent stub
```

No DB migrations; step 1 already added `tasks.harness_id`, `agents.harness_id`,
`agents.hook_token`, nullable `agents.harness_session_id`, and nullable
`permission_prompts.session_id`.

## Cursor harness shape

```ts
export const cursorHarness: Harness = {
  id: 'cursor',
  displayName: 'Cursor',
  sessionIdMode: 'harness-issued',

  newSessionId() {
    // Placeholder for internal correlation only; never persisted to DB.
    // The real id arrives in stdin's `conversation_id` on the first hook
    // event of any kind. The first matching `(token, harness_session_id
    // IS NULL)` event causes the binding update.
    return crypto.randomUUID();
  },

  buildLaunchCommand({ flags = '' }) {
    return `cursor-agent${flags}`;
  },

  buildResumeCommand({ sessionId, flags = '' }) {
    return `cursor-agent --resume ${sessionId}${flags}`;
  },

  buildContinueCommand() {
    return null; // --continue is latest-only; no session-specific form
  },

  async installHooks(worktreePath, baseUrl, hookToken) {
    // 1. mkdir <worktree>/.octomux-hooks (0700)
    // 2. copy bin/octomux-hook-bridge.js -> bridge.js (0500)
    // 3. write config.json {baseUrl, token: hookToken} (0600)
    // 4. write <worktree>/.cursor/hooks.json (0644) pointing the wired
    //    events at the absolute bridge.js path
  },

  async syncAgents() {
    // No-op: Cursor has no first-class custom-agents concept (verified
    // against the binary — no `.cursor/agents/` references).
  },

  resolveFlags(settings) {
    const sub = (settings.harnesses?.cursor ?? {}) as {
      flags?: string;
      force?: boolean;
    };
    const parts: string[] = [];
    if (sub.force) parts.push('--force');
    if (sub.flags) parts.push(validateFlagString(sub.flags, 'harnesses.cursor.flags'));
    return parts.length > 0 ? ` ${parts.join(' ')}` : '';
  },

  validateSettings(blob) {
    // Accept { flags?: string, force?: boolean }; everything else rejected
  },

  validateAgentName(name) {
    return validateAgentName(name); // shared default
  },
};
```

`newSessionId()` deliberately returns a UUID rather than `''`. Callers in
`task-runner.ts` need a non-empty placeholder to pass through code paths that
expect a string; the value is consumed for internal correlation only and is
explicitly *not* written to `agents.harness_session_id` (which stays NULL until
the first hook event arrives) because the parent spec specifies
`sessionIdMode: 'harness-issued'` requires NULL-until-bound.

## Correlation channel

Cursor strips parent env, so `OCTOMUX_AGENT_ID` cannot be passed via the launch
shell. Replacement strategy:

- **Authentication:** `hook_token` (32 random hex bytes from step 1) is baked
  into `<worktree>/.octomux-hooks/config.json` at install time.
- **Identification:** `conversation_id` from each stdin payload identifies
  which chat the event belongs to. For the first event of a new session,
  `(token, harness_session_id IS NULL)` resolves to the most-recently-created
  matching agent, which simultaneously binds `harness_session_id` to the
  observed `conversation_id`.

For step 2a (single agent per task — multi-agent is step 3), this is
unambiguous: the only NULL-session row for a given token is the active agent.
Step 3 will tighten this to per-agent tokens.

## hooks.json contents

Step 2a wires four events. `failClosed: false` is the default → bridge errors
fail-open (consistent with notification semantics; the denylist event has its
own deny semantics on exit code 2).

```json
{
  "version": 1,
  "hooks": {
    "sessionStart":         [{ "command": "<abs>/bridge.js", "type": "command", "timeout": 5 }],
    "beforeSubmitPrompt":   [{ "command": "<abs>/bridge.js", "type": "command", "timeout": 5 }],
    "beforeShellExecution": [{ "command": "<abs>/bridge.js", "type": "command", "timeout": 5 }],
    "postToolUse":          [{ "command": "<abs>/bridge.js", "type": "command", "timeout": 5 }],
    "afterFileEdit":        [{ "command": "<abs>/bridge.js", "type": "command", "timeout": 5 }]
  }
}
```

- `sessionStart` — captures the start-of-session signal for the activity
  feed; also typically the first event that causes the session-id bind.
- `beforeSubmitPrompt` — Claude's `UserPromptSubmit` analogue. POST to
  `/api/hooks/user-prompt-submit`.
- `beforeShellExecution` — applies the static denylist. **Reason it is
  wired even though the parent spec called step 2a "no permission
  gates":** the Claude harness ships `DENIED_TOOLS` enforcement (git push
  --force, git reset --hard, rm -rf), so omitting it for Cursor would
  silently lower the safety floor. The denylist is hardcoded into
  `bridge.js`, identical semantics to Claude's denylist, regex-matched
  against `command: string`.
- `postToolUse` and `afterFileEdit` — Claude's `PostToolUse` analogues
  for the activity feed.

Events explicitly NOT wired in step 2a: `preToolUse`, `beforeReadFile`,
`beforeMCPExecution`, `afterShellExecution`, `afterMCPExecution`,
`postToolUseFailure`, `subagentStart`, `subagentStop`, `preCompact`, `stop`,
`sessionEnd`, `afterAgentResponse`, `afterAgentThought`, `workspaceOpen`,
`beforeTabFileRead`, `afterTabFileEdit`. They can be added incrementally as
specific features need them; each adds a small handler to `bridge.js` and (if
notification) a server-side endpoint.

`stop` deserves a small note: Claude's `Stop` event is wired and used.
Cursor's `stop` is similarly available. We defer wiring it to a follow-up
because the existing `/api/hooks/stop` endpoint is Claude-specific in its
payload assumptions; adding Cursor's payload there is its own small refactor.

## Bridge script (`bin/octomux-hook-bridge.js`)

Self-contained Node script: shebang `#!/usr/bin/env node`, only stdlib imports
(`node:fs`, `node:http`, `node:path`, `node:url`). No npm dependencies — the
worktree should not need a node_modules to run hooks.

Permissions: copied with mode `0o500`. Owner-only read+execute, no write.

### Flow

1. Read all of stdin synchronously; `JSON.parse`. If parse fails, write `{}`
   to stdout and exit 0 (fail-open).
2. Resolve sibling `config.json` (mode 0600) via `path.dirname(realpath(argv[1]))`.
   Read and parse → `{ baseUrl, token }`.
3. Branch on `payload.hook_event_name`:
   - `sessionStart` → POST `${baseUrl}/api/hooks/session-start?token=…`
     with `{conversation_id, session_id, is_background_agent}`.
     Stdout `{}` (no env injection; we don't need session-scoped env).
   - `beforeSubmitPrompt` → POST `${baseUrl}/api/hooks/user-prompt-submit?token=…`
     with `{conversation_id, prompt}`. Stdout `{continue: true}`.
   - `beforeShellExecution` → apply the hardcoded denylist (regex array)
     locally:
     - If any regex matches `payload.command`, stdout
       `{permission: "deny", user_message: "<rule name>"}` and exit 0.
     - Otherwise stdout `{permission: "allow"}` and exit 0.
     - The denylist mirrors Claude's `DENIED_TOOLS` (the destructive
       set). Initial list: `/^\s*rm\s+-rf\b/`,
       `/^\s*git\s+push\s+--force\b/`, `/^\s*git\s+reset\s+--hard\b/`.
   - `postToolUse`, `afterFileEdit` → POST
     `${baseUrl}/api/hooks/post-tool-use?token=…` with
     `{conversation_id, hook_event_name, ...event-specific fields}`. Stdout
     `{}`.
   - default → stdout `{}`.
4. Any thrown error → `console.error(err)` + stdout `{}` + exit 0.

The bridge never exits with code 2. Deny is communicated via the JSON
response on stdout with exit 0. (Exit 2 is functionally equivalent for permission
events but JSON is more explicit and works uniformly for all event types.)

### Why a sibling `config.json` rather than baking values into bridge.js

Two reasons:
1. The bridge script is a copy of `bin/octomux-hook-bridge.js`. Keeping it
   immutable (script logic) plus a separate mutable `config.json` means we
   don't need to template the script per worktree — `fs.copyFile` suffices.
2. Token rotation in future steps becomes a single-file rewrite.

## Server-side wiring

### `findAgentByTokenAndSession(token, conversationId)`

Single helper used by every hook endpoint (Claude and Cursor):

1. If `conversationId` is provided, try
   `SELECT * FROM agents WHERE hook_token = ? AND harness_session_id = ?`.
   If a row exists, return it.
2. Otherwise (no row matched or conversationId omitted), try
   `SELECT * FROM agents WHERE hook_token = ? AND harness_session_id IS NULL
    ORDER BY created_at DESC LIMIT 1`.
   If a row exists AND `conversationId` is provided:
   `UPDATE agents SET harness_session_id = ? WHERE id = ?` to bind, then
   return the bound row.
3. If neither query matches, return `null`. Caller responds with 401.

This is identical to step 1's `findAgentByToken` semantics on the happy path
(Claude's `harness_session_id` is set at insertion, step 1 in
orchestrator-assigned mode). It just adds the bind-on-first-event branch.

The existing Claude endpoints already accept a token; we change them to also
read an optional `conversation_id` from the request body, threading it through
the helper. No behavior change for Claude (where `conversation_id` is absent
and `harness_session_id` matches by token alone via the legacy direct lookup
we'll keep as a fallthrough for compatibility).

### New endpoint: `POST /api/hooks/session-start`

Plain notification endpoint (not a magic binder — the binding happens in the
shared helper). Accepts `{token (query param), conversation_id, session_id,
is_background_agent}` in body. Returns 200 empty.

This is added now because Cursor's `sessionStart` payload doesn't map onto any
existing Claude endpoint. Future work can have Claude also call it (e.g., a
session-started activity-feed event).

### `GET /api/harnesses`

```ts
app.get('/api/harnesses', (_req, res) => {
  res.json(
    listHarnesses().map(({ id, displayName, sessionIdMode }) => ({
      id,
      displayName,
      sessionIdMode,
    })),
  );
});
```

No auth (server is 127.0.0.1-bound + CORS-deny + Host-check from step 1).
Consumed by step 2b's frontend.

## Settings shape

`harnesses['cursor']` accepts:

```ts
{
  flags?: string;   // additional CLI flags, validated via validateFlagString
  force?: boolean;  // appends --force to the launch command
}
```

`validateSettings`:
- Rejects unknown keys.
- `flags` runs through the same `validateFlagString` rule set as Claude
  (no `;`, `|`, `&`, `>`, `<`, backtick, `$(`, newline; balanced quotes).
- `force` must be boolean.

Unknown-harness-key preservation continues to work per step 1.

## E2E (`e2e/cursor-harness.spec.ts`)

Fake `cursor-agent` stub installed at `<worktree>/bin-stub/cursor-agent`
(prepended to `PATH` for the tmux session via the launch command).

Stub script (bash):
```bash
#!/bin/bash
set -euo pipefail
WORKTREE="$(cd "$(dirname "$0")/.." && pwd)"
# Synthesize a sessionStart event and pipe to the bridge
cat <<JSON | "$WORKTREE/.octomux-hooks/bridge.js"
{"hook_event_name":"sessionStart","conversation_id":"e2e-test-chat-id","session_id":"e2e-test-chat-id","is_background_agent":false,"workspace_roots":["$WORKTREE"]}
JSON
exec sleep 3600
```

Test (Playwright API test, no UI):
1. POST `/api/tasks` with `harness_id: "cursor"`. Assert 200.
2. Wait for status `running` (existing `waitForStatus` helper).
3. Assert `agents.harness_id = 'cursor'` and `agents.harness_session_id`
   non-null (the fake `sessionStart` bound it).
4. `GET /api/harnesses` → assert both `claude-code` and `cursor` present
   with `sessionIdMode` set correctly.
5. Cleanup via `deleteAllTasks`.

The fake binary is installed by a Playwright `beforeAll` hook that writes the
stub into a tmp dir and exports a `CURSOR_AGENT_PATH_OVERRIDE` env var read by
the task setup code — OR the simpler form: launch command is generated from
`harness.buildLaunchCommand`, and we prepend the stub dir to `$PATH` via a
test-only hook in `task-runner.ts`. Implementation will pick the cleaner of
the two during the plan.

## Tests

Unit:
- `server/harnesses/cursor.test.ts` — table-driven for the command builders,
  `resolveFlags`, `validateSettings`, plus `installHooks` (writes correct
  files at correct modes — use a `tmp` dir).
- `server/hooks.test.ts` extended — `findAgentByTokenAndSession` covers
  happy path + first-event bind path + 401 on neither match.
- `server/api.test.ts` extended — `GET /api/harnesses` returns both
  harnesses with correct shape.
- `server/harnesses/bridge.test.ts` (new) — spawns `bin/octomux-hook-bridge.js`
  with stdin JSON, asserts HTTP call to a local test server (via
  `createServer`), asserts stdout JSON. Cases: each wired event + an
  unwired event + a malformed stdin + the denylist regex set.

E2E:
- `e2e/cursor-harness.spec.ts` as above.

## Out of scope (step 2a)

- Frontend dropdown / settings panel — step 2b.
- Per-agent harness in add-agent — step 3.
- Block-and-wait-for-human permission prompts — later step.
- Real `cursor-agent` in CI (stubbed only).
- Tab hooks (`beforeTabFileRead`, `afterTabFileEdit`) — those fire on inline
  completions, not agent runs.
- `cursor-agent worker` mode (private cloud worker) — not used.

## Behavior changes (step 2a)

- New harness `cursor` becomes available via `POST /api/tasks` with
  `harness_id: "cursor"` (CLI / API only — UI lands in 2b).
- New endpoint `GET /api/harnesses` and `POST /api/hooks/session-start`.
- New worktree-local directory `.octomux-hooks/` is created for any task
  using the Cursor harness. Claude tasks unaffected.
- `agents.harness_session_id` may be NULL longer than before for Cursor
  tasks (until the first hook event arrives) — already a documented
  consequence of harness-issued mode from step 1.

## Risks and mitigations

- **Cursor changes hook spawn env behavior** (starts passing parent env).
  Bridge correlation still works (we use `conversation_id` + token, not
  env). The change would be neutral.
- **Cursor changes the event payload shape**. Bridge defensively reads
  `conversation_id` and `hook_event_name`; missing fields trigger
  fail-open with a stderr log. Manual smoke test after each Cursor binary
  upgrade.
- **Multi-agent in one Cursor task** (out of scope for step 2a but the DB
  allows it). The single NULL-row resolution would race. Mitigation: step
  3 introduces per-agent disambiguation. Until then, the UI in step 2b
  should not let users add a second Cursor agent to a task (handled in
  2b's PR).
- **Bridge file tampering**. Mode 0500 prevents accidental edits; the
  worktree is owner-only via `.git`'s setup. Bridge fail-opens on its own
  errors but can't be silently rewritten without a privilege escalation.

## Forward references

- Step 2b consumes `GET /api/harnesses` to populate the dropdown and
  renders a `<CursorSettingsPanel>` for the `{flags, force}` shape.
- Step 3 will likely move tokens from "per-task identical" to
  "per-agent distinct" so the NULL-row fallback no longer races.
