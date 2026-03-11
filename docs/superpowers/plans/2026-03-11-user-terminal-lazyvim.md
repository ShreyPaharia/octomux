# User Terminal with LazyVim Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-screen toggleable user terminal with LazyVim to the task detail page, allowing users to review code and make interventions in the task's worktree.

**Architecture:** New tmux window in the task's existing session, lazily created on first toggle. Backend exposes a POST endpoint to create the window; frontend toggles between agent view and editor view using CSS visibility (both stay mounted).

**Tech Stack:** Express 5, better-sqlite3, node-pty (existing), xterm.js (existing), React 19, Tailwind CSS 4

**Spec:** `docs/superpowers/specs/2026-03-11-user-terminal-lazyvim-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `server/types.ts` | Modify | Add `user_window_index` to Task interface |
| `server/db.ts` | Modify | Add migration for `user_window_index` column |
| `server/task-runner.ts` | Modify | Add `createUserTerminal()`, update `resumeTask()` |
| `server/api.ts` | Modify | Add `POST /api/tasks/:id/user-terminal` route |
| `server/test-helpers.ts` | Modify | Add `user_window_index` to DEFAULTS and insertTask |
| `server/task-runner.test.ts` | Modify | Add tests for `createUserTerminal` and `resumeTask` reset |
| `server/api.test.ts` | Modify | Add tests for new endpoint |
| `src/lib/api.ts` | Modify | Add `createUserTerminal()` API function |
| `src/test-helpers.tsx` | Modify | Add `user_window_index` to TASK_DEFAULTS, add `createUserTerminal` to mockApi |
| `src/components/TerminalView.tsx` | Modify | Add `visible` prop for fit-on-show |
| `src/pages/TaskDetail.tsx` | Modify | Add mode state, toggle button, dual terminal rendering |
| `src/pages/TaskDetail.test.tsx` | Modify | Add tests for editor toggle, mode switching, auto-switch |

---

## Chunk 1: Backend — Types, DB, and Test Helpers

### Task 1: Add `user_window_index` to Task type

**Files:**
- Modify: `server/types.ts:4-21`

- [ ] **Step 1: Add field to Task interface**

In `server/types.ts`, add `user_window_index` after `pr_number`:

```typescript
  pr_number: number | null;
  user_window_index: number | null;
  initial_prompt: string | null;
```

- [ ] **Step 2: Run typecheck to verify**

Run: `bun run typecheck`
Expected: May show errors in test-helpers where DEFAULTS doesn't include the new field — that's expected and fixed in Task 2.

### Task 2: Add DB migration and update test helpers

**Files:**
- Modify: `server/db.ts:60-81`
- Modify: `server/test-helpers.ts:8-54,70-97`

- [ ] **Step 1: Add migration to db.ts**

In `server/db.ts`, inside `initDb()`, after the `base_branch` migration (line 80), add:

```typescript
  if (!colNames.includes('user_window_index')) {
    instance.exec('ALTER TABLE tasks ADD COLUMN user_window_index INTEGER');
  }
```

- [ ] **Step 2: Update DEFAULTS in test-helpers.ts**

In `server/test-helpers.ts`, add `user_window_index: null` to both `task` and `runningTask` DEFAULTS objects (after `pr_number`):

```typescript
    pr_number: null,
    user_window_index: null,
    initial_prompt: null,
