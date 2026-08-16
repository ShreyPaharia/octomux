# Session hibernation

Status: design approved 2026-08-13. Not yet implemented.

## 1. Problem

A live octomux "session" is, in memory terms, exactly one thing: the harness
process (`claude`). Measured on a 32 GB dev machine with 14 live sessions:

| what                                    | RSS        |
| --------------------------------------- | ---------- |
| 14 `claude` processes                   | **7.9 GB** |
| all tmux servers and sessions combined  | 12 MB      |
| octomux server (`dist-server/index.js`) | 85 MB      |

Per-session cost is 78–392 MB and grows with transcript length. tmux, node-pty,
git worktrees and the SQLite DB are all rounding errors against it.

Most of those processes are doing nothing. They are sessions the user finished
with hours ago, held open only because nothing reclaims them.

### 1.1 Why sandboxing is not the answer

The obvious reach — put sessions in Daytona / E2B / Firecracker / Docker — does
not address this, and was explicitly rejected:

- **Remote sandboxes** (Daytona, E2B, Modal) run the same `claude` process on
  someone else's machine. That relocates the cost and adds billing plus network
  latency. It never reduces it.
- **Local containers** add overhead. On macOS, Docker means a Linux VM with a
  fixed RAM allotment — strictly worse than running the process natively.
- **OS-level sandboxes** (bubblewrap on Linux, seatbelt on macOS — what
  omnigent uses) cost ~0 RAM but also save ~0 RAM. They are a _security_
  boundary, not a memory one.

Sandboxing solves isolation and remote access. Those are real goals, but they
are different goals, and neither is this one. See §7.

## 2. Concept

> A **hibernated session** is: no live process, a stored `harness_session_id`,
> and a wake action that spawns `--resume <id>` into a tmux window.

Three producers converge on one wake path:

| producer                        | how it hibernates                         |
| ------------------------------- | ----------------------------------------- |
| task idle past the timeout      | `poller/hibernate.ts` pass 1              |
| task evicted by the session cap | `poller/hibernate.ts` pass 2              |
| finished schedule/session run   | already dead; just records its session id |

The design adds no new lifecycle machinery. `next` already ships every piece:

| piece                                       | where                                                         |
| ------------------------------------------- | ------------------------------------------------------------- |
| per-worker idle signal from harness hooks   | `workers.hook_activity` + `_updated_at`                       |
| "all workers idle N ms, no pending prompts" | `listTasksAwaitingQuiescence()` — `repositories/tasks.ts:869` |
| poller framework                            | `server/poller/` (`quiescence.ts` is the template)            |
| stop workers, keep worktree + branch        | `closeTask` — `task-engine/cleanup.ts:31`                     |
| relaunch each worker with `--resume`        | `relaunchStoppedAgents` — `lifecycle/resume-task.ts:81`       |
| attachable tmux session with a chosen cwd   | `createChat` — `chats.ts:57`                                  |
| terminal WS for such a session              | `/ws/terminal/chat/:id` — `terminal.ts`                       |

## 3. Tasks — idle timeout and session cap

### 3.1 Schema

```sql
ALTER TABLE tasks ADD COLUMN hibernated_at TEXT;   -- nullable, mirrors deleted_at
```

Deliberately **not** a new `RuntimeState`. The union in
`packages/types/src/index.ts:1` is closed (`idle | setting_up | running | error
| looping`) and widening it would ripple through every exhaustive switch,
query and poller. Hibernated tasks sit at `runtime_state = 'idle'` —
byte-identical to a user-closed task, so all existing code keeps working
untouched. `hibernated_at` is the sole marker distinguishing "octomux slept
this, wake it on demand" from "the user closed this".

### 3.2 Settings

Two fields on `OctomuxSettings` (`server/settings.ts:12`), following the
existing `approvalTimeoutMs` precedent:

| setting           | default       | meaning                                         |
| ----------------- | ------------- | ----------------------------------------------- |
| `hibernateIdleMs` | `30 * 60_000` | idle time before a task is slept                |
| `maxLiveSessions` | `8`           | soft cap on concurrently live harness processes |

`maxLiveSessions` counts **live harness processes** — non-stopped `workers`
rows across tasks with `runtime_state = 'running'` — because that is what
consumes the RAM (§1). A task running three workers counts as three. The
eviction _unit_, however, is the whole task: hibernating half a task's workers
would leave it in a state nothing else in the codebase understands.

