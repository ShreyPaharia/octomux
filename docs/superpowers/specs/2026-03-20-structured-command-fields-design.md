# Structured Command Fields

**Date:** 2026-03-20
**Status:** Draft
**Depends on:** Orchestrator Command Bar (2026-03-19)

## Problem

The command bar's quick action chips pre-fill text templates with `[placeholder]` brackets that users must manually edit. For "Create Task", this means typing a repo path, title, description, and prompt into a single text line — error-prone and friction-heavy. Users need structured form fields with smart inputs (repo picker with browse/validation, branch dropdown, task picker showing titles).

## Solution

Commands declare typed `fields`. When a user selects a command with fields, the command bar expands to show a form with the right input component per field type. On submit, field values are assembled into a natural language message via a `template` function and sent to the orchestrator.

## Design

### Updated Command Definition

```ts
interface CommandField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'repo-picker' | 'branch-picker' | 'task-picker';
  required?: boolean;
  placeholder?: string;
  dependsOn?: string; // field name that must have a value before this field is enabled
}

interface OrchestratorCommand {
  slash: string;
  chipLabel: string;
  description: string;
  fields?: CommandField[];
  // Always a function. For simple commands (no fields), a thunk returning the fixed message.
  // For field-based commands, receives form values.
  buildMessage: (values: Record<string, string>) => string;
}
```

The previous `template: string` and `hasPlaceholders: boolean` are replaced by a single `buildMessage` function. For commands without fields (like "List Tasks"), the function ignores its argument: `buildMessage: () => 'Show me all running tasks'`. This eliminates the union type and the need for type guards.

Commands with `fields` render a structured form. Commands without fields (e.g., "List Tasks") send immediately (unchanged behavior).

### Commands with Fields

**Create Task:**
- Title (text, required)
- Repository (repo-picker, required)
- Base Branch (branch-picker, dependsOn: repo)
- Description (textarea)
- Initial Prompt (textarea)
- Template: `Create a task titled "${title}" in repo ${repo} with base branch ${baseBranch || 'main'}. Description: ${description}. Prompt: ${prompt || description || title}`

**Task Status:**
- Task (task-picker, required)
- Template: `What is the status of task ${task}?`

**Create PR:**
- Task (task-picker, required)
- Template: `Create a PR for task ${task}`

**List Tasks:** No fields, sends immediately (unchanged).

### UI Behavior

#### Expansion

When a user clicks a chip or selects a slash command that has `fields`:
1. The text input and slash menu are replaced by a form header and field list
2. Form header shows the command name and a close `[x]` button
3. Fields render in declaration order with the correct component per type
4. Send button is enabled when all required fields are filled
5. Clicking `[x]` collapses back to the plain text input

#### Layout

```
┌──────────────────────────────────────────────────────────────┐
│  + Create Task                                    [x] [Send] │
├──────────────────────────────────────────────────────────────┤
│  Title *          [ Fix login bug                          ] │
│  Repository *     [ /Users/dev/my-repo          ] [Browse]   │
│  Base Branch      [ main ▼                                 ] │
│  Description      [ Add proper error handling for...       ] │
│  Initial Prompt   [ In src/auth.ts, fix the login          ] │
│                   [ validation to handle empty...          ] │
├──────────────────────────────────────────────────────────────┤
│  [+ Create Task]  [List Tasks]  [Task Status]  [Create PR]  │
└──────────────────────────────────────────────────────────────┘
```

#### Submit Flow

1. User fills fields, clicks Send (or presses Enter in a `text` field — NOT in `textarea` fields where Enter inserts a newline; use Cmd/Ctrl+Enter or the Send button to submit from a textarea)
2. `buildMessage(values)` assembles a natural language message from field values
3. Message is sent to orchestrator via `api.orchestratorSend(message)`
4. Orchestrator modal auto-opens
5. Form collapses back to plain text input

### Field Type Components

| Type | Renders | Source |
|------|---------|--------|
| `text` | `<Input>` from shadcn/ui | Existing |
| `textarea` | `<Textarea>` from shadcn/ui | Existing |
| `repo-picker` | Text input + Browse button + recent repos dropdown + git validation indicator | Extract from `CreateTaskDialog` |
| `branch-picker` | Searchable dropdown of branches, loads from `api.listBranches(repoPath)` | Extract from `CreateTaskDialog` |
| `task-picker` | Searchable dropdown of tasks, shows title (primary) + truncated ID (secondary) | New |

### Extracting Reusable Field Components

The `CreateTaskDialog` contains inline implementations of repo picker (~120 lines) and branch picker (~70 lines). These are extracted into standalone components:

- `src/components/fields/RepoPickerField.tsx` — repo input + browse popover + recent repos + validation state
- `src/components/fields/BranchPickerField.tsx` — searchable branch dropdown
- `src/components/fields/TaskPickerField.tsx` — task title dropdown (new)

After extraction, `CreateTaskDialog` is refactored to use these extracted components, eliminating duplication.

The `FolderBrowser` sub-component (currently inline in `CreateTaskDialog`, ~108 lines) is co-located with `RepoPickerField` since it's only used there.

#### RepoPickerField Props

