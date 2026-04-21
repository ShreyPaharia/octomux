# CLI & Test Infrastructure Audit

Audit date: 2026-04-21
Scope: `cli/src/**`, `server/test-helpers.ts`, `src/test-helpers.tsx`, `src/test-setup.ts`,
representative `*.test.ts` / `*.test.tsx` files, and `e2e/helpers.ts`.

---

## HIGH impact

### H1. CLI command-action boilerplate is copy-pasted across all 15 handlers

Every command under `cli/src/commands/*.ts` repeats the same 3-line preamble and the
same "if JSON return early, else human-format" branch. Typical shape:

```ts
.action(async (..., cmd) => {
  const globals = cmd.optsWithGlobals();
  const client: OctomuxClient = globals._client;

  const result = await client.someCall(...);

  if (isJsonMode(globals.json)) {
    outputJson(result);
    return;
  }
  // ... human-formatted output ...
});
```

- `globals` + `_client` extraction: 15/15 files, byte-identical.
- `isJsonMode` + `outputJson` + `return`: 13/15 files.
- 3 files (`delete-task`, `delete-skill`, `stop-agent`) bypass `outputJson()` and use
  `console.log(JSON.stringify(...))` inline — inconsistent with `outputJson` which adds
  2-space indent. This is a subtle output-shape bug for piped consumers.

**Proposed helper** (in `cli/src/action.ts`):

```ts
export function defineAction<A extends any[]>(
  handler: (ctx: { client: OctomuxClient; json: boolean }, ...args: A) => Promise<void>,
) {
  return async (...args: A) => {
    const cmd = args[args.length - 1] as Command;
    const globals = cmd.optsWithGlobals();
    await handler({ client: globals._client, json: isJsonMode(globals.json) }, ...args);
  };
}
```

Or equivalently a tiny `actionContext(cmd)` helper. Per command, saves ~3 LoC and a cast,
and centralizes JSON-mode detection.

### H2. Three list commands share the same "heading + rule + padEnd rows" template

`list-tasks.ts`, `list-skills.ts`, `recent-repos.ts` all open-code:

```ts
heading(`${LABEL.padEnd(N)}...`);
console.log(chalk.dim('─'.repeat(60)));
for (const r of rows) console.log(`${a.padEnd(N)}${b}`);
```

Plus `get-task.ts` duplicates it for its agents sub-table. A single `printTable(columns, rows)`
helper in `cli/src/format.ts` absorbs all four, with consistent separator width and
ANSI-aware padding (current code double-counts chalk color codes when computing pad for
`colorStatus` — it pads the colored string, not the visible length, so alignment is off
by ~10 chars for non-default statuses).

### H3. Five component tests duplicate the `api` Proxy mock — *NOT REFACTORABLE*

`src/pages/Dashboard.test.tsx`, `src/pages/TaskDetail.test.tsx`,
`src/pages/SkillEditor.test.tsx`, `src/components/CreateTaskDialog.test.tsx`,
`src/lib/hooks.test.tsx` all contain an identical block:

```ts
const apiMock = mockApi();
vi.mock('@/lib/api', () => ({
  api: new Proxy({}, {
    get: (_target, prop: string) => apiMock[prop as keyof typeof apiMock],
  }),
}));
```

**Attempted extraction; reverted.** Any helper imported from `test-helpers` and called
inside the `vi.mock` factory hits a TDZ on `__vi_import_N__` because `vi.mock` factories
execute during the import chain, before the test file's own imports have bound their
shims. The original pattern works specifically because:

1. `Proxy` is a JS global (no import needed).
2. `apiMock` is only *captured in the closure* of the `get` trap, not accessed at
   factory-call time (the `new Proxy({}, ...)` constructor doesn't read its handler
   properties eagerly).

A thunk-based helper (`makeApiProxy(() => apiMock)`) still fails because it requires
importing `makeApiProxy` — which vitest hasn't initialized by the time the factory runs.
`vi.hoisted()` could theoretically work but is uglier than the status-quo duplication.

Leaving as-is.

---

## MEDIUM impact

### M1. `useNavigate` mock is duplicated in 4 files verbatim

`TaskDetail.test.tsx`, `Dashboard.test.tsx`, `TaskCard.test.tsx`, `TaskList.test.tsx`:

```ts
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate /* or vi.fn() */ };
});
```

A helper `mockRouterNavigate()` that returns `{ mockNavigate }` and installs the mock
would cut this down. (Note: `vi.mock` is hoisted, so a raw function call won't work —
the helper has to be a macro-like factory that returns the mock config, or each file
keeps the `vi.mock` call but delegates the factory fn.)

**Viable form:**
```ts
// src/test-helpers.tsx
export function routerNavigateMockFactory() {
  const mockNavigate = vi.fn();
  return {
    mockNavigate,
    factory: async (importOriginal: any) => {
      const actual = await importOriginal();
      return { ...actual, useNavigate: () => mockNavigate };
    },
  };
}
```

