# Agent Session — `runAgentSession` spec

**Module:** `server/agent-session/session.ts`

## Purpose

`runAgentSession` is a DB-free primitive that orchestrates a single, structured
agent invocation: launch an agent process via a pluggable `ProcessSubstrate`,
wait for the agent to call the `submit_result` MCP tool, and return the captured
result typed against a caller-supplied JSON Schema.

It is deliberately decoupled from octomux's task DB, task-engine, and
orchestrator so it can be used in tests and standalone tooling without any
infrastructure beyond a workspace directory.

---

## API

```ts
runAgentSession<T>(opts: RunAgentSessionOptions<T>): Promise<{ result: T }>
```

### `RunAgentSessionOptions<T>`

| Field          | Type                 | Default                          | Notes                                                               |
| -------------- | -------------------- | -------------------------------- | ------------------------------------------------------------------- |
| `workspaceDir` | `string`             | —                                | CWD for the spawned process; no git needed                          |
| `harness`      | `Harness`            | —                                | Type-only import; only `buildLaunchCommand` + `newSessionId` called |
| `input`        | `string`             | —                                | Prompt sent to the agent                                            |
| `substrate`    | `ProcessSubstrate`   | —                                | `ptySubstrate` or `tmuxSubstrate`                                   |
| `outputSchema` | `object`             | —                                | JSON Schema for the structured result                               |
| `model`        | `string \| null`     | `null`                           | Per-invocation model override                                       |
| `capture`      | `CaptureStrategy<T>` | `mcpSubmitResultCapture(schema)` | Override for testing or custom capture                              |
| `timeoutMs`    | `number`             | `300_000`                        | Milliseconds before timeout rejection                               |
| `resultDir`    | `string`             | fresh `os.tmpdir()` subdir       | Where mcp-config + result file land                                 |

### Execution flow

1. `capture.setup({ workspaceDir })` → `{ extraArgs, env }`.
2. Append the `submit_result` instruction to the input prompt; write to `resultDir/prompt.txt`.
3. `harness.buildLaunchCommand({ sessionId, flags: extraArgs, model, workspacePath })` → base command.
   Append `--print < <prompt-file>` for non-interactive (headless) execution.
4. `substrate.spawn({ command, cwd: workspaceDir, env })` → `ProcessHandle`.
5. Race three promises:
   - `capture.waitForResult()` → resolves with `T` on success.
   - `handle.onExit` → rejects with "agent exited before submitting result".
   - timeout → rejects with "timed out after Xms".
6. `try/finally`: always calls `handle.dispose()` + `capture.dispose()`.

---

## Seams

### Substrate seam (`ProcessSubstrate`)

```
ptySubstrate  — spawn a shell + command under a local pty.
                Parent process holds the pty; dispose() kills it.
                Suitable for headless / CI / tool invocations.

tmuxSubstrate — create a named tmux session; attach via a pty.
                Session survives parent exit; dispose() kills the tmux session.
                Suitable for reattachable, long-running agents.

tmuxWindowSubstrate — create-or-reuse a named detached tmux session and add
                      windows without a parent-held pty. Returns a window
                      index for external attach (dashboard grouped viewers).
                      Used by the live task-engine path; distinct from the
                      spawn-and-hold-a-pty model above.
```

### Capture seam (`CaptureStrategy<T>`)

```
mcpSubmitResultCapture (default)
  setup    → writes mcp-config.json; returns --mcp-config <path>
  waitForResult → watches resultDir for result.json; parses + resolves
  dispose  → closes fs watcher; removes resultDir

Custom capture
  Inject any CaptureStrategy<T> (e.g. a pipe, a callback server)
  for testing or alternative transport.
```

---

## No-git / no-DB / no-task-engine guarantee (pty path)

When used with `ptySubstrate`:

- `workspaceDir` can be any writable directory (e.g. `os.tmpdir()` subdir).
- No git initialisation is performed.
- No DB rows are read or written.
- No tmux sessions are created (only the agent's own pty process).
- `server/task-engine/*`, `server/task-runner.ts`, `server/terminal.ts` are
  NOT imported directly or transitively.

This makes `runAgentSession + ptySubstrate` safe to use in tests, CLI tools,
and batch pipelines without any octomux infrastructure.

---

## Live task-path tmux orchestration

The interactive task dashboard path (`server/task-engine/launch.ts` →
`launchAgentWindow`, `terminals.ts`, and empty-session recovery in
`lifecycle.ts`) routes `new-session` / `new-window` orchestration through
`tmuxWindowSubstrate` in `server/agent-session/substrate-tmux-windowed.ts`.

**Model** (unchanged from before consolidation):

| Dimension         | `runAgentSession` (pty/tmux substrates)   | Live task path (`tmuxWindowSubstrate`)                        |
| ----------------- | ----------------------------------------- | ------------------------------------------------------------- |
| Session ownership | Parent process holds the handle           | Named `octomux-agent-<id>` tmux session created independently |
| Windows           | Single process / single session           | Multiple tmux windows (one per agent)                         |
| Attach model      | Parent-held pty (headless) or attach once | External xterm.js dashboard attaches at any time              |
| Lifecycle         | dispose() kills everything                | `closeTask` / `deleteTask` with DB + git cleanup              |
| Structured result | MCP submit_result capture                 | Not applicable (interactive streaming output)                 |

The live path is intentionally **not** routed through `runAgentSession` or the
spawn-and-hold-a-pty `tmuxSubstrate`. Both paths share `execTmux` /
`tmux-bin.ts` as a leaf utility.

**Files using `tmuxWindowSubstrate`:**

- `server/task-engine/launch.ts` — `launchAgentWindow`
- `server/task-engine/terminals.ts` — user nvim/shell terminals
- `server/task-engine/lifecycle.ts` — empty-session recovery on resume

**Files not modified (viewer attach model unchanged):**

- `server/terminal.ts`
