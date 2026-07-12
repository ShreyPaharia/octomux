# Loop Harness P1b: Loop Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the P1b loop engine that drives fresh-context Ralph iterations, event-driven off the Stop hook, with a shell-command verifier, auto-commit, and layered termination (done+verify / max_iterations / budget / no_progress / blocked / needs_human).

**Architecture:** `startLoop(taskId, spec)` creates a `loop_runs` row, flips the task to `runtime_state='looping'`, and respawns the task's active agent fresh with the loop prompt (pinning the loop-run id, mirroring how review prompts pin the review-task id). The Claude Code Stop hook is the sole iteration-boundary trigger — no polling. When a looping task's Stop hook fires, `server/hooks.ts` bypasses its normal `human_review`/`task_updates`/`fireHook`/summarizer side effects and calls `handleLoopIterationBoundary(taskId, agentId)`, which auto-commits the worktree, runs the verify command, appends a `loop_iterations` row, evaluates termination, and either closes the loop or respawns fresh for the next iteration. The loop agent authenticates its `octomux emit` CLI call back to `POST /api/loops/:runId/emit` (already merged) via `OCTOMUX_ACTION_TOKEN`/`OCTOMUX_ACTION_BASE_URL` exported directly into its tmux pane's shell environment — a new capability added to the shared launch path.

**Tech Stack:** Express 5, better-sqlite3, node-pty/tmux, vitest, commander (CLI).

## Global Constraints

