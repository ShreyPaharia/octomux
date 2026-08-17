# Editor Setting & Orchestrator Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable editor setting (nvim/vscode/cursor), auto-start the orchestrator on server boot with only a restart button, and remove the dead "default base branch" setting.

**Architecture:** Server-side settings stored in `~/.octomux/settings.json` (file-based, like orchestrator prompt). New `server/settings.ts` module with get/update. `createUserTerminal` branches on editor choice — nvim creates a tmux window with terminal view, vscode/cursor runs `code`/`cursor` CLI and returns a flag indicating no terminal needed. Orchestrator auto-starts in `server/index.ts` after task recovery. Frontend OrchestratorPage replaces Start/Stop with Restart.

**Tech Stack:** Express 5, better-sqlite3, React 19, Tailwind CSS 4, vitest

---

### Task 1: Server settings module (`server/settings.ts`)

**Files:**

- Create: `server/settings.ts`
- Test: `server/settings.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// server/settings.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSettings, updateSettings, DEFAULT_SETTINGS } from './settings.js';
import type { OctomuxSettings } from './settings.js';

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      promises: {
        ...actual.promises,
        readFile: vi.fn(),
        writeFile: vi.fn(),
        mkdir: vi.fn(),
      },
    },
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
    },
  };
});

import fs from 'fs';
const mockFs = vi.mocked(fs.promises);

describe('settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSettings', () => {
    it('returns default settings when file does not exist', async () => {
      mockFs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const settings = await getSettings();
      expect(settings).toEqual(DEFAULT_SETTINGS);
    });

    it('returns saved settings when file exists', async () => {
      const saved: OctomuxSettings = { editor: 'cursor' };
      mockFs.readFile.mockResolvedValue(JSON.stringify(saved));
      const settings = await getSettings();
      expect(settings).toEqual({ ...DEFAULT_SETTINGS, ...saved });
    });

    it('returns defaults merged with partial settings', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({}));
      const settings = await getSettings();
      expect(settings).toEqual(DEFAULT_SETTINGS);
    });
  });

  describe('updateSettings', () => {
    it('merges new settings with existing', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ editor: 'nvim' }));
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      const result = await updateSettings({ editor: 'vscode' });
      expect(result.editor).toBe('vscode');
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('settings.json'),
        JSON.stringify({ editor: 'vscode' }, null, 2),
        'utf-8',
      );
    });

    it('rejects invalid editor values', async () => {
      await expect(updateSettings({ editor: 'emacs' as any })).rejects.toThrow('Invalid editor');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- server/settings.test.ts`
Expected: FAIL — `./settings.js` module not found

- [ ] **Step 3: Implement `server/settings.ts`**

```typescript
// server/settings.ts
import fs from 'fs';
import path from 'path';
import os from 'os';

export type EditorChoice = 'nvim' | 'vscode' | 'cursor';

export interface OctomuxSettings {
  editor: EditorChoice;
}

export const DEFAULT_SETTINGS: OctomuxSettings = {
  editor: 'nvim',
};

const VALID_EDITORS: EditorChoice[] = ['nvim', 'vscode', 'cursor'];

function settingsPath(): string {
  return path.join(os.homedir(), '.octomux', 'settings.json');
}

export async function getSettings(): Promise<OctomuxSettings> {
  try {
    const raw = await fs.promises.readFile(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (err: any) {
    if (err.code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw err;
  }
}

export async function updateSettings(patch: Partial<OctomuxSettings>): Promise<OctomuxSettings> {
  if (patch.editor && !VALID_EDITORS.includes(patch.editor)) {
    throw new Error(`Invalid editor: ${patch.editor}. Must be one of: ${VALID_EDITORS.join(', ')}`);
  }

  const current = await getSettings();
  const merged = { ...current, ...patch };

  const filePath = settingsPath();
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf-8');

  return merged;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- server/settings.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add server/settings.ts server/settings.test.ts
git commit -m "feat(settings): add server-side settings module with editor choice"
```

---

### Task 2: Settings API endpoints

**Files:**

