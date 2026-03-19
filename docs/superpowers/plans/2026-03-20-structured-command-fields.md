# Structured Command Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace text-template command inputs with structured form fields (repo picker, branch dropdown, task picker) that assemble natural language messages for the orchestrator.

**Architecture:** Commands declare typed `fields` and a `buildMessage` function. When selected, the command bar expands to show `CommandFieldForm` which renders field-type-specific components. Reusable field components are extracted from `CreateTaskDialog`. On submit, `buildMessage(values)` assembles the message and sends to the orchestrator.

**Tech Stack:** React 19, Tailwind CSS 4, shadcn/ui (Input, Textarea, Popover, Button, Label)

**Spec:** `docs/superpowers/specs/2026-03-20-structured-command-fields-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/components/fields/RepoPickerField.tsx` | Repo input + FolderBrowser + browse popover + recent repos + validation |
| Create | `src/components/fields/BranchPickerField.tsx` | Searchable branch dropdown with repo-dependent fetch |
| Create | `src/components/fields/TaskPickerField.tsx` | Task dropdown (title + truncated ID) |
| Create | `src/components/CommandFieldForm.tsx` | Dynamic form renderer for command fields |
| Modify | `src/lib/orchestrator-commands.ts` | Replace `template`/`hasPlaceholders` with `fields` + `buildMessage` |
| Modify | `src/components/OrchestratorCommandBar.tsx` | Add `activeCommand` state, render form vs textarea |
| Modify | `src/components/CreateTaskDialog.tsx` | Refactor to use extracted field components |
| Test | Various `.test.tsx` files | Tests for each new/modified component |

---

## Batch 1: Extract Reusable Field Components

### Task 1: Extract `RepoPickerField` from `CreateTaskDialog`

**Files:**
- Create: `src/components/fields/RepoPickerField.tsx`
- Create: `src/components/fields/RepoPickerField.test.tsx`

This is the largest extraction. Move the repo input + validation indicator + browse popover + FolderBrowser + recent repos from `CreateTaskDialog` (lines 256-378 for JSX, lines 49-162 for state/effects) into a standalone component.

- [ ] **Step 1: Create `RepoPickerField` component**

Create `src/components/fields/RepoPickerField.tsx` containing:

Props:
```ts
export type RepoValidation = 'idle' | 'loading' | 'valid' | 'invalid';

interface RepoPickerFieldProps {
  value: string;
  onChange: (value: string) => void;
  onValidationChange?: (state: RepoValidation) => void;
}
```

The component internally manages:
- `recentRepos` state + fetch on mount via `api.recentRepos()`
- `browseOpen` / `browseData` / `browseLoading` state for the folder browser popover
- `validation` state (`idle` | `loading` | `valid` | `invalid`) — debounced 500ms validation via `api.listBranches(value)`. Calls `onValidationChange` when state changes.
- `browseTo` callback for folder navigation via `api.browse(path)`

Render structure (copy from `CreateTaskDialog` lines 256-378):
- Text input with monospace font + validation indicator (spinner/check/x)
- Browse button → Popover with `FolderBrowser`
- Validation message below input
- Recent repos list (when input is empty)

