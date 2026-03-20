# Orchestrator Command Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent command bar to the dashboard with quick action chips and slash command autocomplete that forwards messages to the orchestrator Claude session.

**Architecture:** New `OrchestratorCommandBar` component on the dashboard with a shared `COMMANDS` data source driving both chips and slash autocomplete. A new `POST /api/orchestrator/send` endpoint handles message delivery to the tmux session, with auto-start support baked into the initial Claude prompt. The orchestrator modal remains unchanged.

**Tech Stack:** React 19, Tailwind CSS 4, shadcn/ui, Express 5, node-pty/tmux

**Spec:** `docs/superpowers/specs/2026-03-19-orchestrator-command-bar-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/lib/orchestrator-commands.ts` | Shared COMMANDS array (slash + chips) |
| Create | `src/components/OrchestratorCommandBar.tsx` | Command bar component (input, chips, slash menu) |
| Create | `src/components/OrchestratorCommandBar.test.tsx` | Tests for the command bar |
| Modify | `server/orchestrator.ts` | Add `sendToOrchestrator()`, modify `startOrchestrator()` to accept initial message |
| Modify | `server/orchestrator.test.ts` | Tests for new orchestrator functions |
| Modify | `server/api.ts` | Add `POST /api/orchestrator/send` route |
| Modify | `server/api.test.ts` | Tests for the new endpoint |
| Modify | `src/lib/api.ts` | Add `orchestratorSend()` client method |
| Modify | `src/lib/api.test.tsx` | Test the new API method |
| Modify | `src/pages/Dashboard.tsx` | Integrate OrchestratorCommandBar |
| Modify | `src/pages/Dashboard.test.tsx` | Update dashboard tests |
| Modify | `src/test-helpers.tsx` | Add `orchestratorSend` to `mockApi()` |

---

## Batch 1: Backend — Orchestrator Send

### Task 1: Extend `orchestrator.ts` with `sendToOrchestrator` and `startOrchestrator` initial message support

**Files:**
- Modify: `server/orchestrator.ts`
- Modify: `server/orchestrator.test.ts`

- [ ] **Step 1: Write failing tests for `sendToOrchestrator`**

Add to `server/orchestrator.test.ts`:

```ts
describe('sendToOrchestrator', () => {
  it('sends message via tmux send-keys with literal flag then Enter separately', async () => {
    await sendToOrchestrator('hello world');

    const calls = vi.mocked(execFile).mock.calls;
    // has-session check + send-keys -l (message) + send-keys (Enter)
    expect(calls).toHaveLength(3);
    // Literal message send
    expect(calls[1][0]).toBe('tmux');
    expect(calls[1][1]).toEqual(['send-keys', '-l', '-t', 'octomux-orchestrator', 'hello world']);
    // Enter key send (NOT literal)
    expect(calls[2][0]).toBe('tmux');
    expect(calls[2][1]).toEqual(['send-keys', '-t', 'octomux-orchestrator', 'Enter']);
  });

  it('throws if orchestrator is not running', async () => {
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const cb = args.find((a: any) => typeof a === 'function');
      if (cb) cb(new Error('session not found'));
      return undefined as any;
    });

    await expect(sendToOrchestrator('hello')).rejects.toThrow('Orchestrator is not running');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- server/orchestrator.test.ts`
Expected: FAIL — `sendToOrchestrator` is not exported

- [ ] **Step 3: Implement `sendToOrchestrator` in `orchestrator.ts`**

Add to `server/orchestrator.ts`:

```ts
export async function sendToOrchestrator(message: string): Promise<void> {
  if (!(await isOrchestratorRunning())) {
    throw new Error('Orchestrator is not running');
  }
  // Use -l (literal) to prevent tmux from interpreting key names in the message.
  // Must be a separate call from 'Enter' because -l makes ALL args literal.
  await execFile('tmux', ['send-keys', '-l', '-t', ORCHESTRATOR_SESSION, message]);
  await execFile('tmux', ['send-keys', '-t', ORCHESTRATOR_SESSION, 'Enter']);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- server/orchestrator.test.ts`
Expected: All PASS

- [ ] **Step 5: Write failing test for `startOrchestrator` with initial message**

Add to the existing `startOrchestrator` describe block in `server/orchestrator.test.ts`:

