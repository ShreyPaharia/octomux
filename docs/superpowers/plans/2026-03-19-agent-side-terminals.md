# Agent-Side Terminals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multiple user shell terminals per task, displayed as tabs alongside agent tabs in the same tab bar.

**Architecture:** New `user_terminals` DB table tracks shell terminal windows. Each terminal is a tmux window in the existing task session. The frontend extends `AgentTabs` to render both agent and terminal tabs side by side with a shared terminal viewport. Terminal activity is polled via tmux `pane_current_command`.

**Tech Stack:** SQLite (better-sqlite3), Express 5, tmux, node-pty, React 19, xterm.js, vitest, supertest

**Spec:** `docs/superpowers/specs/2026-03-19-agent-side-terminals-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/db.ts` | Schema: add `user_terminals` table + migration |
| `server/types.ts` | Types: `UserTerminal`, `UserTerminalStatus`, extend `Task` |
| `server/task-runner.ts` | Lifecycle: `createShellTerminal()`, `closeShellTerminal()`, cleanup in `closeTask()`/`resumeTask()` |
| `server/api.ts` | Routes: `POST /terminals`, `DELETE /terminals/:id`, include `user_terminals` in task responses |
| `server/poller.ts` | Activity: poll `pane_current_command` for terminal status |
| `src/lib/api.ts` | Client: `createTerminal()`, `closeTerminal()` |
| `src/components/AgentTabs.tsx` | UI: terminal tabs, separator, close buttons, `+` button |
| `src/pages/TaskDetail.tsx` | Wiring: terminal create/close handlers, pass data to `AgentTabs` |

---

### Task 1: Database Schema + Types

**Files:**
- Modify: `server/types.ts`
- Modify: `server/db.ts`
- Modify: `server/test-helpers.ts`
- Test: `server/db.test.ts`

- [ ] **Step 1: Add types to `server/types.ts`**

Add after the `Agent` interface:

```typescript
export type UserTerminalStatus = 'idle' | 'working';

export interface UserTerminal {
  id: string;
  task_id: string;
  window_index: number;
  label: string;
  status: UserTerminalStatus;
  created_at: string;
}
```

Add `user_terminals?: UserTerminal[]` to the `Task` interface (after `agents?`).

- [ ] **Step 2: Add `user_terminals` table to schema in `server/db.ts`**

Append to the `SCHEMA` string (after the `permission_prompts` table and before the existing indexes):

```sql
CREATE TABLE IF NOT EXISTS user_terminals (
    id           TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    window_index INTEGER NOT NULL,
    label        TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'idle',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_terminals_task ON user_terminals(task_id);
```

Note: Since we use `CREATE TABLE IF NOT EXISTS`, no migration needed for existing DBs — the table will be created on next startup.

- [ ] **Step 3: Add test helper for user terminals in `server/test-helpers.ts`**

Add a `DEFAULTS.userTerminal` fixture:

```typescript
userTerminal: {
  id: 'test-terminal-01',
  task_id: 'test-task-01',
  window_index: 2,
  label: 'Terminal 1',
  status: 'idle' as const,
  created_at: '2026-01-01 00:00:00',
},
```

Add `insertUserTerminal` helper:

```typescript
export function insertUserTerminal(
  db: Database.Database,
  overrides: Partial<UserTerminal> = {},
): UserTerminal {
  const ut: UserTerminal = { ...DEFAULTS.userTerminal, ...overrides } as UserTerminal;
  db.prepare(
    'INSERT INTO user_terminals (id, task_id, window_index, label, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(ut.id, ut.task_id, ut.window_index, ut.label, ut.status, ut.created_at);
  return ut;
}

export function getUserTerminals(db: Database.Database, taskId: string): UserTerminal[] {
  return db
    .prepare('SELECT * FROM user_terminals WHERE task_id = ? ORDER BY window_index')
    .all(taskId) as UserTerminal[];
}
```

Add `USER_TERMINALS_TABLE_COLUMNS` constant:

```typescript
export const USER_TERMINALS_TABLE_COLUMNS = [
  'id', 'task_id', 'window_index', 'label', 'status', 'created_at',
];
```

Import `UserTerminal` from `./types.js` at the top.

- [ ] **Step 4: Write test for user_terminals table in `server/db.test.ts`**