Move `FolderBrowser` into this same file (it's only used here). Copy from `CreateTaskDialog` lines 526-634.

Move `timeAgo` helper into this file as well (from line 21-31).

- [ ] **Step 2: Write basic test**

Create `src/components/fields/RepoPickerField.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RepoPickerField } from './RepoPickerField';
import { renderWithRouter } from '../../test-helpers';

vi.mock('@/lib/api', () => ({
  api: {
    recentRepos: vi.fn().mockResolvedValue([]),
    browse: vi.fn().mockResolvedValue({ current: '/tmp', parent: '/', entries: [] }),
    listBranches: vi.fn().mockResolvedValue(['main']),
    getDefaultBranch: vi.fn().mockResolvedValue({ branch: 'main' }),
  },
}));

describe('RepoPickerField', () => {
  it('renders input with placeholder', () => {
    renderWithRouter(<RepoPickerField value="" onChange={vi.fn()} />);
    expect(screen.getByPlaceholderText(/projects\/my-repo/i)).toBeInTheDocument();
  });

  it('renders Browse button', () => {
    renderWithRouter(<RepoPickerField value="" onChange={vi.fn()} />);
    expect(screen.getByText('Browse')).toBeInTheDocument();
  });

  it('calls onChange when typing', async () => {
    const onChange = vi.fn();
    renderWithRouter(<RepoPickerField value="" onChange={onChange} />);
    const input = screen.getByPlaceholderText(/projects\/my-repo/i);
    await userEvent.type(input, '/tmp/repo');
    expect(onChange).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun run test -- src/components/fields/RepoPickerField.test.tsx`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/fields/RepoPickerField.tsx src/components/fields/RepoPickerField.test.tsx
git commit -m "feat: extract RepoPickerField from CreateTaskDialog"
```

---

### Task 2: Extract `BranchPickerField` from `CreateTaskDialog`

**Files:**
- Create: `src/components/fields/BranchPickerField.tsx`
- Create: `src/components/fields/BranchPickerField.test.tsx`

Extract the branch picker from `CreateTaskDialog` (lines 404-476 for JSX, branch-related state/effects).

- [ ] **Step 1: Create `BranchPickerField` component**

Create `src/components/fields/BranchPickerField.tsx`:

Props:
```ts
interface BranchPickerFieldProps {
  repoPath: string;
  value: string;
  onChange: (value: string) => void;
  onBranchesLoaded?: (branches: string[], defaultBranch: string) => void;
  disabled?: boolean;
}
```

Internally manages:
- `branches` state — fetches via `api.listBranches(repoPath)` + `api.getDefaultBranch(repoPath)` when `repoPath` changes (debounced 500ms). Calls `onBranchesLoaded` with the results.
- `branchSearch` for filtering
- `dropdownOpen` for popover state

Render: Searchable dropdown using `Popover` (copy from `CreateTaskDialog` lines 406-475). Show "Select a repository first" when `disabled` or no branches. Auto-set value to default branch on first load.

- [ ] **Step 2: Write basic test**

Create `src/components/fields/BranchPickerField.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { BranchPickerField } from './BranchPickerField';
import { renderWithRouter } from '../../test-helpers';

vi.mock('@/lib/api', () => ({
  api: {
    listBranches: vi.fn().mockResolvedValue(['main', 'develop']),
    getDefaultBranch: vi.fn().mockResolvedValue({ branch: 'main' }),
  },
}));

describe('BranchPickerField', () => {
  it('shows disabled state when no repo', () => {
    renderWithRouter(
      <BranchPickerField repoPath="" value="" onChange={vi.fn()} disabled />
    );
    expect(screen.getByText(/select base branch/i)).toBeInTheDocument();
  });

  it('renders with a selected branch', () => {
    renderWithRouter(
      <BranchPickerField repoPath="/tmp/repo" value="main" onChange={vi.fn()} />
    );
    expect(screen.getByText('main')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun run test -- src/components/fields/BranchPickerField.test.tsx`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/fields/BranchPickerField.tsx src/components/fields/BranchPickerField.test.tsx
git commit -m "feat: extract BranchPickerField from CreateTaskDialog"
```

---

### Task 3: Create `TaskPickerField`

**Files:**
- Create: `src/components/fields/TaskPickerField.tsx`
- Create: `src/components/fields/TaskPickerField.test.tsx`

New component — searchable dropdown of tasks showing title + truncated ID.

- [ ] **Step 1: Create `TaskPickerField` component**

Create `src/components/fields/TaskPickerField.tsx`:

Props:
```ts
interface TaskPickerFieldProps {
  value: string; // task ID
  onChange: (value: string) => void;
}
```

Internally manages:
- `tasks` state — fetches via `api.listTasks()` on mount, filters to `running` and `closed` statuses
- `search` for filtering by title
- `dropdownOpen` for popover state
- `loading` state while fetching

Render: Popover dropdown similar to BranchPickerField pattern:
- Trigger button shows selected task title (or "Select task..." placeholder)
- Search input at top of dropdown
- Each item shows: title (primary, font-semibold) + first 6 chars of ID (muted, text-xs)
- "No tasks found" empty state
- Loading spinner while fetching

- [ ] **Step 2: Write tests**

Create `src/components/fields/TaskPickerField.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskPickerField } from './TaskPickerField';
import { renderWithRouter } from '../../test-helpers';

const mockTasks = [
  { id: 'abc123456789', title: 'Fix login bug', status: 'running', agents: [] },
  { id: 'def987654321', title: 'Add auth middleware', status: 'closed', agents: [] },
  { id: 'ghi111222333', title: 'Draft task', status: 'draft', agents: [] },
];

vi.mock('@/lib/api', () => ({
  api: {
    listTasks: vi.fn().mockResolvedValue(mockTasks),
  },
}));

describe('TaskPickerField', () => {
  it('shows placeholder when no task selected', async () => {
    renderWithRouter(<TaskPickerField value="" onChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/select task/i)).toBeInTheDocument();
    });
  });

  it('shows selected task title', async () => {
    renderWithRouter(<TaskPickerField value="abc123456789" onChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeInTheDocument();
    });
  });

  it('filters out draft tasks', async () => {
    renderWithRouter(<TaskPickerField value="" onChange={vi.fn()} />);
    const trigger = await screen.findByText(/select task/i);
    await userEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeInTheDocument();
      expect(screen.getByText('Add auth middleware')).toBeInTheDocument();
      expect(screen.queryByText('Draft task')).not.toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun run test -- src/components/fields/TaskPickerField.test.tsx`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/fields/TaskPickerField.tsx src/components/fields/TaskPickerField.test.tsx
git commit -m "feat: add TaskPickerField component"
```

---

## Batch 2: Command Definitions + Form Renderer

### Task 4: Update `orchestrator-commands.ts` with `fields` and `buildMessage`

**Files:**
- Modify: `src/lib/orchestrator-commands.ts`
- Modify: `src/lib/orchestrator-commands.test.tsx`

- [ ] **Step 1: Update types and command definitions**

Replace the `OrchestratorCommand` interface and `COMMANDS` array in `src/lib/orchestrator-commands.ts`:

```ts
export interface CommandField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'repo-picker' | 'branch-picker' | 'task-picker';
  required?: boolean;
  placeholder?: string;
  dependsOn?: string;
}

export interface OrchestratorCommand {
  slash: string;
  chipLabel: string;
  description: string;
  fields?: CommandField[];
  buildMessage: (values: Record<string, string>) => string;
}

export const COMMANDS: OrchestratorCommand[] = [
  {
    slash: '/create-task',
    chipLabel: '+ Create Task',
    description: 'Create a task for an autonomous agent',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true, placeholder: 'Fix login bug' },
      { name: 'repo', label: 'Repository', type: 'repo-picker', required: true },
      { name: 'baseBranch', label: 'Base Branch', type: 'branch-picker', dependsOn: 'repo' },
      { name: 'description', label: 'Description', type: 'textarea', placeholder: 'Describe what needs to be done...' },
      { name: 'prompt', label: 'Initial Prompt', type: 'textarea', placeholder: 'Tell the agent what to do...' },
    ],
    buildMessage: (v) =>
      `Create a task titled "${v.title}" in repo ${v.repo}${v.baseBranch ? ` with base branch ${v.baseBranch}` : ''}${v.description ? `. Description: ${v.description}` : ''} with prompt: ${v.prompt || v.description || v.title}`,
  },
  {
    slash: '/list-tasks',
    chipLabel: 'List Tasks',
    description: 'Show all running tasks',
    buildMessage: () => 'Show me all running tasks',
  },
  {
    slash: '/status',
    chipLabel: 'Task Status',
    description: 'Check status of a specific task',
    fields: [
      { name: 'task', label: 'Task', type: 'task-picker', required: true },
    ],
    buildMessage: (v) => `What is the status of task ${v.task}?`,
  },
  {
    slash: '/create-pr',
    chipLabel: 'Create PR',
    description: 'Create a PR for a completed task',
    fields: [
      { name: 'task', label: 'Task', type: 'task-picker', required: true },
    ],
    buildMessage: (v) => `Create a PR for task ${v.task}`,
  },
];
```

Remove `findFirstPlaceholder` function (no longer needed — was used for text template placeholders).

Keep `filterCommands` unchanged.

- [ ] **Step 2: Update tests**

Update `src/lib/orchestrator-commands.test.tsx`:
- Remove `findFirstPlaceholder` tests
- Add tests for `buildMessage`:

```ts
describe('buildMessage', () => {
  it('list-tasks builds message without values', () => {
    const cmd = COMMANDS.find((c) => c.slash === '/list-tasks')!;
    expect(cmd.buildMessage({})).toBe('Show me all running tasks');
  });

  it('create-task builds message from field values', () => {
    const cmd = COMMANDS.find((c) => c.slash === '/create-task')!;
    const msg = cmd.buildMessage({
      title: 'Fix bug',
      repo: '/tmp/repo',
      baseBranch: 'main',
      description: 'Fix the login',
      prompt: 'In auth.ts fix validation',
    });
    expect(msg).toContain('Fix bug');
    expect(msg).toContain('/tmp/repo');
    expect(msg).toContain('main');
    expect(msg).toContain('In auth.ts fix validation');
  });

  it('create-task handles missing optional fields', () => {
    const cmd = COMMANDS.find((c) => c.slash === '/create-task')!;
    const msg = cmd.buildMessage({ title: 'Fix bug', repo: '/tmp/repo' });
    expect(msg).toContain('Fix bug');
    expect(msg).toContain('/tmp/repo');
    expect(msg).not.toContain('undefined');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun run test -- src/lib/orchestrator-commands.test.tsx`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/lib/orchestrator-commands.ts src/lib/orchestrator-commands.test.tsx
git commit -m "feat: replace template strings with fields and buildMessage"
```

---

### Task 5: Create `CommandFieldForm` component

**Files:**
- Create: `src/components/CommandFieldForm.tsx`
- Create: `src/components/CommandFieldForm.test.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/CommandFieldForm.tsx`:

Props:
```ts
interface CommandFieldFormProps {
  command: OrchestratorCommand;
  onSubmit: (message: string) => void;
  onClose: () => void;
  sending: boolean;
}
```

Implementation:
- State: `values: Record<string, string>` initialized to `{}`, `repoValidation: RepoValidation`
- Renders a header row: command `chipLabel` + close `[x]` button + Send button (disabled when required fields are empty)
- Renders each `command.fields` entry using a switch on `field.type`:
  - `text` → `<Input>` with `<Label>`
  - `textarea` → `<Textarea>` with `<Label>`
  - `repo-picker` → `<RepoPickerField>` with `onValidationChange` callback
  - `branch-picker` → `<BranchPickerField>` with `repoPath={values[field.dependsOn]}`, `disabled` when dependency empty
  - `task-picker` → `<TaskPickerField>`
- When a `dependsOn` field changes, reset the dependent field's value (e.g., branch resets when repo changes)
- On submit: calls `command.buildMessage(values)`, then `onSubmit(message)`
- Enter in `text` fields triggers submit. Enter in `textarea` fields inserts newline. Cmd/Ctrl+Enter submits from anywhere.
- Escape calls `onClose()`

- [ ] **Step 2: Write tests**

Create `src/components/CommandFieldForm.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommandFieldForm } from './CommandFieldForm';
import { COMMANDS } from '@/lib/orchestrator-commands';
import { renderWithRouter } from '../test-helpers';

vi.mock('@/lib/api', () => ({
  api: {
    recentRepos: vi.fn().mockResolvedValue([]),
    browse: vi.fn().mockResolvedValue({ current: '/tmp', parent: '/', entries: [] }),
    listBranches: vi.fn().mockResolvedValue(['main', 'develop']),
    getDefaultBranch: vi.fn().mockResolvedValue({ branch: 'main' }),
    listTasks: vi.fn().mockResolvedValue([
      { id: 'abc123', title: 'Test task', status: 'running', agents: [] },
    ]),
  },
}));

describe('CommandFieldForm', () => {
  const statusCmd = COMMANDS.find((c) => c.slash === '/status')!;
  const createCmd = COMMANDS.find((c) => c.slash === '/create-task')!;

  it('renders command name and close button', () => {
    renderWithRouter(
      <CommandFieldForm command={statusCmd} onSubmit={vi.fn()} onClose={vi.fn()} sending={false} />
    );
    expect(screen.getByText('Task Status')).toBeInTheDocument();
  });

  it('renders fields for the command', () => {
    renderWithRouter(
      <CommandFieldForm command={createCmd} onSubmit={vi.fn()} onClose={vi.fn()} sending={false} />
    );
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Repository')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
  });

  it('disables send when required fields are empty', () => {
    renderWithRouter(
      <CommandFieldForm command={createCmd} onSubmit={vi.fn()} onClose={vi.fn()} sending={false} />
    );
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('calls onClose when close button clicked', async () => {
    const onClose = vi.fn();
    renderWithRouter(
      <CommandFieldForm command={statusCmd} onSubmit={vi.fn()} onClose={onClose} sending={false} />
    );
    await userEvent.click(screen.getByLabelText(/close/i));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun run test -- src/components/CommandFieldForm.test.tsx`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/CommandFieldForm.tsx src/components/CommandFieldForm.test.tsx
git commit -m "feat: add CommandFieldForm dynamic field renderer"
```

---

## Batch 3: Wire Up Command Bar

### Task 6: Update `OrchestratorCommandBar` to show form for field-based commands

**Files:**
- Modify: `src/components/OrchestratorCommandBar.tsx`
- Modify: `src/components/OrchestratorCommandBar.test.tsx`

- [ ] **Step 1: Add `activeCommand` state and update `handleChipClick`**

In `OrchestratorCommandBar.tsx`:

New state:
```ts
const [activeCommand, setActiveCommand] = useState<OrchestratorCommand | null>(null);
```

Update `handleChipClick`:
```ts
const handleChipClick = (command: OrchestratorCommand) => {
  if (command.fields) {
    setActiveCommand(command);
    setShowSlashMenu(false);
    return;
  }
  // No fields — send immediately
  sendMessage(command.buildMessage({}));
};
```

Update render: when `activeCommand` is set, render `CommandFieldForm` instead of the textarea area:

```tsx
{activeCommand ? (
  <CommandFieldForm
    command={activeCommand}
    onSubmit={(message) => {
      sendMessage(message);
      setActiveCommand(null);
    }}
    onClose={() => setActiveCommand(null)}
    sending={sending}
  />
) : (
  // existing textarea + slash menu
)}
```

Remove `findFirstPlaceholder` import (no longer used).

Update slash menu selection to also check for fields:
- In `handleKeyDown` where it calls `handleChipClick(filteredCommands[selectedIndex])` — this already calls `handleChipClick` which now handles fields.

Update Escape handling: when `activeCommand` is set, Escape closes the form.

- [ ] **Step 2: Update tests**

Update `src/components/OrchestratorCommandBar.test.tsx`:

Add mock for `@/lib/api` to include all methods needed by field components:
```tsx
vi.mock('@/lib/api', () => ({
  api: {
    orchestratorSend: (...args: any[]) => mockSend(...args),
    recentRepos: vi.fn().mockResolvedValue([]),
    browse: vi.fn().mockResolvedValue({ current: '/tmp', parent: '/', entries: [] }),
    listBranches: vi.fn().mockResolvedValue(['main']),
    getDefaultBranch: vi.fn().mockResolvedValue({ branch: 'main' }),
    listTasks: vi.fn().mockResolvedValue([]),
  },
}));
```

Add tests:
```tsx
describe('field-based commands', () => {
  it('shows form when clicking a chip with fields', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    await userEvent.click(screen.getByText('+ Create Task'));
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Repository')).toBeInTheDocument();
  });

  it('sends immediately for commands without fields', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    await userEvent.click(screen.getByText('List Tasks'));
    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith('Show me all running tasks');
    });
  });

  it('closes form and returns to input on [x]', async () => {
    renderWithRouter(<OrchestratorCommandBar />);
    await userEvent.click(screen.getByText('+ Create Task'));
    expect(screen.getByText('Title')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/close/i));
    expect(screen.getByPlaceholderText(/ask the orchestrator/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run all tests**

Run: `bun run test`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/OrchestratorCommandBar.tsx src/components/OrchestratorCommandBar.test.tsx
git commit -m "feat: wire command bar to show field forms for structured commands"
```

---

## Batch 4: Refactor CreateTaskDialog

### Task 7: Refactor `CreateTaskDialog` to use extracted field components

**Files:**
- Modify: `src/components/CreateTaskDialog.tsx`
- Modify: `src/components/CreateTaskDialog.test.tsx`

- [ ] **Step 1: Replace inline repo picker with `RepoPickerField`**

In `CreateTaskDialog.tsx`:
- Remove: inline repo input JSX (lines ~256-378), browse state/effects (lines ~49-162), `FolderBrowser` component, `timeAgo` helper
- Add: `import { RepoPickerField } from './fields/RepoPickerField'`
- Replace with: `<RepoPickerField value={repoPath} onChange={setRepoPath} onValidationChange={setRepoValidation} />`
- Keep `repoValidation` state in the dialog (needed for `canSubmit` and touched validation)

- [ ] **Step 2: Replace inline branch picker with `BranchPickerField`**

- Remove: inline branch picker JSX (lines ~404-476), branches state/fetch effect
- Add: `import { BranchPickerField } from './fields/BranchPickerField'`
- Replace with:
```tsx
<BranchPickerField
  repoPath={repoPath}
  value={baseBranch}
  onChange={setBaseBranch}
  onBranchesLoaded={(branches, defaultBranch) => {
    setBaseBranch(defaultBranch);
    // Keep branches available for any other logic if needed
  }}
  disabled={!repoPath.trim()}
/>
```

- [ ] **Step 3: Run existing CreateTaskDialog tests**

Run: `bun run test -- src/components/CreateTaskDialog.test.tsx`
Expected: All PASS (the tests should continue to pass since behavior is unchanged — only internal structure changed)

- [ ] **Step 4: Run full test suite**

Run: `bun run test`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/CreateTaskDialog.tsx
git commit -m "refactor: use extracted field components in CreateTaskDialog"
```

---

## Batch 5: Polish

### Task 8: Run full test suite, lint, format, typecheck

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

- [ ] **Step 5: Fix any issues and commit**

```bash
git add -A
git commit -m "style: fix lint and formatting issues"
```

### Task 9: Manual smoke test

- [ ] **Step 1: Start dev server**

Run: `bun run dev`

- [ ] **Step 2: Verify on dashboard**

1. Command bar visible at top of dashboard
2. Click "+ Create Task" → form expands with Title, Repository, Base Branch, Description, Initial Prompt fields
3. Type in repo path → validation indicator appears (spinner → check/x)
4. Click Browse → folder picker popover works
5. Base Branch dropdown shows "Select a repository first" until repo is filled
6. Fill repo → branch dropdown populates
7. Fill required fields → Send button enables
8. Click Send → message assembled and sent to orchestrator, modal opens
9. Click [x] → form closes, textarea returns
10. Click "List Tasks" → sends immediately (no form)
11. Click "Task Status" → form shows task picker dropdown
12. Task picker shows task titles + truncated IDs
13. Slash command `/create-task` → opens form
14. Slash command `/list-tasks` → sends immediately
15. Existing CreateTaskDialog still works (New Task button in header)
