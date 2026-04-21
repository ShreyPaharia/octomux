# Frontend Audit (`src/`)

Status: post-audit plan. Baseline: 715 tests passing, typecheck clean, 21 pre-existing lint warnings (all non-blocking).

## Already Implemented (from prior `UI-PERFORMANCE-AUDIT.md`)

These items from the existing audit doc are already in the tree — no further action needed:

- [x] Route-level code splitting: `TaskDetail`, `OrchestratorPage`, `SettingsPage`, `SkillEditor`, `AgentEditor` are `React.lazy()` in `src/App.tsx`
- [x] `JSON.stringify` guard in `useTasks()` and `useTask()` (`src/lib/hooks.ts`)
- [x] `useCallback` on Dashboard handlers `handleClose`/`handleDelete`/`handleResume`
- [x] `React.memo` on TaskCard, StatusBadge, AgentActivityDot, PermissionPromptRow, TaskFilterBar, AgentActivitySummary
- [x] ResizeObserver + window resize handler in `TerminalView` debounced via `requestAnimationFrame`
- [x] Dashboard loading skeleton (matches TaskCard dimensions)

## HIGH Priority — Action Items

### H1. Three independent `useTasks()` subscribers duplicate work per server event

**Where:** `src/App.tsx` (GlobalNotifications + UniversalSidebar) and `src/pages/Dashboard.tsx`.

**Impact:** On every WebSocket `task:*` event, three hook instances each: (1) call `api.listTasks()` (deduped to a single HTTP request, OK), (2) run `JSON.stringify` over the full task list, (3) possibly call `setState`. Two of those three JSON.stringify + setState pairs produce zero observable change beyond what a shared source would.

**Fix:** Promote `useTasks()` into a `TasksProvider` mounted in `App` alongside `OrchestratorProvider`. Expose a `useTasksContext()` that all three consumers use. Keep the existing `useTasks()` export as a thin wrapper for tests/standalone use.

### H2. `useOrchestrator` re-polls `/api/orchestrator/status` on every task event

**Where:** `src/lib/hooks.ts:24-27` — `subscribe(() => refresh())` inside `useOrchestrator`.

**Impact:** The orchestrator status never changes as a side effect of task events. Every `task:updated` / `task:created` / `task:deleted` fires a useless GET to `/api/orchestrator/status`. At scale (many running tasks = many events/sec), this is dozens of wasted requests per minute. State setters for `running`/`error` are primitives, so React bails on setState, but the HTTP overhead is real.

**Fix:** Remove the blanket subscription. Orchestrator status only changes on user action (start/stop/restart), so the existing explicit `refresh()` calls are sufficient.

### H3. `OrchestratorProvider` value identity churns on every render

**Where:** `src/lib/orchestrator-context.tsx:14-17`.

**Impact:** `useOrchestrator()` returns a fresh object literal on every call. That object is handed directly to `<Provider value={…}>`, so every consumer (`UniversalSidebar`, `OrchestratorPage`, `OrchestratorCommandBar`) re-renders every time `OrchestratorProvider` renders — even when `running`/`loading`/`error` haven't changed.

**Fix:** Wrap the value in `useMemo` keyed on the actual fields. Combined with H2, this drops orchestrator-driven re-renders across the tree.

### H4. Shared `repoName` helper duplicated in 4 files

**Where:** `TaskCard.tsx`, `TaskDetail.tsx`, `TaskFilterBar.tsx`, `SettingsPage.tsx` all define a local `repoName(path)` helper with identical logic.

**Impact:** Pure duplication; bug-fix-once-fix-once-per-file risk. No performance cost.

**Fix:** Move to `src/lib/utils.ts` (or a new `src/lib/repo.ts`) and import.

## MEDIUM Priority

### M1. `AgentEditor` / `SkillEditor` / `OrchestratorPromptSection` duplicate Save + Unsaved-warning logic

All three files carry the same boilerplate:
- Cmd/Ctrl+S save keydown listener
- `beforeunload` warning when `isDirty`
- `savedContentRef` + `isDirty = content !== savedContentRef.current` pattern

**Fix:** Extract two small hooks — `useSaveShortcut(save)` and `useUnsavedWarning(isDirty)`. Straightforward win; low risk; small LOC delta.

### M2. `DraftEditForm` duplicates `FolderBrowser` and the branch dropdown

`DraftEditForm.tsx` contains its own copy of `FolderBrowser` (identical to the one in `RepoPickerField.tsx`) and re-implements the branch search popover that `BranchPickerField` already provides.

**Fix:** Replace the inline code with `<RepoPickerField>` + `<BranchPickerField>`. Risk: the form needs to skip repo validation for an already-saved value; doable with existing props.

### M3. `tabs` / `navItems` literals rebuilt per render

- `TaskFilterBar.tsx:103-107` — `tabs` array.
- `UniversalSidebar.tsx:192-196` — `navItems` array.

Both reference only static values and can be hoisted to module scope. Tiny memory/GC win.

### M4. `useTaskFilters` — status default from localStorage not validated

`localStorage.getItem(STATUS_FILTER_KEY) as StatusTab` — if the value is ever a stale or invalid string, the cast silently produces a bad filter. Add a guard that falls back to `'open'` for unknown values.

## LOW Priority (Documented, Deferred)

### L1. TerminalView accumulates `term.onData` listeners on reconnect
`term.onData(…)` is called inside `connectWs`, which is re-invoked on each reconnect. Each reconnect adds another listener. Functionally OK today (only the newest WS is open), but wasteful. Fix: register `onData` once per terminal in `connect()`, not per WebSocket.

### L2. `TaskPickerField` fetches once on mount, never refreshes
If the orchestrator command form is open when a new task is created, the picker won't show it. Subscribe to event-source like other hooks, or re-fetch on popover open.

### L3. Custom modals in `SettingsPage` (create/delete dialogs for agents & skills) bypass shadcn Dialog — inconsistent a11y/focus handling.

### L4. `CreateTaskDialog` is rendered twice in Dashboard (header + empty state action) — two instances, each with its own state tree. Only one is visible at a time so it's benign, but could be hoisted via portal or render-prop.

### L5. Large inline-SVG duplication — folder icon, chevron, close-X, terminal glyph repeated across many files. No perf impact, just bundle bloat. Deferred; not in scope.

---

## Execution Plan

Attack the HIGH items first, one commit per concern:

1. **H4** (repoName helper) — smallest blast radius, reduces surface for next changes. `refactor(ui)`.
2. **H3** (memoize provider value) — 4-line change. `perf(ui)`.
3. **H2** (drop useless orchestrator subscribe) — ~3-line change. `perf(ui)`.
4. **H1** (TasksProvider) — larger; needs test updates. `perf(ui)`.
5. **M1** (extract save-shortcut / unsaved-warning hooks) — `refactor(ui)`.
6. **M3** (hoist static literals) — `perf(ui)` or bundled.
7. **M4** (validate localStorage filter) — `fix(ui)`.

Stop after ~8 focused commits or when HIGH items are complete, whichever comes first. Defer M2 and all LOW items to a follow-up PR — noted in the PR description.

After each commit: `bun run typecheck`, `bun run lint`, `bun run test`. All must remain green.