### M2. Inline `execFile`-with-callback mock pattern reinvented in 3 places

`server/test-helpers.ts` exports `findCallback` and `deadSessionMock`. But these test
files re-implement the same shape inline:

- `server/api.test.ts:100-106` (generic success)
- `server/repo-config.test.ts:28-33, 57-62` (custom stdout/err)
- `server/task-runner.test.ts:57-73` (arg-based dispatch)
- `server/poller.test.ts:20-25, 62-67` (default stdout)

**Proposed helpers** in `server/test-helpers.ts`:

```ts
export function execFileOk(stdout = '', stderr = '') {
  return (...args: any[]) => { const cb = findCallback(...args); cb?.(null, { stdout, stderr }); };
}
export function execFileFail(err: Error | string = 'exec failed') {
  return (...args: any[]) => {
    const cb = findCallback(...args);
    cb?.(typeof err === 'string' ? new Error(err) : err);
  };
}
```

Sits next to the existing `deadSessionMock` and is a straight extension of it.

### M3. `runningTask` + inline agent fixtures duplicate `DEFAULTS`

`src/pages/TaskDetail.test.tsx:62-78` defines a `runningTask` with an inline agent array.
The agent object is 10 lines of literal properties already available via `makeAgent()` —
so a `makeTaskWithAgents({ count: 1 })` helper (or just `makeTask({ agents: [makeAgent()] })`)
saves the duplication. Today `makeTask()` doesn't fill `agents`, so it silently forces
callers to hand-roll.

### M4. `api.test.ts` could switch to `it.each()` for the large `apiCases` array

`src/lib/api.test.tsx:24-…` already defines a `apiCases` table but then iterates with
a custom `describe.each`-style block. This is a minor tidy — verify the existing pattern
matches the project's `it.each()` convention.

### M5. `src/test-setup.ts` is not importing `vi` for `matchMedia`

`vi` is globally available via `globals: true` in `vitest.config.ts`, so this is fine,
but `src/test-helpers.tsx` references `vi` without importing it — works because of the
same global. Add `/// <reference types="vitest/globals" />` to `test-helpers.tsx` to make
TypeScript happy without requiring an import.

---

## LOW impact

### L1. `client.ts` query-param building is repeated 4 times

Lines 99-100, 155-158, 162-163: each call manually builds
`?key=${encodeURIComponent(value)}`. A small `q({ key: value })` builder would dedupe.
Low value — 4 call sites, 1 line each.

### L2. `DEFAULTS.task` / `TASK_DEFAULTS` exist in both `server/test-helpers.ts` and
`src/test-helpers.tsx`

Different shapes (server has `tmux_session`, frontend uses `Task` from `server/types`).
Because the server uses the DB schema as source of truth and the frontend uses the API
shape, merging them is risky; leave as-is. Noted for awareness.

### L3. `e2e/helpers.ts` `API` base URL is a bare constant

Small improvement: allow `OCTOMUX_URL` override for running tests against a non-default
port. Low priority since playwright.config.ts pins the port.

### L4. `cli/src/index.ts` — 14 import + 14 register lines

Could be reduced with a registrar array, but the explicit listing makes it trivial to
scan what commands exist. Keep as-is unless more commands are added.

### L5. Missing `format.ts` helper: `outputJsonTerse()`

`delete-task.ts` does `console.log(JSON.stringify({ deleted: id }))` (no indent).
`delete-skill.ts` and `stop-agent.ts` do the same. These three callers want
machine-readable single-line output; a terse variant of `outputJson` would unify this.
(Alternative: just route everything through `outputJson` which already does 2-space
indent and is fine for pipe consumers — this is the cleaner fix and is subsumed by H1.)

---

## Out-of-scope / deferred

- Playwright specs under `e2e/*.spec.ts` — user asked only for helpers.
- `server/types.ts` — explicitly not to be modified.
- CLI command surface (flags, names, output shape) — constraint from brief.
- Integration of `orchestrator-context` mocks — only used in one test.

---

## Execution plan

In order, with a conventional-commit per step and tests passing after each:

1. **H1** — Add `cli/src/action.ts` with `defineAction` + `actionContext`, migrate all
   15 commands. Also fix the 3 inconsistent inline `JSON.stringify` callers to route
   through `outputJson`.
2. **H2** — Add `printTable` to `cli/src/format.ts`, migrate `list-tasks`, `list-skills`,
   `recent-repos`, and `get-task`'s agents block.
3. **H3** — Add `createApiMockProxy` to `src/test-helpers.tsx`, migrate the 5 callers.
4. **M1** — Add `mockUseNavigate` factory helper, migrate 4 callers.
5. **M2** — Add `execFileOk`/`execFileFail` to `server/test-helpers.ts`, migrate
   4 callers.
6. **M3** — Update `makeTask`/`makeAgent` composition; migrate `TaskDetail.test.tsx`.

Stop after HIGH + MEDIUM (6 commits). Remaining LOW items are noted but deferred.