```ts
it('bakes initial message into claude launch command', async () => {
  let callCount = 0;
  vi.mocked(execFile).mockImplementation((...args: any[]) => {
    callCount++;
    const cb = args.find((a: any) => typeof a === 'function');
    if (callCount === 1) {
      if (cb) cb(new Error('no session'));
    } else {
      if (cb) cb(null, { stdout: '', stderr: '' });
    }
    return undefined as any;
  });

  await startOrchestrator('/test/cwd', 'Create a task to fix bugs');

  const sendKeysCall = vi.mocked(execFile).mock.calls[2];
  const claudeCmd = (sendKeysCall[1] as string[])[
    (sendKeysCall[1] as string[]).indexOf('-t') + 2
  ];
  expect(claudeCmd).toContain('Greet me, then handle:');
  expect(claudeCmd).toContain('Create a task to fix bugs');
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun run test -- server/orchestrator.test.ts`
Expected: FAIL — startOrchestrator ignores second argument

- [ ] **Step 7: Modify `startOrchestrator` to accept optional initial message**

In `server/orchestrator.ts`, update the signature and claude command:

```ts
export async function startOrchestrator(cwd?: string, initialMessage?: string): Promise<void> {
  if (await isOrchestratorRunning()) return;
  await execFile('tmux', [
    'new-session', '-d', '-s', ORCHESTRATOR_SESSION, '-c', cwd || process.cwd(),
  ]);
  // Use single quotes for the user message to prevent shell interpretation of $, `, etc.
  // Single quotes inside the message are escaped as '"'"' (end quote, literal quote, start quote).
  const greeting = initialMessage
    ? `'Greet me, then handle: ${initialMessage.replace(/'/g, "'\"'\"'")}'`
    : '"Greet me and show what you can do"';
  const claudeCmd = `claude --system-prompt "$(cat ${PROMPT_FILE})" ${greeting}`;
  await execFile('tmux', ['send-keys', '-t', ORCHESTRATOR_SESSION, claudeCmd, 'Enter']);
}
```

- [ ] **Step 8: Run all orchestrator tests**

Run: `bun run test -- server/orchestrator.test.ts`
Expected: All PASS

- [ ] **Step 9: Commit**

```bash
git add server/orchestrator.ts server/orchestrator.test.ts
git commit -m "feat(orchestrator): add sendToOrchestrator and initial message support"
```

---

### Task 2: Add `POST /api/orchestrator/send` endpoint

**Files:**
- Modify: `server/api.ts`
- Modify: `server/api.test.ts`

- [ ] **Step 1: Write failing tests for the new endpoint**

First, add a `vi.mock('./orchestrator.js', ...)` block to `server/api.test.ts` alongside the existing `vi.mock('./task-runner.js', ...)`. The api.test.ts currently does NOT mock orchestrator.js — the orchestrator routes work via the underlying `child_process` mock. For the new send endpoint, we need explicit control. Add this mock:

```ts
vi.mock('./orchestrator.js', () => ({
  isOrchestratorRunning: vi.fn(async () => true),
  startOrchestrator: vi.fn(),
  stopOrchestrator: vi.fn(),
  getOrchestratorSession: vi.fn(() => 'octomux-orchestrator'),
  sendToOrchestrator: vi.fn(),
}));
```

Then import the mocked functions:

```ts
const { isOrchestratorRunning, startOrchestrator, sendToOrchestrator } =
  await import('./orchestrator.js');
```

Now add the test describe block:

```ts
describe('POST /api/orchestrator/send', () => {
  it('sends message when orchestrator is running', async () => {
    vi.mocked(isOrchestratorRunning).mockResolvedValue(true);
    const res = await request(app).post('/api/orchestrator/send')
      .send({ message: 'Show me all tasks' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, running: true });
    expect(sendToOrchestrator).toHaveBeenCalledWith('Show me all tasks');
  });

  it('auto-starts orchestrator when not running', async () => {
    vi.mocked(isOrchestratorRunning).mockResolvedValue(false);
    const res = await request(app).post('/api/orchestrator/send')
      .send({ message: 'Create a task' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, running: true });
    expect(startOrchestrator).toHaveBeenCalledWith(undefined, 'Create a task');
  });

  it('returns 400 when message is missing', async () => {
    const res = await request(app).post('/api/orchestrator/send').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('message is required');
  });

  it('returns 500 when orchestrator fails to start', async () => {
    vi.mocked(isOrchestratorRunning).mockResolvedValue(false);
    vi.mocked(startOrchestrator).mockRejectedValueOnce(new Error('tmux failed'));
    const res = await request(app).post('/api/orchestrator/send')
      .send({ message: 'hello' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'tmux failed' });
  });
});
```

**Note:** Adding the orchestrator mock may affect the existing orchestrator GET/POST status tests. Verify those still pass after adding the mock — the existing tests use `child_process` to simulate `tmux has-session`, but now the orchestrator functions will be mocked directly. You may need to adjust the existing orchestrator status/start/stop tests to use `vi.mocked(isOrchestratorRunning)` etc. instead of relying on `child_process`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- server/api.test.ts`
Expected: FAIL — route does not exist