Setting `maxLiveSessions` to `0` disables the cap pass; setting
`hibernateIdleMs` to `0` disables the timeout pass. Both are read per tick, so
changes take effect without a restart.

### 3.3 Eligibility query

`listTasksAwaitingQuiescence()` cannot be reused as-is. It filters
`workflow_status = 'in_progress'`, and `pollQuiescence` flips exactly those
rows to `human_review` within its 90 s debounce — so by the time a task is
hibernation-worthy that query no longer matches it.

Two new siblings in `repositories/tasks.ts`:

```ts
listTasksIdleFor(ms: number): Array<{ id: string; last_activity_at: string }>
countLiveWorkers(): number
```

`listTasksIdleFor` has the same shape as `listTasksAwaitingQuiescence` with
three changes:

- `workflow_status IN ('in_progress', 'human_review')`
- `AND hibernated_at IS NULL`
- returns `MAX(w.hook_activity_updated_at) AS last_activity_at`, ascending, so
  the cap pass gets its LRU order straight from the query

`runtime_state = 'running'` is retained, which excludes loop tasks
(`'looping'`) automatically — loops respawn their agent every iteration and
must never be slept.

`countLiveWorkers` counts non-stopped `workers` rows joined to tasks with
`runtime_state = 'running'` and `deleted_at IS NULL` — the cap's numerator per
§3.2. It is deliberately a separate query rather than a length of
`listTasksIdleFor`: the cap must be measured against _all_ live sessions, while
eviction candidates come only from the idle subset.

### 3.4 Poller

`server/poller/hibernate.ts`, cadence `HIBERNATE_INTERVAL = 60_000` (0 in test
env, per `poller/intervals.ts` convention).

```
pass 1 — timeout
  for each task in listTasksIdleFor(hibernateIdleMs):
    if not eligible(task): continue
    hibernate(task)

pass 2 — cap
  candidates = listTasksIdleFor(0)        // idle tasks only, LRU-ordered
  while countLiveWorkers() > maxLiveSessions:
    victim = next eligible task in candidates
    if no eligible victim: log 'hibernate_cap_blocked' and break
    hibernate(victim)
```

`countLiveWorkers()` is re-read each iteration rather than decremented, because
`closeTask` is the thing that changes it and re-reading a synchronous
better-sqlite3 count is cheaper than keeping a parallel tally correct.

`eligible(task)` requires all of:

- no attached terminal — `getActiveConnections()` (`terminal.ts:262`), keys are
  `` `${taskId}:${windowIndex}` ``
- `countPendingByTask(id) === 0` — a permission prompt is waiting on the user
- `!isOrchestratorManaged(id)` — same guard `pollQuiescence` uses
- every non-stopped worker reports `hook_activity = 'idle'`

`hibernate(task)` is `await closeTask(task)` followed by stamping
`hibernated_at` and broadcasting `task:updated`. `closeTask` leaves
`workers.status = 'stopped'` with `harness_session_id` intact — precisely what
`relaunchStoppedAgents` consumes. That is why waking is free.

### 3.5 Deliberate limit: the cap is soft

The cap can only evict sessions whose workers report `hook_activity = 'idle'`.
If every live session is mid-turn, the cap is exceeded and the poller logs
`hibernate_cap_blocked` rather than evicting. A cap that kills in-flight turns
to hit a number is worse than no cap.

This is a real ceiling, not an oversight. If a hard cap is ever needed, the
upgrade path is admission control at task-start time (refuse to start the
N+1th session) rather than eviction — but that trades a memory problem for a
scheduling problem and should not be built speculatively.

### 3.6 Wake

Two triggers, both existing paths:

1. **Explicit** — `POST /api/tasks/:id/resume` (`routes/tasks.ts:289`) already
   calls `resumeTask`. It additionally clears `hibernated_at`.
2. **Message** — `routes/task-agents.ts:80` (`sendMessageToAgent`). If
   `hibernated_at` is set, `await resumeTask(task)` first, then re-read the
   worker's **new** `window_index` before sending. Without this, the
   orchestrator and `octomux send-message` write into a dead tmux session and
   the message vanishes silently.

Terminal WebSocket attach deliberately does **not** auto-wake. A 5–10 s await
inside an HTTP upgrade handler is a bad trade when the frontend can POST resume
first and then open the socket.

## 4. Reviews

Review tasks are ordinary tasks — `insertReviewTask` (`review-tasks.ts:135`)
creates a worktree row and a task row with `source: 'auto_review'`, and they run
real workers in a real tmux session. Both poller passes therefore cover them
with **zero** additional server code.