- `childLogger('<module>')` for all logging; never `console.*`. Every loop log line includes `task_id` and, where relevant, `loop_run_id`/`agent_id`.
- Migrations are forward-only. `loop_runs`/`loop_iterations` tables already exist (P1a) — **no new migration needed** in this plan; every task reuses the existing schema.
- `datetime('now')` stays single-quoted inside template literals.
- Prettier: single quotes, trailing commas, 100-char width, semicolons. Conventional commits, kebab-case scopes, **no `Co-Authored-By`**.
- Reuse, don't rebuild: `respawnAgentFresh`, `loop-runs.ts` repo functions, `checkAgentTokenExists`, `revParseHead`/`checkDirty` (task-engine/git.ts) are already merged (P0/P1a) — this plan extends them additively, it does not re-implement them.
- **Naming deviation from the ticket:** the ticket's CLI spec used `--no-progress <n>`. Commander treats any flag literally starting with `no-` (after the leading `--`) as a boolean negation of the flag with that prefix stripped, and such flags cannot carry a value — `--no-progress <n>` would silently break. This plan uses `--stall-after <n>` instead, mapped to the same `spec.noProgress.afterIters` field. Flag this to the user in the PR body.
- **Termination status reuse:** `LoopRunStatus` (P1a, `server/types.ts`) is the closed enum `'running' | 'done' | 'blocked' | 'needs_human'` — it has no dedicated value for `max_iterations`/`budget`/`no_progress` terminations. This plan does not widen that enum (would touch already-merged P1a code + its tests). Instead, those three terminations close the run with `status='needs_human'` (a human should look) and the specific code (`'max_iterations'`/`'budget'`/`'no_progress'`) goes into `termination_reason`, which was always a free-text column. `'done'`/`'blocked'`/`'needs_human'` terminations set `termination_reason` to that literal short code too (overwriting whatever free-text `reason` the agent's `emit` call supplied — that free text remains readable on `loop_iterations.emit_reason`, which `recordEmit` already stamps on the latest iteration row).

---

### Task 1: `LoopSpec` type

**Files:**

- Modify: `server/types.ts:100-111` (right after the existing `LoopIteration` interface)

**Interfaces:**

- Produces: `LoopSpec { prompt: string; verify: string; maxIterations: number; budget?: { tokens?: number; timeMs?: number }; noProgress?: { afterIters: number } }` — consumed by every later task.

- [ ] **Step 1: Add the type**

Insert immediately after the `LoopIteration` interface (before the trailing `export type CommentBucket = ...` line that currently sits right under it):

```ts
export interface LoopSpec {
  prompt: string;
  verify: string;
  maxIterations: number;
  budget?: { tokens?: number; timeMs?: number };
  noProgress?: { afterIters: number };
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no new errors (this is a pure additive export).

- [ ] **Step 3: Commit**

```bash
git add server/types.ts
git commit -m "feat(loop): add LoopSpec type"
```

---

### Task 2: env-export support in `buildAgentStartupCommand`

This is the fix for the CRITICAL end-to-end wiring requirement: the loop agent's shell must carry `OCTOMUX_ACTION_TOKEN`/`OCTOMUX_ACTION_BASE_URL` so its `octomux emit` CLI call (already merged, reads `process.env.OCTOMUX_ACTION_*`) succeeds. The existing `writeWorkerMcpConfig` env block only reaches the MCP subprocess, not the tmux pane's shell — a `Bash` tool call to `octomux emit` runs as a child of the pane's shell, which never saw those vars. Exporting them at the very start of the startup script fixes this for every consumer of `buildAgentStartupCommand` (harmless no-op for callers that don't pass `env`).

**Files:**

- Modify: `server/task-engine/launch.ts:52-81` (`buildAgentStartupCommand`)
- Test: `server/task-engine/launch.test.ts` (append to the existing `describe('buildAgentStartupCommand', ...)` block, ~line 85 onward)

**Interfaces:**

- Consumes: `shellQuoteSingle` from `../shell-quote.js` (already imported in this file).
- Produces: `buildAgentStartupCommand(args: { baseCmd: string; prompt?: string | null; worktreePath?: string; agentId?: string; env?: Record<string, string> }): string` — the new `env` field is consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('buildAgentStartupCommand', ...)` block in `server/task-engine/launch.test.ts`:

```ts
it('prepends shell-quoted env exports when env is provided', () => {
  const cmd = buildAgentStartupCommand({
    baseCmd: 'claude --session-id abc',
    env: { OCTOMUX_ACTION_TOKEN: 'tok-123', OCTOMUX_ACTION_BASE_URL: 'http://127.0.0.1:7777' },
  });
  expect(cmd).toContain(
    "export OCTOMUX_ACTION_TOKEN='tok-123' OCTOMUX_ACTION_BASE_URL='http://127.0.0.1:7777';",
  );
});

it('omits the export prefix when env is not provided', () => {
  const cmd = buildAgentStartupCommand({ baseCmd: 'claude --session-id abc' });
  expect(cmd).not.toContain('export ');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- server/task-engine/launch.test.ts`
Expected: FAIL — `env` currently does nothing.

- [ ] **Step 3: Implement**

In `server/task-engine/launch.ts`, change the `buildAgentStartupCommand` signature and body:

```ts
export function buildAgentStartupCommand(args: {
  baseCmd: string;
  prompt?: string | null;
  worktreePath?: string;
  agentId?: string;
  env?: Record<string, string>;
}): string {
  let inner = args.baseCmd;
  if (args.prompt && args.worktreePath && args.agentId) {
    const promptFile = path.join(args.worktreePath, `.claude-prompt-${args.agentId}`);
    fs.writeFileSync(promptFile, args.prompt, { mode: 0o600, flag: 'wx' });
    inner += ` -- "$(cat ${shellQuoteSingle(promptFile)})"`;
    setTimeout(() => {
      try {
        fs.unlinkSync(promptFile);
      } catch {
        // already removed or never existed
      }
    }, PROMPT_FILE_CLEANUP_MS);
  }
  if (args.env && Object.keys(args.env).length > 0) {
    const exports = Object.entries(args.env)
      .map(([key, value]) => `${key}=${shellQuoteSingle(value)}`)
      .join(' ');
    inner = `export ${exports}; ${inner}`;
  }
  const shell = process.env.SHELL || '/bin/sh';
  const script = `${inner}; exec ${shell} -i`;
  return `${shell} -ic ${shellQuoteSingle(script)}`;
}
```

(Only the new `env` parameter, the new `if (args.env ...)` block, and the doc comment above the function need touching — everything else is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- server/task-engine/launch.test.ts`
Expected: PASS, full file green (existing tests unaffected — `env` is optional and undefined by default).

- [ ] **Step 5: Commit**

```bash
git add server/task-engine/launch.ts server/task-engine/launch.test.ts
git commit -m "feat(loop): export env vars into agent startup command"
```

---

### Task 3: `respawnAgentFresh` accepts `{ prompt?, env? }`

Fresh-context iterations need a prompt (a fresh harness session has no memory of prior turns) and the emit-auth env. `respawnAgentFresh` currently calls `buildAgentStartupCommand({ baseCmd })` with neither. Add an optional third parameter; existing 2-arg callers (and the existing test suite) are unaffected.

**Files:**

- Modify: `server/task-engine/lifecycle/respawn-agent.ts:25-46`
- Test: `server/task-engine/lifecycle/respawn-agent.test.ts` (append new `it` blocks inside `describe('respawnAgentFresh', ...)`)

**Interfaces:**

- Consumes: `buildAgentStartupCommand` (Task 2's new `env` param).
- Produces: `respawnAgentFresh(task: Task, agent: Agent, opts?: { prompt?: string; env?: Record<string, string> }): Promise<Agent>` — consumed by Task 9 (`startLoop`/`handleLoopIterationBoundary`).

- [ ] **Step 1: Write the failing tests**

Append inside `describe('respawnAgentFresh', ...)` in `server/task-engine/lifecycle/respawn-agent.test.ts`:

```ts
it('passes opts.prompt through to the startup command as a prompt file', async () => {
  const agent = makeAgentRow();
  const task = { ...DEFAULTS.runningTask } as Task;

  await respawnAgentFresh(task, agent, { prompt: 'do the loop thing' });

  const fs = await import('fs');
  expect(fs.writeFileSync).toHaveBeenCalledWith(
    expect.stringContaining(`.claude-prompt-${agent.id}`),
    'do the loop thing',
    expect.anything(),
  );
});

it('exposes a hook token in the startup env that checkAgentTokenExists accepts (loop emit auth)', async () => {
  const agent = makeAgentRow({ hook_token: 'real-hook-token-abc' });
  const task = { ...DEFAULTS.runningTask } as Task;

  await respawnAgentFresh(task, agent, {
    env: {
      OCTOMUX_TASK_ID: task.id,
      OCTOMUX_ACTION_TOKEN: agent.hook_token,
      OCTOMUX_ACTION_BASE_URL: 'http://127.0.0.1:7777',
    },
  });

  const newWindowCall = vi
    .mocked(execFile)
    .mock.calls.find((c) => (c[1] as string[])?.includes('new-window'));
  const startupCmd = (newWindowCall![1] as string[]).at(-1) as string;
  expect(startupCmd).toContain("OCTOMUX_ACTION_TOKEN='real-hook-token-abc'");

  const { checkAgentTokenExists } = await import('../../repositories/agent-runtime.js');
  expect(checkAgentTokenExists('real-hook-token-abc')).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- server/task-engine/lifecycle/respawn-agent.test.ts`
Expected: FAIL — `respawnAgentFresh` ignores the third argument today.

- [ ] **Step 3: Implement**

In `server/task-engine/lifecycle/respawn-agent.ts`, change the signature and the `startupCmd` build:

```ts
export async function respawnAgentFresh(
  task: Task,
  agent: Agent,
  opts?: { prompt?: string; env?: Record<string, string> },
): Promise<Agent> {
  logger.info(
    { task_id: task.id, agent_id: agent.id, operation: 'respawn_fresh' },
    'respawn_fresh: start',
  );

  const harness = getHarness(agent.harness_id);
  const flags = harness.resolveFlags(await getSettings());
  const { sessionIdForDb, sessionIdForLaunch } = computeFreshSessionIds(harness);

  await harness.syncAgents(task.worktree!);
  await syncSkills(task.worktree!);
  await harness.installHooks(task.worktree!, hookBaseUrl(), agent.hook_token);

  const baseCmd = harness.buildLaunchCommand({
    sessionId: sessionIdForLaunch,
    agent: agent.agent,
    flags,
    model: (task as { model?: string | null }).model ?? null,
    workspacePath: task.worktree!,
  });
  const startupCmd = buildAgentStartupCommand({
    baseCmd,
    prompt: opts?.prompt,
    worktreePath: opts?.prompt ? task.worktree! : undefined,
    agentId: opts?.prompt ? agent.id : undefined,
    env: opts?.env,
  });

  // ... rest of the function (oldWindowIndex through the final return) is unchanged.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- server/task-engine/lifecycle/respawn-agent.test.ts`
Expected: PASS, full file green.

- [ ] **Step 5: Commit**

```bash
git add server/task-engine/lifecycle/respawn-agent.ts server/task-engine/lifecycle/respawn-agent.test.ts
git commit -m "feat(loop): respawnAgentFresh accepts a prompt and env for loop iterations"
```

---

### Task 4: `getTaskRuntimeState` repository helper

The Stop hook needs a task's `runtime_state` to decide whether to route to the loop engine; the existing `getTaskWorkflowStatus` only selects `workflow_status`.

**Files:**

- Modify: `server/repositories/tasks.ts` (add next to `getTaskWorkflowStatus`, ~line 582-588)
- Test: `server/repositories/tasks.test.ts` (add new `describe('getTaskRuntimeState', ...)`)

**Interfaces:**

- Produces: `getTaskRuntimeState(id: string): string | undefined` — consumed by Task 10 (`hooks.ts`).

- [ ] **Step 1: Write the failing test**

Add to `server/repositories/tasks.test.ts`:

```ts
describe('getTaskRuntimeState', () => {
  it('returns the runtime_state for an existing task', () => {
    const db = createTestDb();
    insertTask(db, { id: 't1', runtime_state: 'looping' });

    expect(getTaskRuntimeState('t1')).toBe('looping');
  });

  it('returns undefined for an unknown task', () => {
    createTestDb();
    expect(getTaskRuntimeState('nope')).toBeUndefined();
  });
});
```

Add `getTaskRuntimeState` to this test file's existing import from `./tasks.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- server/repositories/tasks.test.ts -t getTaskRuntimeState`
Expected: FAIL — export doesn't exist.

- [ ] **Step 3: Implement**

In `server/repositories/tasks.ts`, right after `getTaskWorkflowStatus`:

```ts
export function getTaskRuntimeState(id: string): string | undefined {
  const row = getDb().prepare(`SELECT runtime_state FROM tasks WHERE id = ?`).get(id) as
    | { runtime_state: string }
    | undefined;
  return row?.runtime_state;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- server/repositories/tasks.test.ts -t getTaskRuntimeState`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/repositories/tasks.ts server/repositories/tasks.test.ts
git commit -m "feat(loop): add getTaskRuntimeState repository helper"
```

---

### Task 5: `loop-runs.ts` repository additions

Three additive functions the engine needs: find the active run for a task, close a run with a canonical reason, and reset a run back to `'running'` when a `'done'` emit's verify fails (so the next Stop hook still finds it via `getActiveLoopRunForTask`).

**Files:**

- Modify: `server/repositories/loop-runs.ts` (append after `recordEmit`)
- Test: `server/repositories/loop-runs.test.ts` (append new `it` blocks inside the existing `describe('loop-runs', ...)`)

**Interfaces:**

- Consumes: `LoopRunStatus` from `../types.js` (already imported in this file as `LoopEmitStatus`; add `LoopRunStatus` to that import).
- Produces:
  - `getActiveLoopRunForTask(taskId: string): LoopRun | undefined`
  - `terminateLoopRun(loopRunId: string, status: LoopRunStatus, terminationReason: string): void`
  - `resumeLoopRun(loopRunId: string): void`
  - all consumed by Task 9 (`engine.ts`).

- [ ] **Step 1: Write the failing tests**

Append inside `describe('loop-runs', ...)` in `server/repositories/loop-runs.test.ts`:

```ts
it('getActiveLoopRunForTask returns the running run for a task', () => {
  const run = createLoopRun({ task_id: TASK_ID, spec_json: '{}' });
  expect(getActiveLoopRunForTask(TASK_ID)?.id).toBe(run.id);
});

it('getActiveLoopRunForTask returns undefined once the run is terminated', () => {
  const run = createLoopRun({ task_id: TASK_ID, spec_json: '{}' });
  terminateLoopRun(run.id, 'needs_human', 'max_iterations');
  expect(getActiveLoopRunForTask(TASK_ID)).toBeUndefined();
});

it('terminateLoopRun sets status and a canonical termination_reason', () => {
  const run = createLoopRun({ task_id: TASK_ID, spec_json: '{}' });
  recordEmit(run.id, { status: 'done', reason: 'agent free-text reason' });

  terminateLoopRun(run.id, 'done', 'done');

  const updated = getLoopRun(run.id);
  expect(updated?.status).toBe('done');
  expect(updated?.termination_reason).toBe('done');
});

it('resumeLoopRun resets status back to running', () => {
  const run = createLoopRun({ task_id: TASK_ID, spec_json: '{}' });
  recordEmit(run.id, { status: 'done', reason: 'verify failed after this' });

  resumeLoopRun(run.id);

  expect(getLoopRun(run.id)?.status).toBe('running');
  expect(getActiveLoopRunForTask(TASK_ID)?.id).toBe(run.id);
});
```

Update this file's import line to:

```ts
import {
  createLoopRun,
  getLoopRun,
  appendIteration,
  recordEmit,
  getActiveLoopRunForTask,
  terminateLoopRun,
  resumeLoopRun,
} from './loop-runs.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- server/repositories/loop-runs.test.ts`
Expected: FAIL — the three exports don't exist.

- [ ] **Step 3: Implement**

Append to `server/repositories/loop-runs.ts` (after `recordEmit`), and widen the type import at the top from `LoopEmitStatus` to also include `LoopRunStatus`:

```ts
import type { LoopRun, LoopIteration, LoopEmitStatus, LoopRunStatus } from '../types.js';
```

```ts
/** Most recent still-'running' loop_run for a task, if any. */
export function getActiveLoopRunForTask(taskId: string): LoopRun | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM loop_runs WHERE task_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(taskId) as LoopRun | undefined;
}

/** Close a loop_run with a final status + canonical short-code termination_reason. */
export function terminateLoopRun(
  loopRunId: string,
  status: LoopRunStatus,
  terminationReason: string,
): void {
  getDb()
    .prepare(
      `UPDATE loop_runs SET status = ?, termination_reason = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(status, terminationReason, loopRunId);
  logger.info(
    { loop_run_id: loopRunId, status, termination_reason: terminationReason },
    'loop_run terminated',
  );
}

/** Reset a loop_run's status back to 'running' (e.g. a 'done' emit whose verify then failed). */
export function resumeLoopRun(loopRunId: string): void {
  getDb()
    .prepare(`UPDATE loop_runs SET status = 'running', updated_at = datetime('now') WHERE id = ?`)
    .run(loopRunId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- server/repositories/loop-runs.test.ts`
Expected: PASS, full file green.

- [ ] **Step 5: Commit**

```bash
git add server/repositories/loop-runs.ts server/repositories/loop-runs.test.ts
git commit -m "feat(loop): add getActiveLoopRunForTask, terminateLoopRun, resumeLoopRun"
```

---

### Task 6: `commitAll` in `server/task-engine/git.ts`

The engine needs a stage-and-commit-if-dirty helper. `server/task-engine/git.ts` already has `checkDirty(repoPath): Promise<string[]>` (via `git status --porcelain=v1`) and `revParseHead(cwd, ref='HEAD')` — reuse both rather than duplicating a preflight-style diff check. (Do **not** touch `preflightWorktree` in `start-task.ts` — it has its own passing tests pinned to `git diff --name-only`; refactoring it is out of scope and risks breaking those tests for no benefit here.)

**Files:**

- Modify: `server/task-engine/git.ts` (append after `checkDirty`)
- Modify: `server/task-engine/index.ts:19-31` (add `commitAll` to the re-exported list from `./git.js`)
- Test: `server/task-engine/git.test.ts` (append new `describe('commitAll', ...)`)

**Interfaces:**

- Consumes: `checkDirty` (same file).
- Produces: `commitAll(cwd: string, message: string): Promise<boolean>` (`true` = committed, `false` = worktree was clean) — consumed by Task 9 (`engine.ts`), and `revParseHead` (already existed) is also consumed there directly.

- [ ] **Step 1: Write the failing tests**

Append to `server/task-engine/git.test.ts`, and add `commitAll` to the existing destructured `await import('./git.js')` line at the top:

```ts
describe('commitAll', () => {
  it('commits when the worktree is dirty', async () => {
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      args: string[],
      optsOrCb: Function | object,
      maybeCb?: Function,
    ) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
      if (args.includes('status') && args.some((a) => a.startsWith('--porcelain'))) {
        cb(null, { stdout: ' M src/foo.ts\n', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    }) as any);

    const committed = await commitAll('/repo/wt', 'loop(run1): iteration 1');
    expect(committed).toBe(true);

    expect(
      findExecCall(vi.mocked(execFile), { cmd: 'git', argsInclude: ['add', '-A'] }),
    ).toBeDefined();
    expect(
      findExecCall(vi.mocked(execFile), {
        cmd: 'git',
        argsInclude: ['commit', '-m', 'loop(run1): iteration 1'],
      }),
    ).toBeDefined();
  });

  it('skips commit when the worktree is clean', async () => {
    // default mock (top of file) already returns empty --porcelain output
    const committed = await commitAll('/repo/wt', 'loop(run1): iteration 1');
    expect(committed).toBe(false);
    expect(
      findExecCall(vi.mocked(execFile), { cmd: 'git', argsInclude: ['add', '-A'] }),
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- server/task-engine/git.test.ts`
Expected: FAIL — `commitAll` doesn't exist.

- [ ] **Step 3: Implement**

Append to `server/task-engine/git.ts`, after `checkDirty`:

```ts
/** Stage and commit all changes if the worktree is dirty. Returns false (no-op) when clean. */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
  const dirty = await checkDirty(cwd);
  if (dirty.length === 0) return false;
  await execFile('git', ['-C', cwd, 'add', '-A']);
  await execFile('git', ['-C', cwd, 'commit', '-m', message]);
  return true;
}
```

Then in `server/task-engine/index.ts`, add `commitAll` to the git.js export list:

```ts
export {
  validateRepo,
  revParseHead,
  getRemoteOriginUrl,
  hashObject,
  fetchOriginQuiet,
  checkoutRef,
  isAncestor,
  checkDirty,
  gitBranchExists,
  addWorktreeWithBranch,
  slugifyTitle,
  commitAll,
} from './git.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- server/task-engine/git.test.ts`
Expected: PASS, full file green.

- [ ] **Step 5: Commit**

```bash
git add server/task-engine/git.ts server/task-engine/index.ts server/task-engine/git.test.ts
git commit -m "feat(loop): add commitAll git helper"
```

---

### Task 7: `runVerify`

**Files:**

- Create: `server/task-engine/loop/verify.ts`
- Test: Create `server/task-engine/loop/verify.test.ts`

**Interfaces:**

- Produces: `runVerify(cwd: string, cmd: string): Promise<{ passed: boolean; output: string }>` — consumed by Task 9 (`engine.ts`).

- [ ] **Step 1: Write the failing test**

Create `server/task-engine/loop/verify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runVerify } from './verify.js';

describe('runVerify', () => {
  it('passes when the command exits 0', async () => {
    const result = await runVerify(process.cwd(), 'echo hello');
    expect(result.passed).toBe(true);
    expect(result.output).toContain('hello');
  });

  it('fails with captured output when the command exits non-zero', async () => {
    const result = await runVerify(process.cwd(), 'echo boom >&2; exit 1');
    expect(result.passed).toBe(false);
    expect(result.output).toContain('boom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- server/task-engine/loop/verify.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `server/task-engine/loop/verify.ts`:

```ts
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

export interface VerifyResult {
  passed: boolean;
  output: string;
}

/** Run the loop's verify shell command in `cwd`; exit 0 = pass. */
export async function runVerify(cwd: string, cmd: string): Promise<VerifyResult> {
  try {
    const { stdout, stderr } = await execFile('sh', ['-c', cmd], { cwd });
    return { passed: true, output: stdout + stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const output = [e.stdout, e.stderr].filter(Boolean).join('') || e.message;
    return { passed: false, output };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- server/task-engine/loop/verify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/task-engine/loop/verify.ts server/task-engine/loop/verify.test.ts
git commit -m "feat(loop): add runVerify"
```

---

### Task 8: loop engine — pure termination policy + prompt builder

Split out first because these are pure functions, testable with zero mocking, and everything in Task 9 depends on them.

**Files:**

- Create: `server/task-engine/loop/engine.ts` (this task writes the top portion only: types, `buildLoopPrompt`, `evaluateTermination`, and private helpers)
- Test: Create `server/task-engine/loop/engine.test.ts` (this task writes the pure-function tests only)

**Interfaces:**

- Consumes: `LoopSpec`, `LoopRun`, `LoopIteration`, `LoopRunStatus` from `../../types.js`.
- Produces:
  - `TerminationReason = 'done' | 'blocked' | 'needs_human' | 'max_iterations' | 'budget' | 'no_progress'`
  - `buildLoopPrompt(spec: LoopSpec, loopRunId: string, verifyFailureOutput?: string | null): string`
  - `evaluateTermination(ctx: { run: LoopRun; spec: LoopSpec; verifyPassed: boolean; iterationN: number; noProgressStreak: number; tokensUsed: number; now: number }): TerminationReason | null`
  - both consumed by Task 9 (same file) and by Task 9's integration tests.

- [ ] **Step 1: Write the failing tests**

Create `server/task-engine/loop/engine.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildLoopPrompt, evaluateTermination } from './engine.js';
import type { LoopRun, LoopSpec } from '../../types.js';

function makeRun(overrides: Partial<LoopRun> = {}): LoopRun {
  return {
    id: 'run-1',
    task_id: 't1',
    spec_json: '{}',
    status: 'running',
    iteration: 0,
    max_iterations: null,
    budget_json: null,
    termination_reason: null,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

const SPEC: LoopSpec = { prompt: 'do it', verify: 'true', maxIterations: 5 };

describe('buildLoopPrompt', () => {
  it('pins the loop run id and the emit instruction', () => {
    const prompt = buildLoopPrompt(SPEC, 'run-1');
    expect(prompt).toContain('do it');
    expect(prompt).toContain('Loop run id: run-1');
    expect(prompt).toContain('octomux emit --run run-1');
  });

  it('appends the failing verify output when provided', () => {
    const prompt = buildLoopPrompt(SPEC, 'run-1', 'test failed: assertion error');
    expect(prompt).toContain('test failed: assertion error');
  });

  it('omits the verify-failure section when there is none', () => {
    const prompt = buildLoopPrompt(SPEC, 'run-1', null);
    expect(prompt).not.toContain('verify command failed');
  });
});

describe('evaluateTermination', () => {
  const base = {
    spec: SPEC,
    verifyPassed: false,
    iterationN: 1,
    noProgressStreak: 0,
    tokensUsed: 0,
    now: Date.parse('2026-01-01T00:00:00Z'),
  };

  it('does not terminate on a plain running iteration', () => {
    expect(evaluateTermination({ ...base, run: makeRun() })).toBeNull();
  });

  it('terminates done only when status is done AND verify passed', () => {
    expect(
      evaluateTermination({ ...base, run: makeRun({ status: 'done' }), verifyPassed: false }),
    ).toBeNull();
    expect(
      evaluateTermination({ ...base, run: makeRun({ status: 'done' }), verifyPassed: true }),
    ).toBe('done');
  });

  it('terminates blocked/needs_human regardless of verify', () => {
    expect(evaluateTermination({ ...base, run: makeRun({ status: 'blocked' }) })).toBe('blocked');
    expect(evaluateTermination({ ...base, run: makeRun({ status: 'needs_human' }) })).toBe(
      'needs_human',
    );
  });

  it('terminates max_iterations once iterationN reaches spec.maxIterations', () => {
    expect(evaluateTermination({ ...base, run: makeRun(), iterationN: 5 })).toBe('max_iterations');
    expect(evaluateTermination({ ...base, run: makeRun(), iterationN: 4 })).toBeNull();
  });

  it('terminates budget on token ceiling', () => {
    const spec: LoopSpec = { ...SPEC, budget: { tokens: 1000 } };
    expect(evaluateTermination({ ...base, spec, run: makeRun(), tokensUsed: 1000 })).toBe('budget');
    expect(evaluateTermination({ ...base, spec, run: makeRun(), tokensUsed: 999 })).toBeNull();
  });

  it('terminates budget on elapsed wall-clock time', () => {
    const spec: LoopSpec = { ...SPEC, budget: { timeMs: 60_000 } };
    const run = makeRun({ created_at: '2026-01-01 00:00:00' });
    const justUnder = Date.parse('2026-01-01T00:00:59Z');
    const atLimit = Date.parse('2026-01-01T00:01:00Z');
    expect(evaluateTermination({ ...base, spec, run, now: justUnder })).toBeNull();
    expect(evaluateTermination({ ...base, spec, run, now: atLimit })).toBe('budget');
  });

  it('terminates no_progress once the streak reaches spec.noProgress.afterIters', () => {
    const spec: LoopSpec = { ...SPEC, noProgress: { afterIters: 3 } };
    expect(evaluateTermination({ ...base, spec, run: makeRun(), noProgressStreak: 3 })).toBe(
      'no_progress',
    );
    expect(evaluateTermination({ ...base, spec, run: makeRun(), noProgressStreak: 2 })).toBeNull();
  });

  it('skips no_progress evaluation when spec.noProgress is not set', () => {
    expect(evaluateTermination({ ...base, run: makeRun(), noProgressStreak: 999 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- server/task-engine/loop/engine.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `server/task-engine/loop/engine.ts` with this content (Task 9 appends more below this same file — do not add `startLoop`/`handleLoopIterationBoundary` yet):

````ts
import { childLogger } from '../../logger.js';
import type { LoopRun, LoopIteration, LoopSpec } from '../../types.js';

const logger = childLogger('task-engine/loop');

export type TerminationReason =
  | 'done'
  | 'blocked'
  | 'needs_human'
  | 'max_iterations'
  | 'budget'
  | 'no_progress';

function loopRunIdLines(loopRunId: string): string[] {
  return [
    `Loop run id: ${loopRunId}`,
    `When your turn ends, report status: octomux emit --run ${loopRunId} --status <done|blocked|needs_human> --reason "<why>"`,
  ];
}

/** Build the prompt for a loop iteration, pinning the loop run id (mirrors reviewTaskIdLines in review-tasks.ts). */
export function buildLoopPrompt(
  spec: LoopSpec,
  loopRunId: string,
  verifyFailureOutput?: string | null,
): string {
  const lines = [spec.prompt, '', ...loopRunIdLines(loopRunId)];
  if (verifyFailureOutput) {
    lines.push(
      '',
      "The previous iteration's verify command failed. Fix it and continue:",
      '```',
      verifyFailureOutput.trim().slice(0, 4000),
      '```',
    );
  }
  return lines.join('\n');
}

function parseSqliteUtc(ts: string): number {
  return new Date(ts.replace(' ', 'T') + 'Z').getTime();
}

export function trailingNoProgressStreak(iterations: LoopIteration[]): number {
  let count = 0;
  for (let i = iterations.length - 1; i >= 0; i--) {
    if (iterations[i].sha_from === iterations[i].sha_to) count++;
    else break;
  }
  return count;
}

export function sumTokens(iterations: LoopIteration[]): number {
  return iterations.reduce((sum, it) => sum + (it.tokens ?? 0), 0);
}

export interface TerminationCtx {
  run: LoopRun;
  spec: LoopSpec;
  verifyPassed: boolean;
  iterationN: number;
  noProgressStreak: number;
  tokensUsed: number;
  now: number;
}

function isBudgetExhausted(ctx: TerminationCtx): boolean {
  const budget = ctx.spec.budget;
  if (!budget) return false;
  // ponytail: no per-turn token-usage signal is wired from the harness today, so
  // the tokens ceiling only trips once a future emit path populates
  // loop_iterations.tokens. timeMs is measurable today via loop_runs.created_at.
  if (budget.tokens != null && ctx.tokensUsed >= budget.tokens) return true;
  if (budget.timeMs != null) {
    const startedAt = parseSqliteUtc(ctx.run.created_at);
    if (ctx.now - startedAt >= budget.timeMs) return true;
  }
  return false;
}

/** Pure termination policy: stop on ANY of done+verified / blocked / needs_human / max_iterations / budget / no_progress. */
export function evaluateTermination(ctx: TerminationCtx): TerminationReason | null {
  if (ctx.run.status === 'blocked') return 'blocked';
  if (ctx.run.status === 'needs_human') return 'needs_human';
  if (ctx.run.status === 'done' && ctx.verifyPassed) return 'done';
  if (ctx.iterationN >= ctx.spec.maxIterations) return 'max_iterations';
  if (isBudgetExhausted(ctx)) return 'budget';
  if (ctx.spec.noProgress && ctx.noProgressStreak >= ctx.spec.noProgress.afterIters) {
    return 'no_progress';
  }
  return null;
}

// logger is used by startLoop/handleLoopIterationBoundary, added in the next task.
void logger;
````

(The trailing `void logger;` is a placeholder to keep this file lint-clean between this task and the next — Task 9 removes it when it adds real `logger.info`/`logger.warn` calls.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- server/task-engine/loop/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/task-engine/loop/engine.ts server/task-engine/loop/engine.test.ts
git commit -m "feat(loop): add loop prompt builder and termination policy"
```

---

### Task 9: `startLoop` + `handleLoopIterationBoundary`

**Files:**

- Modify: `server/task-engine/loop/engine.ts` (append below Task 8's content; remove the `void logger;` placeholder)
- Modify: `server/task-engine/loop/engine.test.ts` (append integration-style tests)

**Interfaces:**

- Consumes: `getTask`, `setRuntimeState` (`../../repositories/tasks.js`); `getAgent`, `findFirstActiveAgent` (`../../repositories/agent-runtime.js`); `createLoopRun`, `getActiveLoopRunForTask`, `appendIteration`, `listIterationsForRun`, `terminateLoopRun`, `resumeLoopRun` (`../../repositories/loop-runs.js`, Task 5); `revParseHead`, `commitAll` (`../git.js`, Task 6); `runVerify` (`./verify.js`, Task 7); `respawnAgentFresh` (`../lifecycle/respawn-agent.js`, Task 3); `broadcast` (`../../events.js`); `hookBaseUrl` (`../../hook-base-url.js`).
- Produces:
  - `startLoop(taskId: string, spec: LoopSpec): Promise<LoopRun>` — consumed by Task 11 (`POST /api/loops`).
  - `handleLoopIterationBoundary(taskId: string, agentId: string): Promise<void>` — consumed by Task 10 (Stop hook).

- [ ] **Step 1: Write the failing tests**

Append to `server/task-engine/loop/engine.test.ts`. This needs its own mocks — add them at the very top of the file, above the existing pure-function tests (vitest hoists `vi.mock` calls, so placement in the file doesn't matter, but keep them together at the top for readability):

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, insertTask, insertAgent, DEFAULTS } from '../../test-helpers.js';

vi.mock('../git.js', () => ({
  revParseHead: vi.fn(),
  commitAll: vi.fn(async () => true),
}));
vi.mock('./verify.js', () => ({
  runVerify: vi.fn(),
}));
vi.mock('../lifecycle/respawn-agent.js', () => ({
  respawnAgentFresh: vi.fn(async (_task, agent) => agent),
}));
vi.mock('../../events.js', () => ({
  broadcast: vi.fn(),
}));
vi.mock('../../hook-base-url.js', () => ({
  hookBaseUrl: vi.fn(() => 'http://127.0.0.1:7777'),
}));

const { startLoop, handleLoopIterationBoundary } = await import('./engine.js');
const { revParseHead, commitAll } = await import('../git.js');
const { runVerify } = await import('./verify.js');
const { respawnAgentFresh } = await import('../lifecycle/respawn-agent.js');
const { getLoopRun, listIterationsForRun } = await import('../../repositories/loop-runs.js');

const SPEC: LoopSpec = { prompt: 'fix the bug', verify: 'bun run test', maxIterations: 5 };

describe('startLoop', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
    insertTask(db, { ...DEFAULTS.runningTask, id: 't1', runtime_state: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', hook_token: 'tok-1', status: 'running' } as any);
  });

  it('creates a running loop_run, flips runtime_state to looping, and respawns fresh', async () => {
    const run = await startLoop('t1', SPEC);

    expect(run.task_id).toBe('t1');
    expect(run.status).toBe('running');

    const task = db.prepare('SELECT runtime_state FROM tasks WHERE id = ?').get('t1') as {
      runtime_state: string;
    };
    expect(task.runtime_state).toBe('looping');

    expect(respawnAgentFresh).toHaveBeenCalledTimes(1);
    const [, , opts] = vi.mocked(respawnAgentFresh).mock.calls[0];
    expect(opts?.prompt).toContain(`Loop run id: ${run.id}`);
    expect(opts?.env).toMatchObject({ OCTOMUX_ACTION_TOKEN: 'tok-1', OCTOMUX_TASK_ID: 't1' });
  });

  it('throws when the task has no active agent', async () => {
    db.prepare(`UPDATE agents SET status = 'stopped' WHERE id = 'a1'`).run();
    await expect(startLoop('t1', SPEC)).rejects.toThrow(/no active agent/);
  });
});

describe('handleLoopIterationBoundary', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
    insertTask(db, { ...DEFAULTS.runningTask, id: 't1', runtime_state: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', hook_token: 'tok-1', status: 'running' } as any);
  });

  it('respawns while verify fails, terminates done once verify passes', async () => {
    let sha = 0;
    vi.mocked(revParseHead).mockImplementation(async () => `sha${sha++}`);
    vi.mocked(runVerify)
      .mockResolvedValueOnce({ passed: false, output: 'fail 1' })
      .mockResolvedValueOnce({ passed: false, output: 'fail 2' })
      .mockResolvedValueOnce({ passed: true, output: 'ok' });

    const run = await startLoop('t1', SPEC);
    const { recordEmit } = await import('../../repositories/loop-runs.js');

    recordEmit(run.id, { status: 'done', reason: 'iter1' });
    await handleLoopIterationBoundary('t1', 'a1');
    expect(respawnAgentFresh).toHaveBeenCalledTimes(2); // startLoop's + this one

    recordEmit(run.id, { status: 'done', reason: 'iter2' });
    await handleLoopIterationBoundary('t1', 'a1');
    expect(respawnAgentFresh).toHaveBeenCalledTimes(3);

    recordEmit(run.id, { status: 'done', reason: 'iter3' });
    await handleLoopIterationBoundary('t1', 'a1');
    expect(respawnAgentFresh).toHaveBeenCalledTimes(3); // not called again — terminated

    const finalRun = getLoopRun(run.id);
    expect(finalRun?.status).toBe('done');
    expect(finalRun?.termination_reason).toBe('done');

    const iterations = listIterationsForRun(run.id);
    expect(iterations).toHaveLength(3);
    expect(iterations.every((it) => it.verify_passed !== null)).toBe(true);

    const task = db.prepare('SELECT runtime_state FROM tasks WHERE id = ?').get('t1') as {
      runtime_state: string;
    };
    expect(task.runtime_state).toBe('idle');
  });

  it('terminates max_iterations once the cap is hit, without waiting for a done emit', async () => {
    vi.mocked(revParseHead).mockImplementation(async () => 'stable-sha');
    vi.mocked(runVerify).mockResolvedValue({ passed: false, output: 'still failing' });

    const run = await startLoop('t1', { ...SPEC, maxIterations: 2 });

    await handleLoopIterationBoundary('t1', 'a1');
    expect(getLoopRun(run.id)?.termination_reason).toBeNull();

    await handleLoopIterationBoundary('t1', 'a1');
    const finalRun = getLoopRun(run.id);
    expect(finalRun?.termination_reason).toBe('max_iterations');
    expect(finalRun?.status).toBe('needs_human');
  });

  it('terminates no_progress after N consecutive no-op commits', async () => {
    vi.mocked(revParseHead).mockImplementation(async () => 'same-sha-every-time');
    vi.mocked(commitAll).mockResolvedValue(false); // nothing to commit
    vi.mocked(runVerify).mockResolvedValue({ passed: false, output: 'nothing changed' });

    const run = await startLoop('t1', {
      ...SPEC,
      maxIterations: 10,
      noProgress: { afterIters: 2 },
    });

    await handleLoopIterationBoundary('t1', 'a1');
    expect(getLoopRun(run.id)?.termination_reason).toBeNull();

    await handleLoopIterationBoundary('t1', 'a1');
    const finalRun = getLoopRun(run.id);
    expect(finalRun?.termination_reason).toBe('no_progress');
  });

  it('checks budget before respawning', async () => {
    vi.mocked(revParseHead).mockImplementation(async () => `sha-${Math.random()}`);
    vi.mocked(runVerify).mockResolvedValue({ passed: false, output: 'still working' });

    const run = await startLoop('t1', { ...SPEC, maxIterations: 100, budget: { timeMs: 1 } });
    // Backdate created_at so the 1ms budget is already exhausted by the time
    // the boundary handler runs.
    db.prepare(`UPDATE loop_runs SET created_at = datetime('now', '-1 hour') WHERE id = ?`).run(
      run.id,
    );

    const callsBefore = vi.mocked(respawnAgentFresh).mock.calls.length;
    await handleLoopIterationBoundary('t1', 'a1');

    expect(vi.mocked(respawnAgentFresh).mock.calls.length).toBe(callsBefore); // no new respawn
    expect(getLoopRun(run.id)?.termination_reason).toBe('budget');
  });
});
```

Add `import type { LoopSpec } from '../../types.js';` near the top of the test file if not already present from Task 8.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- server/task-engine/loop/engine.test.ts`
Expected: FAIL — `startLoop`/`handleLoopIterationBoundary` don't exist yet.

- [ ] **Step 3: Implement**

Remove the `void logger;` placeholder line from the bottom of `server/task-engine/loop/engine.ts` and append instead:

```ts
import { getTask, setRuntimeState } from '../../repositories/tasks.js';
import { getAgent, findFirstActiveAgent } from '../../repositories/agent-runtime.js';
import {
  createLoopRun,
  getActiveLoopRunForTask,
  appendIteration,
  listIterationsForRun,
  terminateLoopRun,
  resumeLoopRun,
} from '../../repositories/loop-runs.js';
import { revParseHead, commitAll } from '../git.js';
import { runVerify } from './verify.js';
import { respawnAgentFresh } from '../lifecycle/respawn-agent.js';
import { broadcast } from '../../events.js';
import { hookBaseUrl } from '../../hook-base-url.js';
import type { LoopRun, LoopRunStatus } from '../../types.js';
```

(add these imports at the top of the file, alongside the existing `childLogger`/`LoopIteration`/`LoopSpec` imports from Task 8)

```ts
function loopAgentEnv(taskId: string, hookToken: string): Record<string, string> {
  return {
    OCTOMUX_TASK_ID: taskId,
    OCTOMUX_ACTION_TOKEN: hookToken,
    OCTOMUX_ACTION_BASE_URL: hookBaseUrl(),
  };
}

/** Statuses that close a loop_run; non-emit terminations reuse 'needs_human' — the closed LoopRunStatus enum has no dedicated value for them (see plan Global Constraints). */
function finalStatusFor(reason: TerminationReason): LoopRunStatus {
  return reason === 'done' || reason === 'blocked' || reason === 'needs_human'
    ? reason
    : 'needs_human';
}

/**
 * Kick off a loop: create the loop_run, flip the task into 'looping', and
 * launch iteration 1 as a fresh-context respawn of the task's active agent
 * with the loop prompt (pinning the loop run id, mirroring how review prompts
 * pin the review-task id).
 */
export async function startLoop(taskId: string, spec: LoopSpec): Promise<LoopRun> {
  const task = getTask(taskId);
  if (!task) throw new Error(`startLoop: task not found: ${taskId}`);

  const agentRef = findFirstActiveAgent(taskId);
  if (!agentRef) throw new Error(`startLoop: no active agent for task ${taskId}`);
  const agent = getAgent(agentRef.id);
  if (!agent) throw new Error(`startLoop: agent not found: ${agentRef.id}`);

  const run = createLoopRun({
    task_id: taskId,
    spec_json: JSON.stringify(spec),
    max_iterations: spec.maxIterations,
    budget_json: spec.budget ? JSON.stringify(spec.budget) : null,
  });

  setRuntimeState(taskId, 'looping');

  await respawnAgentFresh(task, agent, {
    prompt: buildLoopPrompt(spec, run.id),
    env: loopAgentEnv(taskId, agent.hook_token),
  });

  logger.info({ task_id: taskId, loop_run_id: run.id }, 'loop: started');
  broadcast({ type: 'task:updated', payload: { taskId } });

  return run;
}

/**
 * Iteration boundary, called from the Stop hook when the task is looping.
 * Auto-commits, verifies, records the iteration, evaluates termination, and
 * either closes the loop or respawns the agent fresh for the next iteration.
 */
export async function handleLoopIterationBoundary(taskId: string, agentId: string): Promise<void> {
  const run = getActiveLoopRunForTask(taskId);
  if (!run) {
    logger.warn({ task_id: taskId, agent_id: agentId }, 'loop: no active run for looping task');
    return;
  }
  const task = getTask(taskId);
  const agent = getAgent(agentId);
  if (!task || !agent || !task.worktree) {
    logger.warn({ task_id: taskId, agent_id: agentId }, 'loop: task/agent/worktree missing');
    return;
  }

  const spec = JSON.parse(run.spec_json) as LoopSpec;
  const worktree = task.worktree;

  const shaFrom = await revParseHead(worktree);
  await commitAll(worktree, `loop(${run.id}): iteration ${run.iteration + 1}`);
  const shaTo = await revParseHead(worktree);

  const verify = await runVerify(worktree, spec.verify);

  const iteration = appendIteration(run.id, {
    sha_from: shaFrom,
    sha_to: shaTo,
    verify_passed: verify.passed ? 1 : 0,
  });

  const iterations = listIterationsForRun(run.id);
  const reason = evaluateTermination({
    run,
    spec,
    verifyPassed: verify.passed,
    iterationN: iteration.n,
    noProgressStreak: trailingNoProgressStreak(iterations),
    tokensUsed: sumTokens(iterations),
    now: Date.now(),
  });

  if (reason) {
    terminateLoopRun(run.id, finalStatusFor(reason), reason);
    setRuntimeState(taskId, 'idle');
    logger.info(
      { task_id: taskId, loop_run_id: run.id, termination_reason: reason },
      'loop: terminated',
    );
    broadcast({ type: 'task:updated', payload: { taskId } });
    return;
  }

  resumeLoopRun(run.id);
  await respawnAgentFresh(task, agent, {
    prompt: buildLoopPrompt(spec, run.id, verify.passed ? null : verify.output),
    env: loopAgentEnv(taskId, agent.hook_token),
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- server/task-engine/loop/engine.test.ts`
Expected: PASS, full file green.

- [ ] **Step 5: Commit**

```bash
git add server/task-engine/loop/engine.ts server/task-engine/loop/engine.test.ts
git commit -m "feat(loop): startLoop + handleLoopIterationBoundary"
```

---

### Task 10: Stop hook loop guard

**Files:**

- Modify: `server/hooks.ts:316-389` (the `POST /api/hooks/stop` handler)
- Test: Create `server/hooks.loop.test.ts`

**Interfaces:**

- Consumes: `getTaskRuntimeState` (`./repositories/tasks.js`, Task 4); `handleLoopIterationBoundary` (`./task-engine/loop/engine.js`, Task 9).

- [ ] **Step 1: Write the failing test**

Create `server/hooks.loop.test.ts`:

```ts
/**
 * Loop harness: Stop hook guard tests.
 *
 * Verifies POST /api/hooks/stop dispatches to the loop engine — and bypasses
 * human_review/task_updates/fireHook/summarizer entirely — when the stopping
 * agent's task has runtime_state='looping'. A non-looping task keeps the
 * existing B4 behavior unchanged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createTestDb, insertTask, insertAgent } from './test-helpers.js';
import { createApp } from './app.js';

vi.mock('./hook-dispatcher.js', () => ({
  fireHook: vi.fn(),
  getTaskHookExecutions: vi.fn(async () => []),
}));

vi.mock('./task-engine/loop/engine.js', () => ({
  handleLoopIterationBoundary: vi.fn(async () => undefined),
}));

vi.mock('./summarize.js', () => ({
  summarizeAgentProgress: vi.fn(async () => undefined),
}));

describe('Stop hook: loop guard', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    app = createApp();
  });

  it.each([{ runtime_state: 'looping' as const }, { runtime_state: 'running' as const }])(
    'runtime_state=$runtime_state',
    async ({ runtime_state }) => {
      insertTask(db, { id: 't1', runtime_state, workflow_status: 'in_progress' });
      insertAgent(db, {
        id: 'a1',
        task_id: 't1',
        harness_session_id: 'sess-123',
        hook_token: 'tok-loop',
        status: 'running',
      } as any);

      const { handleLoopIterationBoundary } = await import('./task-engine/loop/engine.js');
      const { fireHook } = await import('./hook-dispatcher.js');
      const { summarizeAgentProgress } = await import('./summarize.js');

      await request(app)
        .post('/api/hooks/stop?token=tok-loop')
        .send({ session_id: 'sess-123' })
        .expect(200);

      const task = db.prepare('SELECT workflow_status FROM tasks WHERE id = ?').get('t1') as {
        workflow_status: string;
      };
      const update = db
        .prepare(`SELECT * FROM task_updates WHERE task_id = 't1' AND kind = 'transition'`)
        .get();

      if (runtime_state === 'looping') {
        expect(handleLoopIterationBoundary).toHaveBeenCalledWith('t1', 'a1');
        expect(task.workflow_status).toBe('in_progress');
        expect(update).toBeUndefined();
        expect(fireHook).not.toHaveBeenCalled();
        expect(summarizeAgentProgress).not.toHaveBeenCalled();
      } else {
        expect(handleLoopIterationBoundary).not.toHaveBeenCalled();
        expect(task.workflow_status).toBe('human_review');
        expect(update).not.toBeUndefined();
        expect(fireHook).toHaveBeenCalled();
        expect(summarizeAgentProgress).toHaveBeenCalled();
      }
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- server/hooks.loop.test.ts`
Expected: FAIL — the loop branch doesn't exist yet, so the `looping` case asserts on unreached mocks / the guard call never happens.

- [ ] **Step 3: Implement**

In `server/hooks.ts`, add to the existing `import { ... } from './repositories/tasks.js';` block (around line 33-39) the new `getTaskRuntimeState`:

```ts
import {
  getTaskWorkflowStatus,
  getTaskRuntimeState,
  getWorktreePathForTask,
  setWorkflowStatus,
  addTaskUpdate,
  setCurrentSummary,
} from './repositories/tasks.js';
```

Add a new top-level import:

```ts
import { handleLoopIterationBoundary } from './task-engine/loop/engine.js';
```

In the `POST /stop` handler (currently `server/hooks.ts:316-389`), insert the guard right after the existing `inTransaction(...)` block and before the `// B4: Auto-transition...` comment:

```ts
inTransaction(() => {
  // Resolve ALL pending prompts for this agent
  resolveAgentPermissionPrompts(agent.id);

  setAgentHookActivity(agent.id, 'idle');
});

// Loop harness: a looping task's Stop hook marks an iteration boundary, not
// a normal turn end — bypass human_review/task_updates/fireHook/summarizer
// entirely and hand off to the loop engine instead.
if (getTaskRuntimeState(agent.task_id) === 'looping') {
  void handleLoopIterationBoundary(agent.task_id, agent.id).catch((err) => {
    logger.error(
      { task_id: agent.task_id, agent_id: agent.id, operation: 'loop_iteration_boundary', err },
      'loop: iteration boundary handler failed',
    );
  });
  res.status(200).send();
  return;
}

// B4: Auto-transition in_progress → human_review when the last agent stops.
```

(Everything below — the existing `const task = getTaskWorkflowStatus(...)` through the end of the handler — is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- server/hooks.loop.test.ts`
Expected: PASS.

Also run the full hooks suite to confirm no regression:
Run: `bun run test -- server/hooks.test.ts server/hooks.b4.test.ts server/hooks.user-resume.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/hooks.ts server/hooks.loop.test.ts
git commit -m "feat(loop): Stop hook bypasses human_review path for looping tasks"
```

---

### Task 11: `POST /api/loops`

**Files:**

- Modify: `server/routes/loops.ts`
- Test: Modify `server/api.loops.test.ts` (add mocks at top + a new `describe('POST /api/loops', ...)` block)

**Interfaces:**

- Consumes: `startLoop` (`../task-engine/loop/engine.js`, Task 9); `getTask` (`../repositories/tasks.js`); `LoopSpec` (`../types.js`, Task 1).

- [ ] **Step 1: Write the failing tests**

In `server/api.loops.test.ts`, add these mocks at the top of the file (above the existing `describe('loop routes', ...)`) — this file currently has none, and none of its existing tests touch task-engine/tmux, so this is additive and safe:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb, insertTask, insertAgent } from './test-helpers.js';
import { createLoopRun, appendIteration } from './repositories/loop-runs.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const mocked = {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
  return { ...mocked, default: mocked };
});

let nextWindowIndex = 5;
vi.mock('child_process', () => ({
  execFile: vi.fn(
    (_cmd: string, args: string[], optsOrCb: Function | object, maybeCb?: Function) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
      if (args.includes('list-windows')) {
        cb(null, { stdout: String(nextWindowIndex), stderr: '' });
      } else if (args.includes('new-window')) {
        nextWindowIndex++;
        cb(null, { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    },
  ),
}));

vi.mock('./orchestrator/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./orchestrator/store.js')>();
  return { ...actual, isOrchestratorManaged: vi.fn(() => false) };
});
vi.mock('./orchestrator/runner.js', () => ({ mcpServerInvocation: vi.fn(() => null) }));
vi.mock('./hook-base-url.js', () => ({ hookBaseUrl: vi.fn(() => 'http://127.0.0.1:7777') }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('./skills.js', () => ({ syncSkills: vi.fn(async () => undefined) }));
vi.mock('./harnesses/index.js', () => ({
  getHarness: vi.fn(() => ({
    id: 'claude-code',
    sessionIdMode: 'orchestrator-assigned',
    newSessionId: vi.fn(() => 'fresh-session-id'),
    buildLaunchCommand: vi.fn(() => 'claude --session-id fresh-session-id'),
    buildResumeCommand: vi.fn(),
    resolveFlags: vi.fn(() => ''),
    syncAgents: vi.fn(async () => undefined),
    installHooks: vi.fn(async () => undefined),
    postLaunch: vi.fn(async () => undefined),
  })),
}));
```

Then, inside the existing `describe('loop routes', ...)` block, change `beforeEach` to also reset `nextWindowIndex` and `vi.clearAllMocks()`:

```ts
beforeEach(() => {
  vi.clearAllMocks();
  nextWindowIndex = 5;
  db = createTestDb();
  app = createApp();
  insertTask(db, { id: 't1', runtime_state: 'running' });
  insertAgent(db, { id: 'a1', task_id: 't1', hook_token: 'tok-loop', status: 'running' } as any);
});
```

(This changes the fixture task from `runtime_state: 'looping'` to `'running'` — `POST /api/loops` needs a task that's runnable _before_ the loop starts, matching how `startLoop` is actually invoked in production. The existing `POST /api/loops/:runId/emit` tests below don't depend on `runtime_state` at all, so this is safe.)

Add a new `describe`, as a sibling to the existing `describe('POST /api/loops/:runId/emit', ...)`:

```ts
describe('POST /api/loops', () => {
  it('creates and starts a loop run', async () => {
    const res = await request(app)
      .post('/api/loops')
      .send({
        taskId: 't1',
        spec: { prompt: 'do the thing', verify: 'echo ok', maxIterations: 5 },
      });

    expect(res.status).toBe(201);
    expect(res.body.task_id).toBe('t1');
    expect(res.body.status).toBe('running');

    const task = db.prepare('SELECT runtime_state FROM tasks WHERE id = ?').get('t1') as {
      runtime_state: string;
    };
    expect(task.runtime_state).toBe('looping');
  });

  it('rejects a missing taskId with 400', async () => {
    const res = await request(app)
      .post('/api/loops')
      .send({ spec: { prompt: 'x', verify: 'y', maxIterations: 5 } });
    expect(res.status).toBe(400);
  });

  it('rejects a missing spec.verify with 400', async () => {
    const res = await request(app)
      .post('/api/loops')
      .send({ taskId: 't1', spec: { prompt: 'x', maxIterations: 5 } });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown task', async () => {
    const res = await request(app)
      .post('/api/loops')
      .send({ taskId: 'nope', spec: { prompt: 'x', verify: 'y', maxIterations: 5 } });
    expect(res.status).toBe(404);
  });

  it('returns 400 when the task has no active agent', async () => {
    db.prepare(`UPDATE agents SET status = 'stopped' WHERE id = 'a1'`).run();
    const res = await request(app)
      .post('/api/loops')
      .send({ taskId: 't1', spec: { prompt: 'x', verify: 'y', maxIterations: 5 } });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- server/api.loops.test.ts`
Expected: FAIL — `POST /api/loops` doesn't exist (404/other unexpected status).

- [ ] **Step 3: Implement**

In `server/routes/loops.ts`, add imports and the new route:

```ts
import { getTask } from '../repositories/tasks.js';
import { startLoop } from '../task-engine/loop/engine.js';
import type { LoopEmitStatus, LoopSpec } from '../types.js';
```

(replace the existing `import type { LoopEmitStatus } from '../types.js';` line with the widened one above)

```ts
router.post('/api/loops', async (req: Request, res: Response) => {
  const body = req.body as { taskId?: unknown; spec?: unknown };
  if (typeof body.taskId !== 'string' || !body.taskId) {
    throw badRequest('taskId is required');
  }
  const spec = body.spec as Partial<LoopSpec> | undefined;
  if (!spec || typeof spec.prompt !== 'string' || !spec.prompt.trim()) {
    throw badRequest('spec.prompt is required');
  }
  if (typeof spec.verify !== 'string' || !spec.verify.trim()) {
    throw badRequest('spec.verify is required');
  }
  if (
    typeof spec.maxIterations !== 'number' ||
    !Number.isFinite(spec.maxIterations) ||
    spec.maxIterations < 1
  ) {
    throw badRequest('spec.maxIterations must be a positive number');
  }

  const task = getTask(body.taskId);
  if (!task) throw notFound('Task not found');

  try {
    const run = await startLoop(body.taskId, spec as LoopSpec);
    res.status(201).json(run);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
});
```

(Place this above the existing `router.post('/api/loops/:runId/emit', ...)` route so `/api/loops` isn't shadowed by the `:runId` param route — Express matches literal segments before param segments regardless of order in this case, but keeping the create-route first is clearer to read.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- server/api.loops.test.ts`
Expected: PASS, full file green (including the pre-existing emit tests, now running with the added mocks — they don't touch task-engine, so behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/routes/loops.ts server/api.loops.test.ts
git commit -m "feat(loop): add POST /api/loops"
```

---

### Task 12: CLI — `octomux loop start`

**Files:**

- Modify: `cli/src/client.ts` (add `LoopSpecInput`/`LoopRunResult` types + `startLoop` to the `OctomuxClient` interface and `createClient` implementation)
- Create: `cli/src/commands/loop-start.ts`
- Modify: `cli/src/index.ts` (register the command)
- Test: Create `cli/src/commands/loop-start.test.ts`

**Interfaces:**

- Produces: `OctomuxClient.startLoop(data: { taskId: string; spec: LoopSpecInput }): Promise<LoopRunResult>`.

- [ ] **Step 1: Write the failing test**

Create `cli/src/commands/loop-start.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { registerLoopStart } from './loop-start.js';
import type { OctomuxClient } from '../client.js';

function makeClient(startLoop: OctomuxClient['startLoop']): OctomuxClient {
  const notImpl = () => {
    throw new Error('not implemented in test');
  };
  return {
    createTask: notImpl as never,
    listTasks: notImpl as never,
    getTask: notImpl as never,
    updateTask: notImpl as never,
    deleteTask: notImpl as never,
    addAgent: notImpl as never,
    stopAgent: notImpl as never,
    sendMessage: notImpl as never,
    listSkills: notImpl as never,
    getSkill: notImpl as never,
    createSkill: notImpl as never,
    deleteSkill: notImpl as never,
    recentRepos: notImpl as never,
    defaultBranch: notImpl as never,
    getRepoConfig: notImpl as never,
    startLoop,
  } as OctomuxClient;
}

function buildProgram(client: OctomuxClient): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.option('--json');
  program.hook('preAction', (thisCommand) => {
    thisCommand.setOptionValue('_client', client);
  });
  registerLoopStart(program);
  return program;
}

function makeRun(overrides: Partial<{ id: string; task_id: string; status: string }> = {}) {
  return {
    id: 'run-1',
    task_id: 't1',
    status: 'running',
    iteration: 0,
    max_iterations: 5,
    termination_reason: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('loop-start command', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('starts a loop with the given spec', async () => {
    const startLoop = vi.fn(async () => makeRun());
    const program = buildProgram(makeClient(startLoop));

    await program.parseAsync(
      [
        'loop-start',
        '--task',
        't1',
        '--prompt',
        'fix the bug',
        '--verify',
        'bun run test',
        '--max-iterations',
        '5',
      ],
      { from: 'user' },
    );

    expect(startLoop).toHaveBeenCalledWith({
      taskId: 't1',
      spec: { prompt: 'fix the bug', verify: 'bun run test', maxIterations: 5 },
    });
  });

  it('reads the prompt from a file when prefixed with @', async () => {
    const startLoop = vi.fn(async () => makeRun());
    const program = buildProgram(makeClient(startLoop));

    const tmpFile = path.join(os.tmpdir(), `loop-prompt-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'prompt from a file');
    try {
      await program.parseAsync(
        [
          'loop-start',
          '--task',
          't1',
          '--prompt',
          `@${tmpFile}`,
          '--verify',
          'true',
          '--max-iterations',
          '3',
        ],
        { from: 'user' },
      );

      expect(startLoop).toHaveBeenCalledWith({
        taskId: 't1',
        spec: { prompt: 'prompt from a file', verify: 'true', maxIterations: 3 },
      });
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('maps --budget-tokens and --stall-after into spec.budget/noProgress', async () => {
    const startLoop = vi.fn(async () => makeRun());
    const program = buildProgram(makeClient(startLoop));

    await program.parseAsync(
      [
        'loop-start',
        '--task',
        't1',
        '--prompt',
        'x',
        '--verify',
        'y',
        '--max-iterations',
        '5',
        '--budget-tokens',
        '100000',
        '--stall-after',
        '3',
      ],
      { from: 'user' },
    );

    expect(startLoop).toHaveBeenCalledWith({
      taskId: 't1',
      spec: {
        prompt: 'x',
        verify: 'y',
        maxIterations: 5,
        budget: { tokens: 100000 },
        noProgress: { afterIters: 3 },
      },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- cli/src/commands/loop-start.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

In `cli/src/client.ts`, add near the other locally-defined request/response shapes (e.g. next to `IntegrationRow`):

```ts
export interface LoopSpecInput {
  prompt: string;
  verify: string;
  maxIterations: number;
  budget?: { tokens?: number; timeMs?: number };
  noProgress?: { afterIters: number };
}

export interface LoopRunResult {
  id: string;
  task_id: string;
  status: string;
  iteration: number;
  max_iterations: number | null;
  termination_reason: string | null;
  created_at: string;
  updated_at: string;
}
```

Add to the `OctomuxClient` interface (anywhere in the method list, e.g. right after `getRepoConfig`):

```ts
  startLoop(data: { taskId: string; spec: LoopSpecInput }): Promise<LoopRunResult>;
```

Add to the `createClient(...)` return object (anywhere in the method list, e.g. right after `getRepoConfig(...)`'s implementation):

```ts
    startLoop(data) {
      return request<LoopRunResult>('/loops', { method: 'POST', body: JSON.stringify(data) });
    },
```

Create `cli/src/commands/loop-start.ts`:

```ts
import fs from 'node:fs';
import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, label, success } from '../format.js';

function resolvePrompt(raw: string): string {
  if (raw.startsWith('@')) {
    return fs.readFileSync(raw.slice(1), 'utf-8');
  }
  return raw;
}

/**
 * octomux loop start — begin a fresh-context Ralph loop against a running
 * task. Uses --stall-after (not --no-progress): commander treats any flag
 * literally starting with `no-` as a boolean negation, which cannot carry a
 * value, so a `--no-progress <n>` flag would silently misparse.
 */
export function registerLoopStart(program: Command): void {
  program
    .command('loop-start')
    .description('Start a fresh-context Ralph loop against a running task')
    .requiredOption('--task <id>', 'task ID to loop')
    .requiredOption('--prompt <text|@file>', 'loop prompt, or @path to read it from a file')
    .requiredOption('--verify <cmd>', 'shell command that must exit 0 for the loop to be done')
    .requiredOption('--max-iterations <n>', 'maximum number of iterations', (v) => parseInt(v, 10))
    .option('--budget-tokens <n>', 'token budget ceiling', (v) => parseInt(v, 10))
    .option(
      '--stall-after <n>',
      'stop after N consecutive no-op iterations (maps to spec.noProgress.afterIters)',
      (v) => parseInt(v, 10),
    )
    .action(async (opts, cmd) => {
      const { client, json } = getContext(cmd);

      const run = await client.startLoop({
        taskId: opts.task,
        spec: {
          prompt: resolvePrompt(opts.prompt),
          verify: opts.verify,
          maxIterations: opts.maxIterations,
          ...(opts.budgetTokens != null ? { budget: { tokens: opts.budgetTokens } } : {}),
          ...(opts.stallAfter != null ? { noProgress: { afterIters: opts.stallAfter } } : {}),
        },
      });

      if (json) {
        outputJson(run);
        return;
      }

      success(`Started loop run ${run.id}`);
      console.log(label('Task', run.task_id));
      console.log(label('Status', run.status));
    });
}
```

In `cli/src/index.ts`, add the import next to the other command imports:

```ts
import { registerLoopStart } from './commands/loop-start.js';
```

And the registration call next to the other `register*(program);` calls:

```ts
registerLoopStart(program);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- cli/src/commands/loop-start.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the CLI package**

Run: `bun run typecheck`
Expected: no errors — confirms `OctomuxClient`'s new required `startLoop` method doesn't break other command test files' `makeClient` helpers (they already tolerate methods added after they were written, via `as OctomuxClient` casts — verify this holds; if it doesn't, add `startLoop: notImpl as never,` to any `makeClient` helper that errors).

- [ ] **Step 6: Commit**

```bash
git add cli/src/client.ts cli/src/commands/loop-start.ts cli/src/commands/loop-start.test.ts cli/src/index.ts
git commit -m "feat(loop): add octomux loop-start CLI command"
```

---

### Task 13: Full gate, rebase, PR

- [ ] **Step 1: Full gate**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all green. Fix any drift before proceeding (in particular: re-check Task 12 Step 5's `OctomuxClient` fallout, and re-run `bun run format:check`).

- [ ] **Step 2: Rebase onto origin/next**

```bash
git fetch origin
git rebase origin/next
```

If `bun run format:check` fails after rebase on a file this plan did not touch, fix only that file with `bunx prettier --write <file>` in a separate commit:

```bash
git add <file>
git commit -m "style: prettier"
```

- [ ] **Step 3: Re-run the gate post-rebase**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all green.

- [ ] **Step 4: Push and open PR**

```bash
git push -u origin agents/loop-harness-p1b-loop-engine-verify-auto-commit-te-3QIlYt
gh pr create --base next --title "feat(loop): loop engine with verify, auto-commit, layered termination + loop stop path" --body "$(cat <<'EOF'
## Summary
- Loop engine (`server/task-engine/loop/engine.ts`): `startLoop` + `handleLoopIterationBoundary`, event-driven off the Stop hook — no polling.
- Auto-commit (`commitAll`, reusing existing `checkDirty`/`revParseHead`) + shell-command verify (`runVerify`) per iteration.
- Layered termination: done+verify-passed / max_iterations / budget (timeMs measurable today; tokens ceiling wired for when a token-usage signal exists) / no_progress / blocked / needs_human.
- Stop hook (`server/hooks.ts`) bypasses human_review/task_updates/fireHook/summarizer for looping tasks and hands off to the engine instead.
- `respawnAgentFresh` extended with optional `{ prompt, env }`; `buildAgentStartupCommand` now exports env vars into the agent's shell — closes the gap where `octomux emit`'s `OCTOMUX_ACTION_TOKEN`/`OCTOMUX_ACTION_BASE_URL` previously only reached the MCP subprocess, not the tmux pane running the loop agent.
- `POST /api/loops` (create + start) added alongside the already-merged emit/get/list routes.
- CLI: `octomux loop-start --task <id> --prompt <text|@file> --verify <cmd> --max-iterations <n> [--budget-tokens <n>] [--stall-after <n>]`. Uses `--stall-after` instead of the originally-specced `--no-progress <n>` — commander treats any `--no-*` flag as a value-less boolean negation, so `--no-progress <n>` would silently misparse.

## Test plan
- [x] `bun run typecheck && bun run lint && bun run test` green (paste output below)
- [x] Engine: 3-iteration done+verify scenario, max_iterations cap, no_progress streak, budget-before-respawn
- [x] Stop hook: table-driven loop vs. normal task, asserting the full bypass list
- [x] Env wiring: a real agent hook_token round-trips through the startup command into `checkAgentTokenExists`

EOF
)"
```

Report the PR URL back to the user. **Do not merge.**

---

## Self-Review Notes (already applied above)

- **Spec coverage:** every P1b requirement (event-driven Stop hook dispatch, auto-commit, verify, layered termination incl. budget-before-respawn, `startLoop`/`runVerify` signatures, CRITICAL env wiring with a real test, TDD list, gate + PR) maps to a task above.
- **No placeholders:** every step has real code; the one deliberate stub (`void logger;` in Task 8, removed in Task 9) is explicitly called out and resolved in the very next task, not left dangling.
- **Type consistency:** `LoopSpec`/`TerminationReason`/`LoopRunStatus` names and shapes are identical everywhere they're used across Tasks 1, 5, 8, 9, 11, 12.
- **Deviation flagged:** `--no-progress` → `--stall-after` (commander negation-flag collision), called out in Global Constraints, the CLI task, and the PR body.