- [ ] **Step 3: Implement the endpoint in `api.ts`**

Add to `server/api.ts` in the orchestrator routes section, and import `sendToOrchestrator`:

```ts
// Update import
import {
  isOrchestratorRunning,
  startOrchestrator,
  stopOrchestrator,
  getOrchestratorSession,
  sendToOrchestrator,
} from './orchestrator.js';

// Add route after the existing orchestrator routes
app.post('/api/orchestrator/send', async (req: Request, res: Response) => {
  const { message } = req.body as { message?: string };
  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  try {
    const running = await isOrchestratorRunning();
    if (!running) {
      await startOrchestrator(undefined, message);
    } else {
      await sendToOrchestrator(message);
    }
    res.json({ ok: true, running: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- server/api.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add server/api.ts server/api.test.ts
git commit -m "feat(api): add POST /api/orchestrator/send endpoint"
```

---

## Batch 2: Frontend — API Client & Shared Commands

### Task 3: Add `orchestratorSend` to API client

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src/lib/api.test.tsx`
- Modify: `src/test-helpers.tsx`

- [ ] **Step 1: Write failing test**

Add to `src/lib/api.test.tsx`:

```ts
it('orchestratorSend posts message', async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, running: true })));
  const result = await api.orchestratorSend('hello');
  expect(result).toEqual({ ok: true, running: true });
  expect(fetchMock).toHaveBeenCalledWith('/api/orchestrator/send', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ message: 'hello' }),
  }));
});
```

Note: Match the existing test patterns in `src/lib/api.test.tsx` for how fetch is mocked.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- src/lib/api.test.tsx`
Expected: FAIL — `orchestratorSend` does not exist

- [ ] **Step 3: Add `orchestratorSend` to `api.ts`**

Add to the `api` object in `src/lib/api.ts`:

```ts
orchestratorSend: (message: string) =>
  request<{ ok: boolean; running: boolean }>('/orchestrator/send', {
    method: 'POST',
    body: JSON.stringify({ message }),
  }),
```

- [ ] **Step 4: Add to `mockApi` in `src/test-helpers.tsx`**

Add orchestrator methods to the defaults object (these were previously missing from `mockApi`):

```ts
orchestratorStatus: vi.fn().mockResolvedValue({ running: false, session: 'octomux-orchestrator' }),
orchestratorStart: vi.fn().mockResolvedValue({ running: true, session: 'octomux-orchestrator' }),
orchestratorStop: vi.fn().mockResolvedValue({ running: false }),
orchestratorSend: vi.fn().mockResolvedValue({ ok: true, running: true }),
```

- [ ] **Step 5: Run tests**

Run: `bun run test -- src/lib/api.test.tsx`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/lib/api.test.tsx src/test-helpers.tsx
git commit -m "feat(api): add orchestratorSend client method"
```

---

### Task 4: Create shared `COMMANDS` data source

**Files:**
- Create: `src/lib/orchestrator-commands.ts`

- [ ] **Step 1: Create the commands file**

Create `src/lib/orchestrator-commands.ts`:

```ts
export interface OrchestratorCommand {
  slash: string;
  chipLabel: string;
  description: string;
  template: string;
  hasPlaceholders: boolean;
}

export const COMMANDS: OrchestratorCommand[] = [
  {
    slash: '/create-task',
    chipLabel: '+ Create Task',
    description: 'Create a task for an autonomous agent',
    template:
      'Create a task titled "[title]" in repo [/path/to/repo] with prompt: [describe what the agent should do]',
    hasPlaceholders: true,
  },
  {
    slash: '/list-tasks',
    chipLabel: 'List Tasks',
    description: 'Show all running tasks',
    template: 'Show me all running tasks',
    hasPlaceholders: false,
  },
  {
    slash: '/status',
    chipLabel: 'Task Status',
    description: 'Check status of a specific task',
    template: 'What is the status of task [id]?',
    hasPlaceholders: true,
  },
  {
    slash: '/create-pr',
    chipLabel: 'Create PR',
    description: 'Create a PR for a completed task',
    template: 'Create a PR for task [id]',
    hasPlaceholders: true,
  },
];