Add a test that verifies the `user_terminals` table exists and has the correct columns:

```typescript
it('creates user_terminals table with expected columns', () => {
  const cols = db.pragma('table_info(user_terminals)') as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  expect(names).toEqual(USER_TERMINALS_TABLE_COLUMNS);
});
```

Also test CASCADE delete:

```typescript
it('cascades user_terminals on task delete', () => {
  insertTask(db, DEFAULTS.runningTask);
  insertUserTerminal(db, { task_id: DEFAULTS.runningTask.id });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(DEFAULTS.runningTask.id);
  expect(getUserTerminals(db, DEFAULTS.runningTask.id)).toHaveLength(0);
});
```

- [ ] **Step 5: Run tests**

Run: `bun run test -- server/db.test.ts`
Expected: All tests pass including new user_terminals tests.

- [ ] **Step 6: Commit**

```bash
git add server/types.ts server/db.ts server/db.test.ts server/test-helpers.ts
git commit -m "feat(db): add user_terminals table and types"
```

---

### Task 2: Task Runner — Create and Close Shell Terminals

**Files:**
- Modify: `server/task-runner.ts`
- Test: `server/task-runner.test.ts`

- [ ] **Step 1: Write failing tests for `createShellTerminal`**

In `server/task-runner.test.ts`, add a new describe block:

```typescript
describe('createShellTerminal', () => {
  it('creates tmux window and returns terminal record', async () => {
    insertTask(db, DEFAULTS.runningTask);
    const terminal = await createShellTerminal(DEFAULTS.runningTask as Task);
    expect(terminal.label).toBe('Terminal 1');
    expect(terminal.task_id).toBe(DEFAULTS.runningTask.id);
    expect(typeof terminal.window_index).toBe('number');
    // Verify tmux new-window was called
    expect(findExecCall(execFile as any, {
      cmd: 'tmux',
      argsInclude: ['new-window'],
    })).toBeTruthy();
  });

  it('auto-increments terminal labels', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertUserTerminal(db, { task_id: DEFAULTS.runningTask.id });
    const terminal = await createShellTerminal(DEFAULTS.runningTask as Task);
    expect(terminal.label).toBe('Terminal 2');
  });

  it('inserts record into user_terminals table', async () => {
    insertTask(db, DEFAULTS.runningTask);
    const terminal = await createShellTerminal(DEFAULTS.runningTask as Task);
    const terminals = getUserTerminals(db, DEFAULTS.runningTask.id);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].id).toBe(terminal.id);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- server/task-runner.test.ts -t "createShellTerminal"`
Expected: FAIL — `createShellTerminal` is not defined.

- [ ] **Step 3: Implement `createShellTerminal` in `server/task-runner.ts`**

```typescript
export async function createShellTerminal(task: Task): Promise<UserTerminal> {
  const db = getDb();

  // Create new tmux window in the task's session
  await execFile('tmux', ['new-window', '-t', task.tmux_session!, '-c', task.worktree!]);
  const windowIndex = await getLastWindowIndex(task.tmux_session!);

  // Wait for shell to be ready
  const target = `${task.tmux_session}:${windowIndex}`;
  await waitForShellReady(target);

  // Determine label (COUNT + 1)
  const { count } = db
    .prepare('SELECT COUNT(*) as count FROM user_terminals WHERE task_id = ?')
    .get(task.id) as { count: number };
  const label = `Terminal ${count + 1}`;

  // Insert record
  const id = nanoid(12);
  db.prepare(
    `INSERT INTO user_terminals (id, task_id, window_index, label) VALUES (?, ?, ?, ?)`,
  ).run(id, task.id, windowIndex, label);

  return {
    id,
    task_id: task.id,
    window_index: windowIndex,
    label,
    status: 'idle',
    created_at: new Date().toISOString(),
  };
}
```