```

- [ ] **Step 3: Update insertTask to include user_window_index**

In `server/test-helpers.ts`, update the `insertTask` function's SQL and `.run()` call to include `user_window_index`:

```typescript
  db.prepare(
    `INSERT INTO tasks (id, title, description, repo_path, status, branch, base_branch, worktree, tmux_session, pr_url, pr_number, user_window_index, initial_prompt, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.title,
    task.description,
    task.repo_path,
    task.status,
    task.branch,
    task.base_branch,
    task.worktree,
    task.tmux_session,
    task.pr_url,
    task.pr_number,
    task.user_window_index,
    task.initial_prompt,
    task.error,
    task.created_at,
    task.updated_at,
  );
```

- [ ] **Step 4: Update TASKS_TABLE_COLUMNS**

Add `'user_window_index'` after `'pr_number'` in the `TASKS_TABLE_COLUMNS` array.

- [ ] **Step 5: Run existing tests to verify nothing breaks**

Run: `bun run test -- server/db.test.ts server/task-runner.test.ts server/api.test.ts`
Expected: All existing tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server/types.ts server/db.ts server/test-helpers.ts
git commit -m "feat(db): add user_window_index column to tasks table"
```

---

## Chunk 2: Backend — createUserTerminal and resumeTask update

### Task 3: Write tests for createUserTerminal

**Files:**
- Modify: `server/task-runner.test.ts`

- [ ] **Step 1: Write tests for createUserTerminal**

Add a new describe block after the `resumeTask` describe in `server/task-runner.test.ts`:

```typescript
// ─── createUserTerminal ──────────────────────────────────────────────────────

describe('createUserTerminal', () => {
  const runningTask = { ...DEFAULTS.runningTask } as Task;

  it('creates tmux window and returns window index', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const index = await createUserTerminal(runningTask);

    expect(index).toBe(1); // nextWindowIndex incremented by new-window mock
    expect(findExecCall(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['new-window'] })).toBeDefined();
  });

  it('sends nvim launch command to the new window', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await createUserTerminal(runningTask);

    const sendKeysCall = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['send-keys', 'nvim .', 'Enter'],
    });
    expect(sendKeysCall).toBeDefined();
  });

  it('stores user_window_index in the database', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    await createUserTerminal(runningTask);

    const updated = getTask(db, DEFAULTS.task.id)!;
    expect(updated.user_window_index).toBe(1);
  });

  it('returns existing index without creating new window when already set', async () => {
    insertTask(db, { ...DEFAULTS.runningTask, user_window_index: 5 });
    const index = await createUserTerminal({
      ...runningTask,
      user_window_index: 5,
    } as Task);

    expect(index).toBe(5);
    expect(
      findExecCall(vi.mocked(execFile), { cmd: 'tmux', argsInclude: ['new-window'] }),
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- server/task-runner.test.ts`
Expected: FAIL — `createUserTerminal` is not exported / doesn't exist.

### Task 4: Implement createUserTerminal

**Files:**
- Modify: `server/task-runner.ts`

- [ ] **Step 1: Add createUserTerminal function**

Add after `stopAgent` and before `resumeTask` in `server/task-runner.ts`:

```typescript
export async function createUserTerminal(task: Task): Promise<number> {
  // Idempotent: return existing window index if already created
  if (task.user_window_index !== null && task.user_window_index !== undefined) {
    return task.user_window_index;
  }

  const db = getDb();

  // Create new tmux window in the task's session
  await execFile('tmux', ['new-window', '-t', task.tmux_session!, '-c', task.worktree!]);

  // Get the new window's index (same pattern as addAgent)
  const windowIndex = await getLastWindowIndex(task.tmux_session!);

  // Launch nvim in the worktree
  await execFile('tmux', [
    'send-keys',
    '-t',
    `${task.tmux_session}:${windowIndex}`,
    'nvim .',
    'Enter',
  ]);

  // Store the window index
  db.prepare(
    `UPDATE tasks SET user_window_index = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(windowIndex, task.id);

  return windowIndex;
}
```

- [ ] **Step 2: Add createUserTerminal to the import in task-runner.test.ts**

Update the dynamic import at the top of `task-runner.test.ts`:

```typescript
const {
  startTask,
  closeTask,
  deleteTask,
  addAgent,
  stopAgent,
  resumeTask,
  dispatchToWindow,
  slugifyTitle,
  createUserTerminal,
} = await import('./task-runner.js');
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `bun run test -- server/task-runner.test.ts`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add server/task-runner.ts server/task-runner.test.ts
git commit -m "feat(task-runner): add createUserTerminal function"
```

### Task 5: Write test and implement resumeTask user_window_index reset

**Files:**
- Modify: `server/task-runner.test.ts`
- Modify: `server/task-runner.ts:236-244`

- [ ] **Step 1: Write failing test**

Add to the `resumeTask` describe block in `server/task-runner.test.ts`:

```typescript
  it('resets user_window_index to null on resume', async () => {
    insertTask(db, { ...closedTask, user_window_index: 3 });
    insertAgent(db, { status: 'stopped' });

    await resumeTask(closedTask);

    const updated = getTask(db, DEFAULTS.task.id)!;
    expect(updated.user_window_index).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- server/task-runner.test.ts -t "resets user_window_index"`
Expected: FAIL — `user_window_index` is still 3.

- [ ] **Step 3: Update resumeTask SQL**

In `server/task-runner.ts`, update the first UPDATE in `resumeTask()` (line ~242-244):

```typescript
    db.prepare(
      `UPDATE tasks SET status = 'setting_up', error = NULL, user_window_index = NULL, updated_at = datetime('now') WHERE id = ?`,
    ).run(task.id);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- server/task-runner.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/task-runner.ts server/task-runner.test.ts
git commit -m "feat(task-runner): reset user_window_index on resume"
```

### Task 6: Write tests and implement API endpoint

**Files:**
- Modify: `server/api.test.ts`
- Modify: `server/api.ts`

- [ ] **Step 1: Add createUserTerminal mock to api.test.ts**

In `server/api.test.ts`, update the task-runner mock to include `createUserTerminal`:

```typescript
    createUserTerminal: vi.fn(async (task: any) => {
      const db = getDb();
      db.prepare(
        `UPDATE tasks SET user_window_index = 5, updated_at = datetime('now') WHERE id = ?`,
      ).run(task.id);
      return 5;
    }),
```

And update the imports at the bottom:

```typescript
const { startTask, closeTask, deleteTask, resumeTask, addAgent, stopAgent, createUserTerminal } =
  await import('./task-runner.js');
```

- [ ] **Step 2: Write tests for the endpoint**

Add a new describe block in `server/api.test.ts`:

```typescript
// ─── POST /api/tasks/:id/user-terminal ──────────────────────────────────────

describe('POST /api/tasks/:id/user-terminal', () => {
  it('creates user terminal and returns window index', async () => {
    insertTask(db, { ...DEFAULTS.runningTask });
    const res = await request(app).post(`/api/tasks/${DEFAULTS.task.id}/user-terminal`);

    expect(res.status).toBe(200);
    expect(res.body.user_window_index).toBe(5);
    expect(createUserTerminal).toHaveBeenCalledOnce();
  });

  it('returns 404 for nonexistent task', async () => {
    const res = await request(app).post('/api/tasks/nonexistent/user-terminal');
    expect(res.status).toBe(404);
  });

  it('returns 400 when task has no tmux session', async () => {
    insertTask(db, { tmux_session: null, status: 'running' });
    const res = await request(app).post(`/api/tasks/${DEFAULTS.task.id}/user-terminal`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('tmux');
  });

  const nonRunningStatuses = ['draft', 'setting_up', 'closed', 'error'] as const;

  it.each(nonRunningStatuses)('returns 400 when task status is %s', async (status) => {
    insertTask(db, { ...DEFAULTS.runningTask, status });
    const res = await request(app).post(`/api/tasks/${DEFAULTS.task.id}/user-terminal`);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun run test -- server/api.test.ts -t "user-terminal"`
Expected: FAIL — route doesn't exist.

- [ ] **Step 4: Implement the endpoint**

In `server/api.ts`, add the import for `createUserTerminal`:

```typescript
import {
  startTask,
  closeTask,
  deleteTask,
  resumeTask,
  addAgent,
  stopAgent,
  createUserTerminal,
} from './task-runner.js';
```

Then add the route inside `setupRoutes()`, after the stop agent route (before the orchestrator section):

```typescript
  // Create user terminal (lazily creates tmux window with nvim)
  app.post('/api/tasks/:id/user-terminal', async (req: Request, res: Response) => {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as
      | Task
      | undefined;

    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    if (task.status !== 'running') {
      res.status(400).json({ error: 'Can only create user terminal for running tasks' });
      return;
    }

    if (!task.tmux_session) {
      res.status(400).json({ error: 'Task has no tmux session' });
      return;
    }

    try {
      const userWindowIndex = await createUserTerminal(task);
      res.json({ user_window_index: userWindowIndex });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
```

- [ ] **Step 5: Also add to the 404 table-driven test**

In the `notFoundCases` array at the top of `api.test.ts`, add:

```typescript
  {
    name: 'POST /api/tasks/:id/user-terminal',
    method: 'post' as const,
    url: '/api/tasks/nonexistent/user-terminal',
  },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun run test -- server/api.test.ts`
Expected: All tests PASS.

- [ ] **Step 7: Run all backend tests**

Run: `bun run test -- server/`
Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add server/api.ts server/api.test.ts
git commit -m "feat(api): add POST /api/tasks/:id/user-terminal endpoint"
```

---

## Chunk 3: Frontend — API client, TerminalView visible prop, test helpers

### Task 7: Add API function and update test helpers

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src/test-helpers.tsx`

- [ ] **Step 1: Add createUserTerminal to api.ts**

In `src/lib/api.ts`, add after `stopAgent`:

```typescript
  createUserTerminal: (taskId: string) =>
    request<{ user_window_index: number }>(`/tasks/${taskId}/user-terminal`, { method: 'POST' }),
```

- [ ] **Step 2: Update TASK_DEFAULTS in test-helpers.tsx**

In `src/test-helpers.tsx`, add `user_window_index: null` to `TASK_DEFAULTS` (after `pr_number`):

```typescript
  pr_number: null,
  user_window_index: null,
  initial_prompt: null,
```

- [ ] **Step 3: Add createUserTerminal to mockApi**

In `src/test-helpers.tsx`, add to the `defaults` object in `mockApi()`:

```typescript
    createUserTerminal: vi.fn().mockResolvedValue({ user_window_index: 5 }),
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (or only pre-existing issues).

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/test-helpers.tsx
git commit -m "feat(frontend): add createUserTerminal API function and test helpers"
```

### Task 8: Add `visible` prop to TerminalView

**Files:**
- Modify: `src/components/TerminalView.tsx`

- [ ] **Step 1: Add visible prop to interface**

Update the `TerminalViewProps` interface:

```typescript
interface TerminalViewProps {
  taskId?: string;
  windowIndex?: number;
  wsUrl?: string;
  visible?: boolean;
}
```

- [ ] **Step 2: Accept prop in component**

Update the function signature:

```typescript
export function TerminalView({ taskId, windowIndex, wsUrl: wsUrlProp, visible = true }: TerminalViewProps) {
```

- [ ] **Step 3: Add fit-on-show useEffect**

Add after the existing resize useEffect (after line 159), before the return:

```typescript
  // Fit terminal when it becomes visible (e.g. toggling between agent/editor views)
  useEffect(() => {
    if (visible && fitRef.current && termRef.current) {
      fitRef.current.fit();
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'resize',
            cols: termRef.current.cols,
            rows: termRef.current.rows,
          }),
        );
      }
    }
  }, [visible]);
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalView.tsx
git commit -m "feat(terminal): add visible prop for fit-on-show behavior"
```

---

## Chunk 4: Frontend — TaskDetail mode switching

### Task 9: Write tests for editor toggle behavior

**Files:**
- Modify: `src/pages/TaskDetail.test.tsx`

- [ ] **Step 1: Update the TerminalView mock to accept visible prop**

Update the mock at the top of `TaskDetail.test.tsx`:

```typescript
vi.mock('@/components/TerminalView', () => ({
  TerminalView: ({
    taskId,
    windowIndex,
    visible,
  }: {
    taskId: string;
    windowIndex: number;
    visible?: boolean;
  }) => (
    <div
      data-testid="terminal-view"
      data-task-id={taskId}
      data-window-index={windowIndex}
      data-visible={String(visible ?? true)}
    />
  ),
}));
```

- [ ] **Step 2: Write tests for editor button visibility**

Add a new describe block at the end of the `TaskDetail` describe:

```typescript
  // ─── Editor toggle ───────────────────────────────────────────────────────

  describe('editor toggle', () => {
    it('shows Editor button for running task with tmux session', async () => {
      renderDetail();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /editor/i })).toBeInTheDocument();
      });
    });

    const noEditorStatuses = ['draft', 'setting_up', 'closed', 'error'] as const;

    it.each(noEditorStatuses)('hides Editor button when status is "%s"', async (status) => {
      apiMock.getTask.mockResolvedValue(makeTask({ status, agents: [] }));
      renderDetail();
      await waitFor(() => {
        expect(screen.getByText('Fix order validation')).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /editor/i })).not.toBeInTheDocument();
    });

    it('toggles to editor mode on click', async () => {
      const user = userEvent.setup();
      renderDetail();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /editor/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /editor/i }));

      await waitFor(() => {
        expect(apiMock.createUserTerminal).toHaveBeenCalledWith('test-task-01');
      });
    });

    it('switches back to agents mode on second click', async () => {
      const user = userEvent.setup();
      renderDetail();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /editor/i })).toBeInTheDocument();
      });

      // Toggle to editor
      await user.click(screen.getByRole('button', { name: /editor/i }));
      await waitFor(() => {
        expect(apiMock.createUserTerminal).toHaveBeenCalled();
      });

      // Toggle back — agent tabs should be visible again
      await user.click(screen.getByRole('button', { name: /editor/i }));
      await waitFor(() => {
        expect(screen.getByText('Agent 1')).toBeInTheDocument();
      });
    });

    it('resets userWindowIndex when task leaves running state so next toggle re-creates', async () => {
      const user = userEvent.setup();
      renderDetail();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /editor/i })).toBeInTheDocument();
      });

      // Toggle to editor (first call creates the terminal)
      await user.click(screen.getByRole('button', { name: /editor/i }));
      await waitFor(() => {
        expect(apiMock.createUserTerminal).toHaveBeenCalledTimes(1);
      });

      // Simulate task going to setting_up (e.g. resume)
      apiMock.getTask.mockResolvedValue(
        makeTask({ status: 'setting_up', agents: [] }),
      );
      await waitFor(() => {
        expect(screen.getByText('Setting up terminal...')).toBeInTheDocument();
      });

      // Task comes back to running
      apiMock.getTask.mockResolvedValue(runningTask);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /editor/i })).toBeInTheDocument();
      });

      // Toggle to editor again — should call API again (index was reset)
      await user.click(screen.getByRole('button', { name: /editor/i }));
      await waitFor(() => {
        expect(apiMock.createUserTerminal).toHaveBeenCalledTimes(2);
      });
    });

    it('auto-switches to agents when task enters setting_up state', async () => {
      const user = userEvent.setup();
      renderDetail();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /editor/i })).toBeInTheDocument();
      });

      // Toggle to editor
      await user.click(screen.getByRole('button', { name: /editor/i }));
      await waitFor(() => {
        expect(apiMock.createUserTerminal).toHaveBeenCalled();
      });

      // Simulate task status change to setting_up (via polling)
      apiMock.getTask.mockResolvedValue(
        makeTask({ status: 'setting_up', agents: [] }),
      );

      // Agent tabs area should appear (auto-switched back)
      await waitFor(() => {
        expect(screen.getByText('Setting up terminal...')).toBeInTheDocument();
      });
    });
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun run test -- src/pages/TaskDetail.test.tsx -t "editor toggle"`
Expected: FAIL — no Editor button exists.

### Task 10: Implement editor toggle in TaskDetail

**Files:**
- Modify: `src/pages/TaskDetail.tsx`

- [ ] **Step 1: Add mode state and userWindowIndex**

In `TaskDetail`, after the existing state declarations (line ~18), add:

```typescript
  const [mode, setMode] = useState<'agents' | 'editor'>('agents');
  const [userWindowIndex, setUserWindowIndex] = useState<number | null>(null);
```

- [ ] **Step 2: Add auto-switch effect**

After the `activeWindow` initialization useEffect, add:

```typescript
  // Auto-switch back to agents and reset editor state when task enters non-running state
  useEffect(() => {
    if (task && task.status !== 'running') {
      setMode('agents');
      setUserWindowIndex(null);
    }
  }, [task?.status]);
```

- [ ] **Step 3: Add toggle handler**

After `handleResume`, add:

```typescript
  const handleToggleEditor = useCallback(async () => {
    if (mode === 'editor') {
      setMode('agents');
      return;
    }
    // Lazily create user terminal on first open
    if (userWindowIndex === null) {
      try {
        const result = await api.createUserTerminal(taskId);
        setUserWindowIndex(result.user_window_index);
      } catch (err) {
        console.error('Failed to create user terminal:', err);
        return;
      }
    }
    setMode('editor');
  }, [mode, userWindowIndex, taskId]);
```

- [ ] **Step 4: Add editor button to header**

In the header's button group (after the `canCreatePR` button, before the `isDraft` button), add:

```typescript
          {isRunning && !!task.tmux_session && (
            <Button
              variant={mode === 'editor' ? 'default' : 'outline'}
              size="sm"
              onClick={handleToggleEditor}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
              Editor
            </Button>
          )}
```

- [ ] **Step 5: Replace the terminal section with dual-mode rendering**

Replace the entire `{hasTerminal ? (...) : (...)}` section (lines ~195-217) with:

```typescript
      {/* Agent view — shown in agents mode */}
      {hasTerminal ? (
        <div className={mode === 'agents' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <AgentTabs
            agents={agents}
            activeIndex={activeWindow}
            onSelect={setActiveWindow}
            onAddAgent={handleAddAgent}
            onStopAgent={handleStopAgent}
            canAddAgent={isRunning}
          />
          <div className="min-h-0 flex-1 p-2">
            <TerminalView
              taskId={task.id}
              windowIndex={activeWindow!}
              visible={mode === 'agents'}
            />
          </div>
        </div>
      ) : (
        <div
          className={
            mode === 'agents'
              ? 'flex flex-1 items-center justify-center text-muted-foreground'
              : 'hidden'
          }
        >
          {task.status === 'draft' || task.status === 'setting_up'
            ? 'Setting up terminal...'
            : task.status === 'closed' || task.status === 'error'
              ? 'Terminal session ended'
              : 'No terminal available'}
        </div>
      )}

      {/* Editor view — shown in editor mode */}
      {userWindowIndex !== null && (
        <div className={mode === 'editor' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <div className="min-h-0 flex-1 p-2">
            <TerminalView
              taskId={task.id}
              windowIndex={userWindowIndex}
              visible={mode === 'editor'}
            />
          </div>
        </div>
      )}
```

- [ ] **Step 6: Run tests**

Run: `bun run test -- src/pages/TaskDetail.test.tsx`
Expected: All tests PASS (both old and new).

- [ ] **Step 7: Run all tests**

Run: `bun run test`
Expected: All tests PASS.

- [ ] **Step 8: Run typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/pages/TaskDetail.tsx src/pages/TaskDetail.test.tsx
git commit -m "feat(ui): add editor toggle with LazyVim user terminal on task detail"
```

---

## Chunk 5: Integration verification

### Task 11: Run full test suite and format

- [ ] **Step 1: Run all tests**

Run: `bun run test`
Expected: All tests PASS.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Run lint and format**

Run: `bun run lint:fix && bun run format`
Expected: PASS with no issues.

- [ ] **Step 4: Final commit if formatting changed anything**

```bash
git add -A
git commit -m "style: fix formatting"
```