/** Filter commands by slash prefix (e.g., "cr" matches "/create-task" and "/create-pr") */
export function filterCommands(query: string): OrchestratorCommand[] {
  const q = query.toLowerCase();
  return COMMANDS.filter((cmd) => cmd.slash.slice(1).startsWith(q));
}

/** Find the first [placeholder] in a template and return its start/end indices */
export function findFirstPlaceholder(template: string): { start: number; end: number } | null {
  const match = template.match(/\[([^\]]+)\]/);
  if (!match || match.index === undefined) return null;
  return { start: match.index, end: match.index + match[0].length };
}
```

- [ ] **Step 2: Write tests for `filterCommands` and `findFirstPlaceholder`**

These are pure functions that deserve basic coverage. Add `src/lib/orchestrator-commands.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { filterCommands, findFirstPlaceholder, COMMANDS } from './orchestrator-commands';

describe('filterCommands', () => {
  it('returns all commands for empty query', () => {
    expect(filterCommands('')).toEqual(COMMANDS);
  });

  it('filters by prefix', () => {
    const result = filterCommands('cr');
    expect(result.map((c) => c.slash)).toEqual(['/create-task', '/create-pr']);
  });

  it('returns empty for no match', () => {
    expect(filterCommands('xyz')).toEqual([]);
  });
});