- Modify: `server/api.ts` — add `GET /api/settings` and `PATCH /api/settings`
- Modify: `server/api.test.ts` — add tests for new endpoints

- [ ] **Step 1: Write the failing tests**

Add to `server/api.test.ts`:

```typescript
describe('GET /api/settings', () => {
  it('returns default settings', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ editor: 'nvim' });
  });
});

describe('PATCH /api/settings', () => {
  it('updates editor setting', async () => {
    const res = await request(app).patch('/api/settings').send({ editor: 'cursor' });
    expect(res.status).toBe(200);
    expect(res.body.editor).toBe('cursor');
  });

  it('rejects invalid editor', async () => {
    const res = await request(app).patch('/api/settings').send({ editor: 'emacs' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- server/api.test.ts -t "settings"`
Expected: FAIL — 404 on /api/settings

- [ ] **Step 3: Add endpoints to `server/api.ts`**

Add import at top of `server/api.ts`:

```typescript
import { getSettings, updateSettings } from './settings.js';
```

Add before the orchestrator section:

```typescript
// ─── Settings ──────────────────────────────────────────────────────────────

app.get('/api/settings', async (_req: Request, res: Response) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.patch('/api/settings', async (req: Request, res: Response) => {
  try {
    const settings = await updateSettings(req.body);
    res.json(settings);
  } catch (err) {
    const message = (err as Error).message;
    if (message.startsWith('Invalid editor')) {
      res.status(400).json({ error: message });
    } else {
      res.status(500).json({ error: message });
    }
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- server/api.test.ts -t "settings"`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add server/api.ts server/api.test.ts
git commit -m "feat(api): add settings endpoints for editor configuration"
```

---

### Task 3: Client API + Settings page editor dropdown

**Files:**

- Modify: `src/lib/api.ts` — add `getSettings`, `updateSettings`
- Modify: `src/pages/SettingsPage.tsx` — add editor dropdown, remove dead settings

- [ ] **Step 1: Add client API methods to `src/lib/api.ts`**

Add the type and methods:

```typescript
export interface OctomuxSettings {
  editor: 'nvim' | 'vscode' | 'cursor';
}

// Inside the api object:
  getSettings: () => request<OctomuxSettings>('/settings'),
  updateSettings: (data: Partial<OctomuxSettings>) =>
    request<OctomuxSettings>('/settings', { method: 'PATCH', body: JSON.stringify(data) }),
```

- [ ] **Step 2: Update SettingsPage — remove dead settings, add editor dropdown**

In `src/pages/SettingsPage.tsx`:

1. Remove the entire "TASK DEFAULTS" section (lines 374-382) — the "Default base branch" row with hardcoded "main"

2. Remove the "Auto-start orchestrator" `SettingRow` (lines 386-391) — the non-functional toggle

3. Add a new "EDITOR" section before the "ORCHESTRATOR" section with a dropdown:

```tsx
function EditorSection() {
  const [editor, setEditor] = useState<string>('nvim');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setEditor(s.editor);
      })
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleChange = async (value: string) => {
    const prev = editor;
    setEditor(value);
    try {
      await api.updateSettings({ editor: value as 'nvim' | 'vscode' | 'cursor' });
      toast.success(`Editor set to ${value}`);
    } catch (err) {
      setEditor(prev);
      toast.error(err instanceof Error ? err.message : 'Failed to update editor');
    }
  };

  if (loading) return null;

  return (
    <section className="mb-8">
      <SectionHeader label="EDITOR" />
      <SettingRow
        label="Editor"
        description="Editor to open when clicking the Editor button on tasks"
      >
        <select
          value={editor}
          onChange={(e) => handleChange(e.target.value)}
          className="bg-[#141414] border border-[#2f2f2f] px-3 py-1 text-xs text-white outline-none focus:border-[#3B82F6]"
        >
          <option value="nvim">Neovim</option>
          <option value="vscode">VS Code</option>
          <option value="cursor">Cursor</option>
        </select>
      </SettingRow>
    </section>
  );
}
```

In the main `SettingsPage` render, add `<EditorSection />` before the orchestrator section.

- [ ] **Step 3: Run the app and verify**

Run: `bun run dev`
Navigate to Settings page — verify:

- "EDITOR" section with dropdown appears
- "TASK DEFAULTS" section (default base branch) is gone
- "Auto-start orchestrator" toggle is gone
- Changing editor shows toast and persists on page reload

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts src/pages/SettingsPage.tsx
git commit -m "feat(settings): add editor dropdown, remove dead settings from UI"
```