```ts
type RepoValidation = 'idle' | 'loading' | 'valid' | 'invalid';

interface RepoPickerFieldProps {
  value: string;
  onChange: (value: string) => void;
  onValidationChange?: (state: RepoValidation) => void; // callback, not input prop
}
```

Internally manages: browse popover state, browse data, recent repos fetch, git validation (debounced 500ms). Calls `onValidationChange` when validation state changes so parent can use it (e.g., to control branch picker's disabled state).

#### BranchPickerField Props

```ts
interface BranchPickerFieldProps {
  repoPath: string;     // triggers branch list fetch when changed
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;   // true when dependsOn field is empty
}
```

Internally manages: branch list fetch (debounced on repoPath change), search filter, dropdown state.

#### TaskPickerField Props

```ts
interface TaskPickerFieldProps {
  value: string;        // task ID
  onChange: (value: string) => void;
}
```

Internally manages: fetch tasks from `api.listTasks()`, search filter, dropdown state.

**Task picker dropdown:**
```
┌─────────────────────────────────┐
│  Select task...              ▼  │
├─────────────────────────────────┤
│  [ Search tasks...           ]  │
│  ▸ Fix login bug       EQ9n... │
│    Reduce tab delay    X8mK... │
│    Add auth middleware  Pn3r... │
└─────────────────────────────────┘
```

- Fetches tasks from `api.listTasks()` on mount
- Filters to `running` and `closed` statuses by default (excludes `draft`, `setting_up`, `error`). Can be overridden via optional `statusFilter` prop if needed.
- Shows title (primary text) + first 6 chars of ID (muted secondary text)
- Searchable by title
- Selected value = task ID (used in buildMessage)
- Displays selected task's title in the trigger button
- Shows loading spinner while fetching, error message on fetch failure

### New Component: CommandFieldForm

`src/components/CommandFieldForm.tsx`

Renders the field form for a given command:

```ts
interface CommandFieldFormProps {
  command: OrchestratorCommand;
  onSubmit: (message: string) => void;
  onClose: () => void;
  sending: boolean;
}
```

- Manages form values as `Record<string, string>` and repo validation state
- Renders each field using the appropriate component based on `field.type`
- Handles `dependsOn`: disables fields whose dependency is empty, and passes dependency value as context prop. Specifically: if `field.type === 'branch-picker'` and `field.dependsOn` is set, pass `values[field.dependsOn]` as the `repoPath` prop. This convention means `dependsOn` both controls disabled state AND provides contextual data to the dependent field.
- Calls `command.buildMessage(values)` on submit
- Resets dependent field values when their dependency changes (e.g., branch resets when repo changes)

### OrchestratorCommandBar Changes

New state:
- `activeCommand: OrchestratorCommand | null` — the command currently showing its form

Updated behavior:
- When `activeCommand` is set (has fields), render `CommandFieldForm` instead of the textarea
- The chips row stays visible below the form
- Clicking a chip with fields sets `activeCommand`; clicking one without fields sends immediately (unchanged)
- Selecting a slash command with fields sets `activeCommand` and closes slash menu
- `[x]` or Escape sets `activeCommand = null`

### File Changes

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/components/fields/RepoPickerField.tsx` | Repo input + browse + FolderBrowser + recent + validation |
| Create | `src/components/fields/BranchPickerField.tsx` | Searchable branch dropdown |
| Create | `src/components/fields/TaskPickerField.tsx` | Task title dropdown |
| Create | `src/components/CommandFieldForm.tsx` | Dynamic field form renderer |
| Modify | `src/lib/orchestrator-commands.ts` | Replace `template`/`hasPlaceholders` with `fields` + `buildMessage` |
| Modify | `src/components/OrchestratorCommandBar.tsx` | Add `activeCommand` state, render form, update to use `buildMessage` |
| Modify | `src/components/CreateTaskDialog.tsx` | Refactor to use extracted field components |

**Note on CreateTaskDialog refactoring:** The dialog has additional state tightly coupled to the inline fields — specifically `branchIsAuto` (auto-generates branch name from title) and `touched` (inline validation). The extracted `BranchPickerField` should expose an `onBranchesLoaded` callback so `CreateTaskDialog` can set the default branch for auto-generation. The `touched` validation remains in the dialog since it's form-level concern, not field-level.

### Edge Cases

- **Repo picker validation**: Debounced (500ms) git validation, same as CreateTaskDialog
- **Branch picker with no repo**: Disabled state, shows "Select a repository first"
- **Task picker with no tasks**: Shows "No tasks found"
- **dependsOn chain**: Branch picker resets when repo changes (branches reload)
- **Escape key**: When form is open, closes form (does not send). When form is closed, clears text input (existing behavior).
- **Switching commands**: Clicking a different chip with fields while a form is open replaces it with the new command's form (values reset). Clicking a fieldless chip (e.g., "List Tasks") while a form is open sends immediately and collapses the form.

## What We're NOT Building

- Field validation beyond required/dependsOn (orchestrator handles validation)
- Saving form state across command switches
- Custom user-defined commands
- Draft mode or any CreateTaskDialog-specific features (draft checkbox) in the command bar form — the command bar sends to the orchestrator, not the REST API directly