The remaining work is surfacing:

- the reviews inbox reads `hibernated_at` and renders **Sleeping · Wake**
  instead of "Closed"
- Wake posts to the existing `/api/tasks/:id/resume`

A woken review task relaunches its workers with `--resume
<harness_session_id>`, so the review agent retains its full prior context —
walkthrough, drafted comments, playbook.

## 5. Schedules

### 5.1 Why they need more work

Schedule kinds with `execution: 'session'` run through `runSessionVertical`,
which injects `ptySubstrate` (`services/session-vertical-service.ts:31`) — a
bare pty, no tmux, disposed when the session settles. `runAgentSession` mints a
session id at `agent-session/session.ts:302` and then **throws it away**. These
runs are not resumable and not attachable today, at all.

### 5.2 Schema

```sql
ALTER TABLE runs ADD COLUMN harness_session_id TEXT;
ALTER TABLE runs ADD COLUMN workspace_dir TEXT;
```

`runAgentSession` returns the id it minted; `insertRun` records it alongside the
workspace directory the session ran in.

### 5.3 Wake reuses `createChat`

`CreateChatOptions` (`chats.ts:45`) gains one field:

```ts
resumeSessionId?: string;   // → harness.buildResumeCommand() instead of buildLaunchCommand()
```

The only behavioural change inside `createChat` is which command builder
produces `baseCmd`. Everything else — tmux session creation, hook install,
worker row, cwd — is unchanged.

New route:

```
POST /api/runs/:id/resume
  404 if the run has no harness_session_id (pre-migration runs, or a harness
      whose sessionIdMode is not 'orchestrator-assigned')
  → createChat({ cwd: workspace_dir, resumeSessionId, label: `${kind} run` })
  → { chatId }
```

The client then opens the existing chat terminal at `/ws/terminal/chat/:id`. No
new terminal plumbing, no new substrate, no change to the pty runner.

## 6. Surfaces

| place                       | change                                                           |
| --------------------------- | ---------------------------------------------------------------- |
| task list / task detail     | sleeping badge when `hibernated_at` is set, in place of "closed" |
| reviews inbox               | **Sleeping · Wake** action                                       |
| run detail (`/w/:kind/:id`) | **Resume session** action when the run has a session id          |

## 7. Non-goals

Explicitly out of scope, with the condition that would change that:

- **Sandboxing of any kind** (§1.1). Revisit only as an _isolation_ or _remote
  offload_ feature, never as a memory one. If it happens, the seam is
  `ProcessSubstrate` (`agent-session/substrate.ts`).
- **Per-window hibernation** (kill the harness process, keep the tmux window
  and its scrollback). Wakes ~3 s faster and preserves scrollback, but needs a
  new worker state so the UI does not show live workers as "stopped". Add if
  losing scrollback proves annoying in practice.
- **Wake on WebSocket attach** (§3.6).
- **Hard session cap** (§3.5).
- **Hibernating loop tasks.** Excluded by the `runtime_state = 'running'`
  filter and should stay excluded.

## 8. Tests

`server/poller/hibernate.test.ts`, table-driven against `createTestDb()`,
mirroring `quiescence.test.ts`:

- sleeps a task idle past `hibernateIdleMs`
- skips: attached terminal / pending permission prompt / orchestrator-managed /
  `runtime_state = 'looping'` / already hibernated
- cap pass evicts the least-recently-active task when `countLiveWorkers()`
  exceeds `maxLiveSessions`
- a single task with 3 workers counts as 3 against the cap, and is evicted as
  one unit
- cap pass refuses to evict a task whose worker is not idle, and logs instead
- `hibernateIdleMs = 0` and `maxLiveSessions = 0` each disable their pass

`server/chats.test.ts`:

- `resumeSessionId` produces `claude --resume <id>` in the tmux `send-keys`

API (supertest against `createApp()`):

- `POST /api/tasks/:id/resume` on a hibernated task clears `hibernated_at` and
  relaunches workers with `--resume <harness_session_id>`
- `sendMessageToAgent` against a hibernated task wakes it and targets the new
  `window_index`
- `POST /api/runs/:id/resume` 404s when the run has no `harness_session_id`

## 9. Expected result

~100–400 MB reclaimed per sleeping session. On the 14-session snapshot in §1,
where most sessions are well past 30 minutes idle, that is roughly 4–6 GB
returned on a 32 GB machine — without a container, a new dependency, or a cloud
bill.