---

### Task 4: Branch `createUserTerminal` on editor setting

**Files:**

- Modify: `server/task-runner.ts` — update `createUserTerminal` to check editor setting
- Modify: `server/task-runner.test.ts` — add tests for vscode/cursor paths
- Modify: `server/api.ts` — update user-terminal endpoint response shape

- [ ] **Step 1: Write failing tests for vscode/cursor editor paths**

Add to `server/task-runner.test.ts` in the `createUserTerminal` describe block:

```typescript
it('opens vscode when editor setting is vscode', async () => {
  vi.mocked(settingsMod.getSettings).mockResolvedValue({ editor: 'vscode' });
  const task = getTask({ tmux_session: 'octomux-agent-abc', worktree: '/repo/.worktrees/test' });
  const result = await createUserTerminal(task);
  expect(result).toEqual({ editor: 'vscode', windowIndex: null });
  const call = findExecCall('code');
  expect(call).toBeTruthy();
  expect(call!.args).toContain('/repo/.worktrees/test');
});

it('opens cursor when editor setting is cursor', async () => {
  vi.mocked(settingsMod.getSettings).mockResolvedValue({ editor: 'cursor' });
  const task = getTask({ tmux_session: 'octomux-agent-abc', worktree: '/repo/.worktrees/test' });
  const result = await createUserTerminal(task);
  expect(result).toEqual({ editor: 'cursor', windowIndex: null });
  const call = findExecCall('cursor');
  expect(call).toBeTruthy();
  expect(call!.args).toContain('/repo/.worktrees/test');
});

it('creates tmux window with nvim when editor setting is nvim', async () => {
  vi.mocked(settingsMod.getSettings).mockResolvedValue({ editor: 'nvim' });
  const task = getTask({ tmux_session: 'octomux-agent-abc', worktree: '/repo/.worktrees/test' });
  const result = await createUserTerminal(task);
  expect(result).toEqual({ editor: 'nvim', windowIndex: expect.any(Number) });
});
```

You'll need to add `import * as settingsMod from './settings.js'` and mock it with `vi.mock('./settings.js')`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- server/task-runner.test.ts -t "editor"`
Expected: FAIL

- [ ] **Step 3: Update `createUserTerminal` in `server/task-runner.ts`**

Change the return type and add editor branching:

```typescript
import { getSettings } from './settings.js';

export interface UserTerminalResult {
  editor: 'nvim' | 'vscode' | 'cursor';
  windowIndex: number | null;
}

export async function createUserTerminal(task: Task): Promise<UserTerminalResult> {
  const settings = await getSettings();
  const editor = settings.editor;

  if (editor === 'vscode' || editor === 'cursor') {
    // Open the external editor pointing at the worktree — no tmux window needed
    const cmd = editor === 'vscode' ? 'code' : 'cursor';
    await execFile(cmd, [task.worktree!]);
    return { editor, windowIndex: null };
  }

  // nvim: existing behavior — create tmux window with nvim
  if (task.user_window_index !== null && task.user_window_index !== undefined) {
    return { editor: 'nvim', windowIndex: task.user_window_index };
  }

  const db = getDb();

  await execFile('tmux', ['new-window', '-t', task.tmux_session!, '-c', task.worktree!]);

  const windowIndex = await getLastWindowIndex(task.tmux_session!);

  await execFile('tmux', [
    'send-keys',
    '-t',
    `${task.tmux_session}:${windowIndex}`,
    'nvim .',
    'Enter',
  ]);

  db.prepare(
    `UPDATE tasks SET user_window_index = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(windowIndex, task.id);

  return { editor: 'nvim', windowIndex };
}
```

- [ ] **Step 4: Update the API endpoint response in `server/api.ts`**

Change the user-terminal endpoint (around line 570) to return the new shape:

```typescript
// Create user terminal (lazily creates tmux window with nvim, or opens external editor)
app.post('/api/tasks/:id/user-terminal', async (req: Request, res: Response) => {
  // ... existing validation ...
  try {
    const result = await createUserTerminal(task);
    broadcast({ type: 'task:updated', payload: { taskId: task.id } });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test -- server/task-runner.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add server/task-runner.ts server/task-runner.test.ts server/api.ts
git commit -m "feat(editor): branch createUserTerminal on editor setting (nvim/vscode/cursor)"
```

---

### Task 5: Update TaskDetail frontend for external editors

**Files:**

- Modify: `src/lib/api.ts` — update `createUserTerminal` return type
- Modify: `src/pages/TaskDetail.tsx` — handle vscode/cursor response (no terminal view)

- [ ] **Step 1: Update client API return type**

In `src/lib/api.ts`, change the `createUserTerminal` method:

```typescript
  createUserTerminal: (taskId: string) =>
    request<{ editor: string; windowIndex: number | null }>(`/tasks/${taskId}/user-terminal`, {
      method: 'POST',
    }),
```

- [ ] **Step 2: Update `handleToggleEditor` in `TaskDetail.tsx`**

Replace the existing `handleToggleEditor` callback:

```typescript
const [externalEditorOpen, setExternalEditorOpen] = useState(false);

const handleToggleEditor = useCallback(async () => {
  if (mode === 'editor') {
    setMode('agents');
    setExternalEditorOpen(false);
    return;
  }
  if (userWindowIndex === null && !externalEditorOpen) {
    if (creatingEditor) return;
    setCreatingEditor(true);
    try {
      const result = await api.createUserTerminal(taskId);
      if (result.editor === 'vscode' || result.editor === 'cursor') {
        // External editor opened — no terminal to show
        setExternalEditorOpen(true);
      } else {
        // nvim — set window index for terminal view
        setLocalUserWindowIndex(result.windowIndex);
      }
      refresh();
    } catch (err) {
      console.error('Failed to create user terminal:', err);
      return;
    } finally {
      setCreatingEditor(false);
    }
  }
  setMode('editor');
}, [mode, userWindowIndex, externalEditorOpen, taskId, creatingEditor, refresh]);
```

- [ ] **Step 3: Update the editor view rendering**

Replace the editor view section at the bottom of the JSX (lines 449-455):

```tsx
{
  /* Editor view */
}
{
  mode === 'editor' && (
    <div className="flex min-h-0 flex-1 flex-col">
      {externalEditorOpen ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-muted-foreground/50"
          >
            <path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
            <path d="m21 3-9 9" />
            <path d="M15 3h6v6" />
          </svg>
          <span className="text-sm">Opened in external editor</span>
          <Button
            variant="outline"
            size="sm"
            className="border-[#2f2f2f] text-[#8a8a8a]"
            onClick={handleToggleEditor}
          >
            Back to Agents
          </Button>
        </div>
      ) : userWindowIndex !== null ? (
        <div className="min-h-0 flex-1 overflow-hidden p-1">
          <TerminalView taskId={task.id} windowIndex={userWindowIndex} />
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Reset `externalEditorOpen` when task status changes**

In the existing `useEffect` that watches `task?.status` (around line 99), add:

```typescript
useEffect(() => {
  if (task && task.status !== 'running') {
    setMode('agents');
    setLocalUserWindowIndex(null);
    setExternalEditorOpen(false);
  }
}, [task?.status]);
```

- [ ] **Step 5: Run full test suite**

Run: `bun run test`
Expected: ALL PASS (TaskDetail tests should still work since they mock the API)

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/pages/TaskDetail.tsx
git commit -m "feat(editor): show external editor message for vscode/cursor, terminal for nvim"
```

---

### Task 6: Auto-start orchestrator on server boot

**Files:**

- Modify: `server/index.ts` — add orchestrator auto-start after task recovery

- [ ] **Step 1: Add orchestrator auto-start to `server/index.ts`**

Add import:

```typescript
import { startOrchestrator } from './orchestrator.js';
```

After `await cleanupOrphanedViewerSessions();` (line 65), add:

```typescript
// Auto-start orchestrator
startOrchestrator().catch((err) => {
  console.error('[startup] Failed to auto-start orchestrator:', err);
});
```

- [ ] **Step 2: Run the server and verify orchestrator starts**

Run: `bun run dev`
Check: `tmux has-session -t octomux-orchestrator` should succeed

- [ ] **Step 3: Commit**

```bash
git add server/index.ts
git commit -m "feat(orchestrator): auto-start orchestrator on server boot"
```

---

### Task 7: Replace Start/Stop with Restart on OrchestratorPage

**Files:**

- Modify: `src/pages/OrchestratorPage.tsx` — remove Start empty state, replace Stop with Restart
- Modify: `src/lib/hooks.ts` — add `restart` to `useOrchestrator`

- [ ] **Step 1: Add `restart` to `useOrchestrator` hook**

In `src/lib/hooks.ts`, add a `restart` callback inside `useOrchestrator`:

```typescript
const restart = useCallback(async () => {
  try {
    await api.orchestratorStop();
    await api.orchestratorStart();
    setRunning(true);
  } catch (err) {
    setError((err as Error).message);
  }
}, []);
```

Update the return:

```typescript
return { running, loading, error, start, stop, restart, refresh };
```

- [ ] **Step 2: Update OrchestratorPage**

Replace `src/pages/OrchestratorPage.tsx`:

1. In the header, replace the STOP button with RESTART:

```tsx
{
  running && (
    <Button
      variant="ghost"
      size="sm"
      className="uppercase text-xs tracking-wider font-bold text-[#8a8a8a]"
      onClick={restart}
    >
      RESTART
    </Button>
  );
}
```

2. Replace the empty state (the `!running` branch) with a loading/starting message:

```tsx
{
  loading ? (
    <div className="flex h-full items-center justify-center text-[#6a6a6a]">Loading...</div>
  ) : !running ? (
    <div className="flex h-full items-center justify-center text-[#6a6a6a]">
      Starting orchestrator...
    </div>
  ) : (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-[#6a6a6a]">
          Loading terminal...
        </div>
      }
    >
      <TerminalView wsUrl="/ws/terminal/orchestrator" visible />
    </Suspense>
  );
}
```

3. Update destructured values: `const { running, loading, restart } = useOrchestratorContext();`

4. Remove `start`, `stop` imports and `useState` for `showHelp` if the help popup is kept (keep `showHelp` if it stays).

- [ ] **Step 3: Run tests and verify**

Run: `bun run test`
Expected: ALL PASS (update any OrchestratorPage tests if they reference the Start/Stop buttons)

- [ ] **Step 4: Commit**

```bash
git add src/pages/OrchestratorPage.tsx src/lib/hooks.ts
git commit -m "feat(orchestrator): replace start/stop with restart, auto-start on boot"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full test suite**

Run: `bun run test`
Expected: ALL PASS

- [ ] **Step 2: Run linter and typecheck**

Run: `bun run lint && bun run typecheck`
Expected: No errors (warnings are OK)

- [ ] **Step 3: Manual smoke test**

Run: `bun run dev`
Verify:

1. Settings page shows Editor dropdown (nvim/vscode/cursor)
2. Settings page has NO "Default base branch" row
3. Settings page has NO "Auto-start orchestrator" toggle
4. Orchestrator auto-starts when server boots
5. Orchestrator page shows RESTART button (no START/STOP)
6. With editor=nvim: clicking Editor on a task opens nvim terminal view
7. With editor=vscode: clicking Editor on a task opens VS Code and shows "Opened in external editor" message
8. With editor=cursor: same as vscode but opens Cursor

- [ ] **Step 4: Commit any fixes, then create PR**