Import `UserTerminal` from `./types.js` at the top of the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- server/task-runner.test.ts -t "createShellTerminal"`
Expected: PASS

- [ ] **Step 5: Write failing tests for `closeShellTerminal`**

```typescript
describe('closeShellTerminal', () => {
  it('kills tmux window and deletes DB record', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertUserTerminal(db, { task_id: DEFAULTS.runningTask.id });
    await closeShellTerminal(DEFAULTS.runningTask as Task, DEFAULTS.userTerminal as any);
    // Verify tmux kill-window was called
    expect(findExecCall(execFile as any, {
      cmd: 'tmux',
      argsInclude: ['kill-window'],
    })).toBeTruthy();
    // Verify DB record deleted
    expect(getUserTerminals(db, DEFAULTS.runningTask.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun run test -- server/task-runner.test.ts -t "closeShellTerminal"`
Expected: FAIL

- [ ] **Step 7: Implement `closeShellTerminal`**

```typescript
export async function closeShellTerminal(task: Task, terminal: UserTerminal): Promise<void> {
  const db = getDb();

  // Kill the tmux window
  await execFile('tmux', [
    'kill-window',
    '-t',
    `${task.tmux_session}:${terminal.window_index}`,
  ]).catch(() => {});

  // Delete DB record
  db.prepare('DELETE FROM user_terminals WHERE id = ?').run(terminal.id);
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `bun run test -- server/task-runner.test.ts -t "closeShellTerminal"`
Expected: PASS

- [ ] **Step 9: Write failing tests for lifecycle cleanup**

```typescript
describe('closeTask — user terminal cleanup', () => {
  it('deletes user_terminals rows on close', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertAgent(db);
    insertUserTerminal(db, { task_id: DEFAULTS.runningTask.id });
    await closeTask(DEFAULTS.runningTask as Task);
    expect(getUserTerminals(db, DEFAULTS.runningTask.id)).toHaveLength(0);
  });
});

describe('resumeTask — user terminal cleanup', () => {
  it('deletes user_terminals rows on resume', async () => {
    const closedTask = { ...DEFAULTS.runningTask, status: 'closed' as const };
    insertTask(db, closedTask);
    insertAgent(db, { status: 'stopped' });
    insertUserTerminal(db, { task_id: closedTask.id });
    await resumeTask(closedTask as Task);
    expect(getUserTerminals(db, closedTask.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 10: Run tests to verify they fail**

Run: `bun run test -- server/task-runner.test.ts -t "user terminal cleanup"`
Expected: FAIL

- [ ] **Step 11: Add cleanup to `closeTask` and `resumeTask`**

In `closeTask()`, add before the existing agent update:

```typescript
db.prepare('DELETE FROM user_terminals WHERE task_id = ?').run(task.id);
```

In `resumeTask()`, add after the `user_window_index = NULL` reset (the existing UPDATE statement on ~line 370):

```typescript
db.prepare('DELETE FROM user_terminals WHERE task_id = ?').run(task.id);
```

- [ ] **Step 12: Run tests to verify they pass**

Run: `bun run test -- server/task-runner.test.ts`
Expected: All tests pass.

- [ ] **Step 13: Commit**

```bash
git add server/task-runner.ts server/task-runner.test.ts
git commit -m "feat(task-runner): add createShellTerminal and closeShellTerminal"
```

---

### Task 3: API Endpoints + Task Response Enrichment

**Files:**
- Modify: `server/api.ts`
- Test: `server/api.test.ts`

- [ ] **Step 1: Write failing tests for the new endpoints**

In `server/api.test.ts`, add to the mock at the top — alongside the existing `createUserTerminal` mock, add mocks for the new functions:

```typescript
createShellTerminal: vi.fn(async (task: any) => ({
  id: 'new-terminal-id',
  task_id: task.id,
  window_index: 3,
  label: 'Terminal 1',
  status: 'idle',
  created_at: '2026-01-01T00:00:00.000Z',
})),
closeShellTerminal: vi.fn(),
```

Also update the import at line ~81 to include the new functions.

Then add tests:

```typescript
describe('POST /api/tasks/:id/terminals', () => {
  it('creates a terminal for a running task', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertAgent(db);
    const res = await request(app).post(`/api/tasks/${DEFAULTS.runningTask.id}/terminals`);
    expect(res.status).toBe(201);
    expect(res.body.label).toBe('Terminal 1');
    expect(createShellTerminal).toHaveBeenCalled();
  });

  it('returns 400 for non-running task', async () => {
    insertTask(db);
    const res = await request(app).post(`/api/tasks/${DEFAULTS.task.id}/terminals`);
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown task', async () => {
    const res = await request(app).post('/api/tasks/unknown/terminals');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/tasks/:id/terminals/:terminalId', () => {
  it('closes a terminal', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertUserTerminal(db, { task_id: DEFAULTS.runningTask.id });
    const res = await request(app).delete(
      `/api/tasks/${DEFAULTS.runningTask.id}/terminals/${DEFAULTS.userTerminal.id}`,
    );
    expect(res.status).toBe(204);
    expect(closeShellTerminal).toHaveBeenCalled();
  });

  it('returns 404 for unknown terminal', async () => {
    insertTask(db, DEFAULTS.runningTask);
    const res = await request(app).delete(
      `/api/tasks/${DEFAULTS.runningTask.id}/terminals/unknown`,
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- server/api.test.ts -t "terminals"`
Expected: FAIL — routes not defined.

- [ ] **Step 3: Write failing test for user_terminals in task GET response**

```typescript
describe('GET /api/tasks/:id — user_terminals', () => {
  it('includes user_terminals array in response', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertAgent(db);
    insertUserTerminal(db, { task_id: DEFAULTS.runningTask.id });
    const res = await request(app).get(`/api/tasks/${DEFAULTS.runningTask.id}`);
    expect(res.status).toBe(200);
    expect(res.body.user_terminals).toHaveLength(1);
    expect(res.body.user_terminals[0].label).toBe('Terminal 1');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun run test -- server/api.test.ts -t "user_terminals"`
Expected: FAIL — `user_terminals` not in response.

- [ ] **Step 5: Implement endpoints and response enrichment in `server/api.ts`**

Import the new functions at the top:

```typescript
import {
  // ... existing imports ...
  createShellTerminal,
  closeShellTerminal,
} from './task-runner.js';
import type { UserTerminal } from './types.js';
```

Add a prepared statement for querying user terminals. Create a helper to enrich task responses — add this inside `setupRoutes` near the top:

```typescript
const userTerminalStmt = db.prepare(
  'SELECT * FROM user_terminals WHERE task_id = ? ORDER BY window_index',
);
```

Wait — `db` isn't available at route setup time (it's called per-request). Instead, add the query inline wherever tasks are returned. In each endpoint that returns a task, after setting `agents` and `pending_prompts`, add:

```typescript
const userTerminals = db
  .prepare('SELECT * FROM user_terminals WHERE task_id = ? ORDER BY window_index')
  .all(task.id) as UserTerminal[];
```

And include `user_terminals: userTerminals` in the response.

**Endpoints to update (all places that return a task object):**
- `GET /api/tasks` (list) — in the `.map()` callback
- `GET /api/tasks/:id` (single)
- `POST /api/tasks` (create)
- `PATCH /api/tasks/:id` (update)
- `POST /api/tasks/:id/start` (start draft)
- `POST /api/tasks/:id/agents` (add agent) — returns agent, but triggers `task:updated` broadcast so sidebar refreshes via polling
- `DELETE /api/tasks/:id/agents/:agentId` — same as above
- `POST /api/tasks/:id/user-terminal` — same as above

For the endpoints that return a full task object (GET, POST create, PATCH, POST start), add `user_terminals` to the response. For mutation endpoints that return just the agent/success, the broadcast event will trigger a refresh.

Add the two new route handlers:

```typescript
// Create shell terminal
app.post('/api/tasks/:id/terminals', async (req: Request, res: Response) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as Task | undefined;

  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  if (task.status !== 'running') {
    res.status(400).json({ error: 'Can only create terminals for running tasks' });
    return;
  }

  if (!task.tmux_session) {
    res.status(400).json({ error: 'Task has no tmux session' });
    return;
  }

  try {
    const terminal = await createShellTerminal(task);
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    res.status(201).json(terminal);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Close shell terminal
app.delete('/api/tasks/:id/terminals/:terminalId', async (req: Request, res: Response) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as Task | undefined;

  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  const terminal = db
    .prepare('SELECT * FROM user_terminals WHERE id = ? AND task_id = ?')
    .get(req.params.terminalId, req.params.id) as UserTerminal | undefined;

  if (!terminal) {
    res.status(404).json({ error: 'Terminal not found' });
    return;
  }

  try {
    await closeShellTerminal(task, terminal);
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 6: Run all api tests**

Run: `bun run test -- server/api.test.ts`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/api.ts server/api.test.ts
git commit -m "feat(api): add terminal create/close endpoints and enrich task responses"
```

---

### Task 4: Activity Polling

**Files:**
- Modify: `server/poller.ts`
- Test: `server/poller.test.ts`

- [ ] **Step 1: Write failing test for terminal activity polling**

In `server/poller.test.ts`, add:

```typescript
describe('pollTerminalActivity', () => {
  it('updates terminal status to working when process is not shell', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertUserTerminal(db, {
      task_id: DEFAULTS.runningTask.id,
      status: 'idle',
    });

    // Mock pane_current_command returning "npm"
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cmdArgs = args[1] as string[];
      const cb = findCallback(...args);
      if (cmdArgs?.includes('list-panes')) {
        cb(null, { stdout: 'npm', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    });

    await pollTerminalActivity();
    const terminals = getUserTerminals(db, DEFAULTS.runningTask.id);
    expect(terminals[0].status).toBe('working');
  });

  it('updates terminal status to idle when process is shell', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertUserTerminal(db, {
      task_id: DEFAULTS.runningTask.id,
      status: 'working',
    });

    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cmdArgs = args[1] as string[];
      const cb = findCallback(...args);
      if (cmdArgs?.includes('list-panes')) {
        cb(null, { stdout: 'zsh', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    });

    await pollTerminalActivity();
    const terminals = getUserTerminals(db, DEFAULTS.runningTask.id);
    expect(terminals[0].status).toBe('idle');
  });

  it('broadcasts update when status changes', async () => {
    insertTask(db, DEFAULTS.runningTask);
    insertUserTerminal(db, {
      task_id: DEFAULTS.runningTask.id,
      status: 'idle',
    });

    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cmdArgs = args[1] as string[];
      const cb = findCallback(...args);
      if (cmdArgs?.includes('list-panes')) {
        cb(null, { stdout: 'npm', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
      return undefined as any;
    });

    await pollTerminalActivity();
    expect(broadcast).toHaveBeenCalledWith({
      type: 'task:updated',
      payload: { taskId: DEFAULTS.runningTask.id },
    });
  });
});
```

Add `broadcast` to the mocks if not already mocked — add:

```typescript
vi.mock('./events.js', () => ({
  broadcast: vi.fn(),
}));
const { broadcast } = await import('./events.js');
```

Also import `insertUserTerminal` and `getUserTerminals` from test-helpers.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- server/poller.test.ts -t "pollTerminalActivity"`
Expected: FAIL — function not defined.

- [ ] **Step 3: Implement `pollTerminalActivity` in `server/poller.ts`**

```typescript
const SHELL_COMMANDS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash']);

export async function pollTerminalActivity(): Promise<void> {
  const db = getDb();
  const runningTasks = db
    .prepare("SELECT * FROM tasks WHERE status = 'running' AND tmux_session IS NOT NULL")
    .all() as Task[];

  for (const task of runningTasks) {
    const terminals = db
      .prepare('SELECT * FROM user_terminals WHERE task_id = ?')
      .all(task.id) as UserTerminal[];

    let changed = false;
    for (const terminal of terminals) {
      try {
        const { stdout } = await execFile('tmux', [
          'list-panes',
          '-t',
          `${task.tmux_session}:${terminal.window_index}`,
          '-F',
          '#{pane_current_command}',
        ]);
        const command = stdout.trim().split('\n')[0];
        const newStatus = SHELL_COMMANDS.has(command) ? 'idle' : 'working';
        if (newStatus !== terminal.status) {
          db.prepare('UPDATE user_terminals SET status = ? WHERE id = ?').run(
            newStatus,
            terminal.id,
          );
          changed = true;
        }
      } catch {
        // Window may have been killed — ignore
      }
    }
    if (changed) {
      broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    }
  }
}
```

Import `UserTerminal` from `./types.js` and `broadcast` from `./events.js` at the top.

Add `pollTerminalActivity` to the status polling interval — call it from within `pollStatuses()` at the end:

```typescript
await pollTerminalActivity();
```

Or alternatively, add it as a separate call in `startPolling()` on the same interval as `pollStatuses`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- server/poller.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/poller.ts server/poller.test.ts
git commit -m "feat(poller): add terminal activity polling via pane_current_command"
```

---

### Task 5: Frontend API Client

**Files:**
- Modify: `src/lib/api.ts`
- Test: `src/lib/api.test.tsx`

- [ ] **Step 1: Write failing tests**

In `src/lib/api.test.tsx`, add tests for the new methods. Follow the existing test pattern (mock fetch, verify URL/method):

```typescript
describe('createTerminal', () => {
  it('sends POST to /api/tasks/:id/terminals', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 't1', window_index: 3, label: 'Terminal 1' }), {
        status: 201,
      }),
    );
    const result = await api.createTerminal('task-1');
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1/terminals', expect.objectContaining({
      method: 'POST',
    }));
    expect(result.label).toBe('Terminal 1');
  });
});

describe('closeTerminal', () => {
  it('sends DELETE to /api/tasks/:id/terminals/:terminalId', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.closeTerminal('task-1', 'term-1');
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1/terminals/term-1', expect.objectContaining({
      method: 'DELETE',
    }));
  });
});
```

Adapt to match the exact test patterns in the existing `api.test.tsx` file (check how `fetchMock` is set up).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- src/lib/api.test.tsx -t "createTerminal|closeTerminal"`
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Add methods to `src/lib/api.ts`**

Add after the existing `createUserTerminal` method:

```typescript
createTerminal: (taskId: string) =>
  request<UserTerminal>(`/tasks/${taskId}/terminals`, { method: 'POST', body: JSON.stringify({}) }),
closeTerminal: (taskId: string, terminalId: string) =>
  request<void>(`/tasks/${taskId}/terminals/${terminalId}`, { method: 'DELETE' }),
```

Import `UserTerminal` from `../../server/types` at the top.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- src/lib/api.test.tsx`
Expected: All tests pass.

- [ ] **Step 5: Update `mockApi` in `src/test-helpers.tsx`**

Add mocks for the new methods:

```typescript
createTerminal: vi.fn().mockResolvedValue({
  id: 'term-1',
  task_id: 'test-task-01',
  window_index: 3,
  label: 'Terminal 1',
  status: 'idle',
  created_at: '',
}),
closeTerminal: vi.fn().mockResolvedValue(undefined),
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/lib/api.test.tsx src/test-helpers.tsx
git commit -m "feat(api-client): add createTerminal and closeTerminal methods"
```

---

### Task 6: AgentTabs Component — Terminal Tabs UI

**Files:**
- Modify: `src/components/AgentTabs.tsx`
- Test: `src/components/AgentTabs.test.tsx`

- [ ] **Step 1: Write failing tests**

In `src/components/AgentTabs.test.tsx`, add new test cases. First, create a `makeUserTerminal` helper at the top or import from test-helpers:

```typescript
import type { UserTerminal } from '../../server/types';

function makeUserTerminal(overrides: Partial<UserTerminal> = {}): UserTerminal {
  return {
    id: 'term-1',
    task_id: 'test-task-01',
    window_index: 2,
    label: 'Terminal 1',
    status: 'idle' as const,
    created_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}
```

Update `defaultProps` to include the new props:

```typescript
const onAddTerminal = vi.fn();
const onCloseTerminal = vi.fn();

const defaultProps = {
  // ... existing
  userTerminals: [] as UserTerminal[],
  onAddTerminal,
  onCloseTerminal,
};
```

Add tests:

```typescript
describe('Terminal tabs', () => {
  it('renders terminal labels', () => {
    const terminals = [makeUserTerminal()];
    renderWithRouter(<AgentTabs {...defaultProps} agents={[makeAgent()]} userTerminals={terminals} />);
    expect(screen.getByText('Terminal 1')).toBeInTheDocument();
  });

  it('renders separator between agent and terminal groups', () => {
    const terminals = [makeUserTerminal()];
    const { container } = renderWithRouter(
      <AgentTabs {...defaultProps} agents={[makeAgent()]} userTerminals={terminals} />,
    );
    expect(container.querySelector('[data-testid="tab-separator"]')).toBeInTheDocument();
  });

  it('calls onSelect when clicking terminal tab', async () => {
    const user = userEvent.setup();
    const terminals = [makeUserTerminal({ window_index: 5 })];
    renderWithRouter(<AgentTabs {...defaultProps} agents={[makeAgent()]} userTerminals={terminals} />);
    await user.click(screen.getByText('Terminal 1'));
    expect(onSelect).toHaveBeenCalledWith(5);
  });

  it('calls onCloseTerminal when clicking close button', async () => {
    const user = userEvent.setup();
    const terminals = [makeUserTerminal()];
    renderWithRouter(<AgentTabs {...defaultProps} agents={[makeAgent()]} userTerminals={terminals} />);
    await user.click(screen.getByTitle('Close terminal'));
    expect(onCloseTerminal).toHaveBeenCalledWith('term-1');
  });

  it('calls onAddTerminal when clicking terminal + button', async () => {
    const user = userEvent.setup();
    renderWithRouter(<AgentTabs {...defaultProps} agents={[makeAgent()]} userTerminals={[]} />);
    // The terminal + button — distinguish from agent + by test ID or position
    await user.click(screen.getByTitle('Add terminal'));
    expect(onAddTerminal).toHaveBeenCalled();
  });

  it('shows working indicator for working terminals', () => {
    const terminals = [makeUserTerminal({ status: 'working' })];
    const { container } = renderWithRouter(
      <AgentTabs {...defaultProps} agents={[makeAgent()]} userTerminals={terminals} />,
    );
    // Should have green pulse dot (same as active agent)
    const dots = container.querySelectorAll('.animate-pulse');
    expect(dots.length).toBeGreaterThanOrEqual(2); // agent + terminal
  });

  it('shows idle indicator for idle terminals', () => {
    const terminals = [makeUserTerminal({ status: 'idle' })];
    const { container } = renderWithRouter(
      <AgentTabs {...defaultProps} agents={[makeAgent()]} userTerminals={terminals} />,
    );
    expect(container.querySelector('.bg-zinc-400')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- src/components/AgentTabs.test.tsx -t "Terminal tabs"`
Expected: FAIL

- [ ] **Step 3: Update `AgentTabs` component**

Update the props interface:

```typescript
import type { Agent, UserTerminal } from '../../server/types';

interface AgentTabsProps {
  agents: Agent[];
  activeIndex: number;
  onSelect: (windowIndex: number) => void;
  onAddAgent: (prompt?: string) => void;
  onStopAgent: (agentId: string) => void;
  canAddAgent: boolean;
  userTerminals?: UserTerminal[];
  onAddTerminal?: () => void;
  onCloseTerminal?: (terminalId: string) => void;
}
```

Update the component to render terminal tabs after agent tabs:

```tsx
export function AgentTabs({
  agents,
  activeIndex,
  onSelect,
  onAddAgent,
  onStopAgent,
  canAddAgent,
  userTerminals = [],
  onAddTerminal,
  onCloseTerminal,
}: AgentTabsProps) {
  return (
    <div className="flex items-center gap-1 border-b border-border px-1 pb-1">
      {/* Agent tabs (existing) */}
      {agents
        .filter((agent) => agent.status !== 'stopped')
        .map((agent) => (
          // ... existing agent tab JSX unchanged ...
        ))}
      {canAddAgent && <AddAgentButton onAdd={onAddAgent} />}

      {/* Separator */}
      {(userTerminals.length > 0 || onAddTerminal) && (
        <div
          data-testid="tab-separator"
          className="mx-1 h-5 w-px bg-border"
        />
      )}

      {/* Terminal tabs */}
      {userTerminals.map((terminal) => (
        <div key={terminal.id} className="group flex items-center">
          <button
            className={cn(
              'rounded-t-md px-3 py-1.5 text-sm transition-colors',
              terminal.window_index === activeIndex
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => onSelect(terminal.window_index)}
          >
            {terminal.label}
            <span
              className={`ml-1.5 inline-block h-1.5 w-1.5 rounded-full ${
                terminal.status === 'working'
                  ? 'animate-pulse bg-green-400'
                  : 'bg-zinc-400'
              }`}
            />
          </button>
          {onCloseTerminal && (
            <button
              className="ml-0.5 hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:inline-flex"
              onClick={(e) => {
                e.stopPropagation();
                onCloseTerminal(terminal.id);
              }}
              title="Close terminal"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" /><path d="m6 6 12 12" />
              </svg>
            </button>
          )}
        </div>
      ))}

      {/* Terminal add button */}
      {onAddTerminal && (
        <button
          className="rounded-t-md px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground"
          onClick={onAddTerminal}
          title="Add terminal"
        >
          +
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- src/components/AgentTabs.test.tsx`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/AgentTabs.tsx src/components/AgentTabs.test.tsx
git commit -m "feat(ui): add terminal tabs to AgentTabs component"
```

---

### Task 7: TaskDetail Wiring

**Files:**
- Modify: `src/pages/TaskDetail.tsx`
- Test: `src/pages/TaskDetail.test.tsx`

- [ ] **Step 1: Write failing tests**

In `src/pages/TaskDetail.test.tsx`, add tests for terminal interaction. Check the existing test file structure first — it likely mocks `@/lib/api` and `@/lib/hooks`. Add tests:

```typescript
describe('User terminals', () => {
  it('passes user_terminals to AgentTabs', async () => {
    const taskWithTerminals = makeTask({
      agents: [makeAgent()],
      user_terminals: [{
        id: 'term-1',
        task_id: 'test-task-01',
        window_index: 3,
        label: 'Terminal 1',
        status: 'idle' as const,
        created_at: '',
      }],
    });
    // Render and verify Terminal 1 tab appears
    // (exact implementation depends on existing test setup)
  });

  it('creates terminal on + click and switches to it', async () => {
    // Click terminal + button, verify api.createTerminal called, activeWindow changes
  });

  it('closes terminal and switches to agent tab', async () => {
    // Click terminal close, verify api.closeTerminal called
  });
});
```

Note: Adapt these tests to match the existing patterns in `TaskDetail.test.tsx` — check how it mocks hooks, renders the component, etc.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- src/pages/TaskDetail.test.tsx -t "User terminals"`
Expected: FAIL

- [ ] **Step 3: Implement handlers in `TaskDetail.tsx`**

Add handlers:

```typescript
const handleAddTerminal = useCallback(async () => {
  if (!taskId) return;
  try {
    const terminal = await api.createTerminal(taskId);
    setActiveWindow(terminal.window_index);
    refresh();
  } catch (err) {
    console.error('Failed to create terminal:', err);
  }
}, [taskId, refresh]);

const handleCloseTerminal = useCallback(
  async (terminalId: string) => {
    if (!taskId) return;
    try {
      const terminals = task?.user_terminals || [];
      const closedTerminal = terminals.find((t) => t.id === terminalId);
      await api.closeTerminal(taskId, terminalId);
      // If we closed the active tab, switch to first agent or next terminal
      if (closedTerminal && closedTerminal.window_index === activeWindow) {
        const agents = task?.agents || [];
        const runningAgent = agents.find((a) => a.status !== 'stopped');
        const otherTerminal = terminals.find((t) => t.id !== terminalId);
        setActiveWindow(runningAgent?.window_index ?? otherTerminal?.window_index ?? null);
      }
      refresh();
    } catch (err) {
      console.error('Failed to close terminal:', err);
    }
  },
  [taskId, refresh, task, activeWindow],
);
```

Pass the new props to `AgentTabs`:

```tsx
<AgentTabs
  agents={agents}
  activeIndex={activeWindow}
  onSelect={setActiveWindow}
  onAddAgent={handleAddAgent}
  onStopAgent={handleStopAgent}
  canAddAgent={isRunning}
  userTerminals={isRunning ? (task.user_terminals || []) : []}
  onAddTerminal={isRunning ? handleAddTerminal : undefined}
  onCloseTerminal={isRunning ? handleCloseTerminal : undefined}
/>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- src/pages/TaskDetail.test.tsx`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pages/TaskDetail.tsx src/pages/TaskDetail.test.tsx
git commit -m "feat(ui): wire up terminal create/close in TaskDetail"
```

---

### Task 8: Integration Verification

- [ ] **Step 1: Run full test suite**

Run: `bun run test`
Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 3: Run lint**

Run: `bun run lint`
Expected: No errors (or only pre-existing warnings).

- [ ] **Step 4: Manual smoke test**

1. Start the dev server: `bun run dev`
2. Create a task and start it
3. Verify agent tabs appear as before
4. Click the terminal `+` button — a "Terminal 1" tab should appear
5. Click it — should show a shell prompt in the worktree
6. Run a command (e.g., `ls`, `git status`) — tab dot should turn green while running
7. Create a second terminal — "Terminal 2" tab appears
8. Click the `×` on Terminal 1 — tab disappears, view switches
9. Close the task — terminal tabs disappear
10. Resume the task — no terminal tabs (ephemeral)

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address integration issues from smoke test"
```
