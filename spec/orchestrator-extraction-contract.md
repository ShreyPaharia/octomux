# Orchestrator extraction contract

> Status: enforced as of [Modular 05] (SHR-179). This document defines the
> dependency surface the orchestrator (`server/orchestrator/**`) is allowed to
> have, so it can later be lifted into an independent package ([Modular 09]).

## Goal

The orchestrator must depend only on **stable, narrow interfaces** — never on
shared database tables or task-runtime internals. After [Modular 05] its only
couplings are the ones listed below; extraction becomes a mechanical move.

## Allowed dependencies (the contract)

The orchestrator MAY import:

1. **Task-engine public API** — `server/task-engine/index.js`
   (`startTask`, `closeTask`, `deleteTask`, `resumeTask`, `addAgent`,
   `sendMessageToAgent`, …). The orchestrator never knows about tmux/git/worktrees.
2. **Repositories** — `server/repositories/index.js` for **read access to shared
   tables** (`getTask`, `listTasks`, `countTasks`, `setWorkflowStatus`,
   `listActiveAgents`/`listAllAgents`, `countAgentsForTask`, …). Typed functions
   only — never raw SQL.
3. **`server/services/task-service.js`** — `createTask` (persist-then-fire-and-forget
   `startTask`; the orchestrator keeps `upsertManagedTask` between create and start).
4. **`server/orchestrator/store.ts`** — the orchestrator's OWN repository for its
   OWNED tables: `orchestrator_conversations`, `orchestrator_messages`,
   `action_cards`, `managed_tasks`, `orchestrator_action_results`,
   `conversation_usage`, `events`, `permission_rules`. These tables travel with the
   orchestrator at extraction. `store.ts` is the ONLY orchestrator module allowed to
   call `getDb()`/`.prepare()`.
5. **An inbound event-subscribe callback** — the events→supervisor bridge lives at
   the composition root (`server/index.ts`: `subscribeServerEvents` →
   `supervisor.processEvent`). The supervisor is already a pure interface; a named
   `EventBus` type is deliberately NOT introduced (one producer + one consumer; the
   seam already exists). Inject a `subscribe` callback when [Modular 09] extracts.
6. **Hook-auth** (`hook-token`/`hook-base-url`), **`stream.ts`/`pushToConversation`**,
   and **leaf utilities** (logger, shell-quote, etc.).

## Forbidden dependencies

The orchestrator may NOT import:

- `server/db.ts` (`getDb`) or call `.prepare()` — **except `store.ts`**.
- `server/task-runner.ts` (use the task-engine API instead).
- `server/tmux-input.ts` (`sendMessageToAgent` is re-exported from the task-engine).
- `server/task-select.ts` (`SELECT_TASK_SQL`) — use `getTask`/`listTasks`.

## Enforcement

- The ESLint guard in `eslint.config.js` bans `getDb()`/`.prepare()` across
  `server/**` and exempts only the repository layer, `db.ts`, `tmux-bin.ts`,
  test/helper files, integrations, and **`server/orchestrator/store.ts`**. Any new
  orchestrator module that reaches for `getDb` fails lint.
- Completeness grep-gate (should match ONLY `store.ts`):

  ```sh
  grep -rn "getDb\|SELECT_TASK_SQL\|from '\.\./task-runner\|from '\.\./tmux-input" \
    server/orchestrator --include='*.ts' | grep -v '\.test\.ts'
  ```

## Known out-of-scope caveat

`server/orchestrator/mcp/server.ts` runs as a separate stdio subprocess that opens
the SAME SQLite file (via the read/write handlers it dispatches to). Routing those
handlers through repositories does NOT give the subprocess process/DB isolation —
that is a larger redesign deferred to the package-extraction milestone ([Modular 09]).
