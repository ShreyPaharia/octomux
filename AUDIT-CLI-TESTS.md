# CLI & Test Infrastructure Audit

Audit date: 2026-04-21
Scope: `cli/src/**`, `server/test-helpers.ts`, `src/test-helpers.tsx`, `src/test-setup.ts`,
representative `*.test.ts` / `*.test.tsx` files, and `e2e/helpers.ts`.

Status legend: ✅ addressed · ⏭️ declined (with reason).

---

## HIGH impact

### H1. CLI command-action boilerplate (✅ addressed)

Every command under `cli/src/commands/*.ts` repeated the same 3-line preamble and the
same "if JSON return early, else human-format" branch:

```ts
.action(async (..., cmd) => {
  const globals = cmd.optsWithGlobals();
  const client: OctomuxClient = globals._client;
  const result = await client.someCall(...);
  if (isJsonMode(globals.json)) { outputJson(result); return; }
  // ... human-formatted output ...
});
```

Extracted `getContext(cmd)` in `cli/src/action.ts`. All 15 handlers migrated.

### H2. Three list commands duplicated a table template (✅ addressed)

`list-tasks`, `list-skills`, `recent-repos` all open-coded `heading` + dim separator + a
padEnd loop. `get-task` had a similar pattern for its agents sub-list.

Added `printTable` to `cli/src/format.ts` (ANSI-aware — pads by visible length, which
also drops the hand-rolled `+10` chalk-escape-code fudge factor). Migrated the three
list commands. `get-task` agent block left inline — it isn't a proper headered table.

### H3. Five tests duplicated the `api` Proxy mock (✅ addressed via `vi.hoisted`)

The first attempt (a plain helper import) failed because `vi.mock` factories run during
the import chain, before the test file's own imports bind their shims — any imported
helper hits a `Cannot access '__vi_import_N__' before initialization` TDZ.

**Fix:** `vi.hoisted()` is specifically designed for this. Its callback runs before
any imports and before any `vi.mock` factory, and its return value is guaranteed
available to the factories. Used async form so the callback itself can dynamic-`import`
`test-helpers`:

```ts
const { apiMock, apiProxy } = await vi.hoisted(
  async () => (await import('../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api', () => ({ api: apiProxy }));
```

Added `setupApiMock()` to `src/test-helpers.tsx`. Migrated: `Dashboard.test.tsx`,
`TaskDetail.test.tsx`, `SkillEditor.test.tsx`, `CreateTaskDialog.test.tsx`,
`hooks.test.tsx`.

---

## MEDIUM impact

### M1. `useNavigate` mock duplicated in 4 files (✅ addressed via `vi.hoisted`)

Same `vi.hoisted` pattern as H3. Added `setupRouterNavigateMock()` returning
`{ mockNavigate, routerMockFactory }`. Migrated: `TaskCard`, `TaskList`, `Dashboard`,
`TaskDetail`.

### M2. Inline `execFile`-with-callback mock pattern (✅ addressed)

Added `execFileOk(stdout?, stderr?)` / `execFileFail(err?)` factories in
`server/test-helpers.ts`. Re-expressed `deadSessionMock` in terms of `execFileFail`.
Migrated `poller.test.ts` and `repo-config.test.ts` direct sites. Sites inside `vi.mock`
factory bodies kept their inline shape (same hoisting constraint — but no
vi.hoisted equivalent is needed since the inline form is short).

### M3. `runningTask` inline agent fixtures (✅ addressed)

Two agent literals in `TaskDetail.test.tsx` collapsed to `makeAgent({ id: 'a1' })`.

### M4. `api.test.tsx` table-driven (⏭️ already in spec's spirit)

The file already uses a cases array + iteration loop. No change needed.

### M5. `test-helpers.tsx` `vi` global ref-types (⏭️ not worth it)

Works fine today via `globals: true` in vitest config. Cosmetic only.

---

## LOW impact

### L1. `client.ts` query-param building (✅ addressed)

Added `qs()` helper. Three call sites migrated (`listTasks`, `defaultBranch`,
`getRepoConfig`).

### L2. `DEFAULTS.task` / `TASK_DEFAULTS` split between server and frontend (⏭️ kept)

Different shapes (server is DB-schema-shaped, frontend is API-shape-shaped). Unifying
is risky and low-value. Noted for awareness.

### L3. `e2e/helpers.ts` hardcoded base URL (✅ addressed)

Respects `OCTOMUX_URL` env var now, matching the CLI's own convention.

### L4. `cli/src/index.ts` imports + register lines (⏭️ kept)

Explicit listing wins on readability vs a registrar array. 15 lines is fine.

### L5. Missing `outputJsonTerse()` (⏭️ kept inline)

Three callers use `console.log(JSON.stringify(...))` for single-line JSON. Migrating
to `outputJson` would change output shape (2-space indent) — constraint forbids.
Preserved as-is.

---

## Out-of-scope / deferred at brief level

- Playwright specs under `e2e/*.spec.ts` — brief said helpers only.
- `server/types.ts` — explicitly off limits.
- CLI public surface (names, flags, output shape).

---

## Final commit log

1. `refactor(cli): extract getContext helper from command actions` (H1)
2. `refactor(cli): add printTable helper and migrate list commands` (H2)
3. `refactor(test): add execFileOk/execFileFail helpers` (M2)
4. `refactor(test): use makeAgent for inline agent fixtures in TaskDetail` (M3)
5. `refactor(cli): consolidate query-string building into qs() helper` (L1)
6. `docs: add CLI and test-infrastructure audit` (this file)
7. `refactor(test): dedupe api + router-navigate mocks via vi.hoisted` (H3 + M1)
8. `refactor(e2e): honor OCTOMUX_URL env var in helpers` (L3)

All passes: typecheck clean · lint clean · 715/715 unit tests green.
