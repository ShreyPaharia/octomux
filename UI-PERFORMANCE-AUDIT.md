# UI Performance Audit

> Audit of octomux-agents React frontend for rendering performance, data fetching efficiency, and perceived responsiveness.

## Issues (Prioritized)

### HIGH Impact

#### 1. No Code Splitting — xterm.js Bundled on Dashboard

- **Where:** `src/App.tsx:3-4` — static imports of Dashboard and TaskDetail
- **Impact:** xterm.js (~200KB) loaded on Dashboard even when user never visits TaskDetail. Slows initial page load.
- **Fix:** Lazy-load TaskDetail route with `React.lazy` + `Suspense`. TerminalView is only used inside TaskDetail and OrchestratorPanel, so lazy-loading TaskDetail saves the bulk of xterm.js on initial Dashboard load.

#### 2. useTasks Hook Triggers Re-renders on Every WebSocket Event

- **Where:** `src/lib/hooks.ts:54-64` — `useTasks()` calls `setTasks(data)` on every event
- **Impact:** Every server event (any task change, agent activity update) causes Dashboard to re-render the entire task list. Unlike `useTask()` which has a `JSON.stringify` guard (line 86-90), `useTasks()` always sets new state.
- **Fix:** Add the same `JSON.stringify` comparison guard to `useTasks()`.

#### 3. TaskCard Re-renders on Every Parent Update

- **Where:** `src/components/TaskCard.tsx` — no `React.memo`
- **Impact:** When `useTasks` triggers a Dashboard re-render, every TaskCard re-renders even if its task data hasn't changed. With 20+ tasks, this is noticeable.
- **Fix:** Wrap TaskCard export in `React.memo`.

#### 4. Dashboard Callbacks Recreated Every Render

- **Where:** `src/pages/Dashboard.tsx:13-29` — `handleDelete` and `handleResume` are plain functions
- **Impact:** New function references on every render break `React.memo` on TaskCard (if added).
- **Fix:** Convert to `useCallback` with `[refresh]` dependency.

### MEDIUM Impact

#### 5. Leaf Components Missing React.memo

- **Where:** `StatusBadge.tsx`, `AgentActivityDot.tsx`, `TaskFilterBar.tsx`, `PermissionPromptRow.tsx`
- **Impact:** These pure display components re-render when parent re-renders, even with identical props.
- **Fix:** Add `React.memo` to each.

#### 6. ResizeObserver Handler Not Debounced in TerminalView

- **Where:** `src/components/TerminalView.tsx:180-194` — ResizeObserver fires `fitAndSendResize` directly
- **Impact:** During animated resizes (e.g., dragging browser edge), fit+WebSocket-send fires every frame. The fit() call is expensive as it recalculates terminal dimensions and triggers a full re-layout.
- **Fix:** Debounce the ResizeObserver callback with `requestAnimationFrame` guard.

#### 7. No Loading Skeleton — Layout Shift on Data Load

- **Where:** `src/pages/Dashboard.tsx:49-51` — "Loading..." text, then card list appears
- **Impact:** Content jumps from centered text to left-aligned cards. Jarring on slower connections.
- **Fix:** Add skeleton cards that match TaskCard dimensions.

### LOW Impact

#### 8. OrchestratorPanel Subscribes to WebSocket When Collapsed

- **Where:** `src/components/OrchestratorPanel.tsx:10` — `useOrchestrator()` runs unconditionally
- **Impact:** Unnecessary API calls when panel is collapsed. Minor since the WebSocket is shared.
- **Fix:** Skip implementation — complexity not worth the gain for a localhost tool.

#### 9. filteredBranches Recomputed Every Render in CreateTaskDialog

- **Where:** `src/components/CreateTaskDialog.tsx:102-104` — filter runs on every keystroke
- **Impact:** Negligible unless repo has thousands of branches.
- **Fix:** Skip implementation — dialog is already behind a user action.

## Implementation Order (Quick Wins First)

1. **Add JSON.stringify guard to useTasks** — 5 min, prevents cascade re-renders
2. **useCallback for Dashboard handlers** — 2 min, enables memo benefits
3. **React.memo on TaskCard** — 1 min, biggest bang-for-buck with #1 and #2
4. **React.memo on leaf components** — 5 min, prevents unnecessary sub-tree renders
5. **Lazy-load TaskDetail route** — 5 min, reduces initial bundle
6. **Debounce ResizeObserver** — 5 min, smoother terminal resize
7. **Add loading skeletons** — 10 min, better perceived performance