describe('findFirstPlaceholder', () => {
  it('finds first bracketed placeholder', () => {
    const result = findFirstPlaceholder('Create task "[title]" in [repo]');
    expect(result).toEqual({ start: 13, end: 20 });
  });

  it('returns null when no placeholder', () => {
    expect(findFirstPlaceholder('Show me all running tasks')).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun run test -- src/lib/orchestrator-commands.test.ts`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/lib/orchestrator-commands.ts src/lib/orchestrator-commands.test.ts
git commit -m "feat: add shared orchestrator commands data source"
```

---

## Batch 3: Frontend — Command Bar Component

### Task 5: Build `OrchestratorCommandBar` — input + send

**Files:**
- Create: `src/components/OrchestratorCommandBar.tsx`
- Create: `src/components/OrchestratorCommandBar.test.tsx`

- [ ] **Step 1: Write failing tests for basic input + send**

Create `src/components/OrchestratorCommandBar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrchestratorCommandBar } from './OrchestratorCommandBar';
import { renderWithRouter } from '../test-helpers';

const mockOpen = vi.fn();
const mockRefresh = vi.fn();
let mockRunning = true;
const mockSend = vi.fn().mockResolvedValue({ ok: true, running: true });

vi.mock('@/lib/orchestrator-context', () => ({
  useOrchestratorContext: () => ({
    isOpen: false,
    running: mockRunning,
    loading: false,
    open: mockOpen,
    close: vi.fn(),
    toggle: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    error: null,
    refresh: mockRefresh,
  }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    orchestratorSend: (...args: any[]) => mockSend(...args),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockRunning = true;
});

describe('OrchestratorCommandBar', () => {
  it('renders input with placeholder', () => {
    renderWithRouter(<OrchestratorCommandBar />);
    expect(screen.getByPlaceholderText(/ask the orchestrator/i)).toBeInTheDocument();
  });

  it('renders send button disabled when input is empty', () => {
    renderWithRouter(<OrchestratorCommandBar />);
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('enables send button when input has text', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, 'hello');
    expect(screen.getByRole('button', { name: /send/i })).toBeEnabled();
  });

  it('sends message and opens modal on submit', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, 'Show me tasks');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(mockSend).toHaveBeenCalledWith('Show me tasks');
    await waitFor(() => {
      expect(mockOpen).toHaveBeenCalled();
    });
  });

  it('clears input after successful send', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, 'Show me tasks');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => {
      expect(input).toHaveValue('');
    });
  });

  it('sends on Enter key', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, 'hello{Enter}');

    expect(mockSend).toHaveBeenCalledWith('hello');
  });

  it('clears input on Escape', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, 'hello');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- src/components/OrchestratorCommandBar.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the base command bar component**

Create `src/components/OrchestratorCommandBar.tsx`:

```tsx
import { useState, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { useOrchestratorContext } from '@/lib/orchestrator-context';
import { api } from '@/lib/api';
import { COMMANDS, findFirstPlaceholder } from '@/lib/orchestrator-commands';

export function OrchestratorCommandBar() {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { open, refresh } = useOrchestratorContext();

  const handleSend = useCallback(async () => {
    const message = input.trim();
    if (!message || sending) return;

    setSending(true);
    try {
      await api.orchestratorSend(message);
      setInput('');
      refresh();
      open();
    } catch (err) {
      console.error('Failed to send to orchestrator:', err);
    } finally {
      setSending(false);
    }
  }, [input, sending, open, refresh]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      setInput('');
    }
  };

  const handleChipClick = (command: typeof COMMANDS[number]) => {
    if (!command.hasPlaceholders) {
      setInput(command.template);
      // Send immediately for commands with no placeholders
      setSending(true);
      api.orchestratorSend(command.template)
        .then(() => {
          setInput('');
          refresh();
          open();
        })
        .catch((err) => console.error('Failed to send:', err))
        .finally(() => setSending(false));
      return;
    }

    setInput(command.template);
    // Focus and select the first placeholder
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      const placeholder = findFirstPlaceholder(command.template);
      if (placeholder) {
        ta.setSelectionRange(placeholder.start, placeholder.end);
      }
    });
  };

  // Auto-resize textarea
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 80)}px`;
  };

  return (
    <div className="mb-4 rounded-xl border border-border bg-card">
      <div className="flex items-end gap-2 p-3">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Ask the orchestrator anything..."
          rows={1}
          className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <Button
          size="sm"
          disabled={!input.trim() || sending}
          onClick={handleSend}
          aria-label="Send"
          className="shrink-0"
        >
          {sending ? (
            <LoadingIcon className="h-4 w-4 animate-spin" />
          ) : (
            <SendIcon className="h-4 w-4" />
          )}
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-border px-3 py-2">
        {COMMANDS.map((cmd) => (
          <button
            key={cmd.slash}
            onClick={() => handleChipClick(cmd)}
            className="rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {cmd.chipLabel}
          </button>
        ))}
      </div>
    </div>
  );
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={className}>
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </svg>
  );
}

function LoadingIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={className}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `bun run test -- src/components/OrchestratorCommandBar.test.tsx`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/OrchestratorCommandBar.tsx src/components/OrchestratorCommandBar.test.tsx
git commit -m "feat(ui): add OrchestratorCommandBar with input, send, and chips"
```

---

### Task 6: Add slash command autocomplete to `OrchestratorCommandBar`

**Files:**
- Modify: `src/components/OrchestratorCommandBar.tsx`
- Modify: `src/components/OrchestratorCommandBar.test.tsx`

- [ ] **Step 1: Write failing tests for slash menu**

Add to `src/components/OrchestratorCommandBar.test.tsx`:

```tsx
describe('slash command autocomplete', () => {
  it('shows dropdown when input starts with /', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, '/');
    expect(screen.getByText('/create-task')).toBeInTheDocument();
    expect(screen.getByText('/list-tasks')).toBeInTheDocument();
    expect(screen.getByText('/status')).toBeInTheDocument();
    expect(screen.getByText('/create-pr')).toBeInTheDocument();
  });

  it('filters commands as user types', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, '/cr');
    expect(screen.getByText('/create-task')).toBeInTheDocument();
    expect(screen.getByText('/create-pr')).toBeInTheDocument();
    expect(screen.queryByText('/list-tasks')).not.toBeInTheDocument();
    expect(screen.queryByText('/status')).not.toBeInTheDocument();
  });

  it('hides dropdown when no commands match', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, '/xyz');
    expect(screen.queryByText('/create-task')).not.toBeInTheDocument();
  });

  it('selects command on click and fills template', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, '/cr');
    await userEvent.click(screen.getByText('/create-task'));
    expect(input).toHaveValue(expect.stringContaining('Create a task titled'));
  });

  it('navigates with arrow keys and selects with Enter', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, '/');
    // Arrow down to second item
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Second command is /list-tasks which has no placeholders — should send immediately
    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith('Show me all running tasks');
    });
  });

  it('closes dropdown on Escape without clearing input', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, '/cr');
    expect(screen.getByText('/create-task')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByText('/create-task')).not.toBeInTheDocument();
    expect(input).toHaveValue('/cr');
  });

  it('does not show dropdown for / in middle of text', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    const input = screen.getByPlaceholderText(/ask the orchestrator/i);
    await userEvent.type(input, 'hello /create');
    expect(screen.queryByText('/create-task')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- src/components/OrchestratorCommandBar.test.tsx`
Expected: FAIL — dropdown not rendered

- [ ] **Step 3: Add slash menu to the component**

Update `src/components/OrchestratorCommandBar.tsx` to add:

1. State: `showSlashMenu`, `selectedIndex`
2. Detect when input starts with `/` → show filtered dropdown
3. Arrow key navigation within the dropdown
4. Enter selects highlighted command (when menu is open)
5. Escape closes dropdown (first press), clears input (second press)
6. Click on command fills template

The dropdown renders as an absolutely-positioned div above the chips area, showing each matching command's `slash` name and `description`.

Key implementation details:
- Use `filterCommands(input.slice(1))` to get matching commands
- Show menu when `input.startsWith('/') && filtered.length > 0`
- On ArrowDown/ArrowUp: update `selectedIndex` (wrap around)
- On Enter when menu is open: select command at `selectedIndex`, call `handleChipClick`
- On Escape when menu is open: close menu, keep input text
- On Escape when menu is closed: clear input

- [ ] **Step 4: Run all tests**

Run: `bun run test -- src/components/OrchestratorCommandBar.test.tsx`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/OrchestratorCommandBar.tsx src/components/OrchestratorCommandBar.test.tsx
git commit -m "feat(ui): add slash command autocomplete to command bar"
```

---

## Batch 4: Integration

### Task 7: Integrate command bar into Dashboard

**Files:**
- Modify: `src/pages/Dashboard.tsx`
- Modify: `src/pages/Dashboard.test.tsx`

- [ ] **Step 1: Write failing test**

Add to `src/pages/Dashboard.test.tsx`:

```tsx
it('renders orchestrator command bar', async () => {
  render(<Dashboard />);
  await waitFor(() => {
    expect(screen.getByPlaceholderText(/ask the orchestrator/i)).toBeInTheDocument();
  });
});
```

**Important:** The `OrchestratorCommandBar` uses `useOrchestratorContext()` which requires being inside an `OrchestratorProvider`. Dashboard.test.tsx currently does NOT mock this module. You must add a mock to Dashboard.test.tsx:

```tsx
vi.mock('@/lib/orchestrator-context', () => ({
  useOrchestratorContext: () => ({
    isOpen: false,
    running: false,
    loading: false,
    open: vi.fn(),
    close: vi.fn(),
    toggle: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    error: null,
    refresh: vi.fn(),
  }),
}));
```

Also ensure the api mock includes `orchestratorSend`. The Dashboard test likely uses a `Proxy`-based mock for `@/lib/api` — check the existing pattern and add `orchestratorSend` to it if needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- src/pages/Dashboard.test.tsx`
Expected: FAIL — command bar not found

- [ ] **Step 3: Add command bar to Dashboard**

In `src/pages/Dashboard.tsx`:

```tsx
import { OrchestratorCommandBar } from '@/components/OrchestratorCommandBar';

// In the return, add before TaskFilterBar:
<OrchestratorCommandBar />
```

- [ ] **Step 4: Run all tests**

Run: `bun run test`
Expected: All PASS

- [ ] **Step 5: Manual smoke test**

Run: `bun run dev`
Verify:
1. Command bar appears at top of dashboard
2. Quick action chips are visible
3. Clicking "List Tasks" sends immediately and opens modal
4. Clicking "+ Create Task" fills template with placeholder selected
5. Typing `/cr` shows filtered dropdown
6. Arrow keys navigate dropdown, Enter selects
7. Escape closes dropdown, second Escape clears input
8. Sending a message when orchestrator is not running auto-starts it

- [ ] **Step 6: Commit**

```bash
git add src/pages/Dashboard.tsx src/pages/Dashboard.test.tsx
git commit -m "feat(dashboard): integrate orchestrator command bar"
```

---

## Batch 5: Polish

### Task 8: Run full test suite and lint

- [ ] **Step 1: Run all tests**

Run: `bun run test`
Expected: All PASS

- [ ] **Step 2: Run linter**

Run: `bun run lint:fix`
Expected: No errors

- [ ] **Step 3: Run formatter**

Run: `bun run format`
Expected: Clean

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 5: Fix any issues found and commit**

```bash
git add -A
git commit -m "style: fix lint and formatting issues"
```
