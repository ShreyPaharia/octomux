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
  template: string | ((values: Record<string, string>) => string);
  hasPlaceholders?: boolean; // only used when template is a string (backward compat)
}
```

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

1. User fills fields, clicks Send (or presses Enter in a text field)
2. `template(values)` assembles a natural language message from field values
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

#### RepoPickerField Props

```ts
interface RepoPickerFieldProps {
  value: string;
  onChange: (value: string) => void;
  validation: 'idle' | 'loading' | 'valid' | 'invalid';
}
```

Internally manages: browse popover state, browse data, recent repos fetch. Exposes only value + onChange + validation state.

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
- Shows title (primary text) + first 6 chars of ID (muted secondary text)
- Searchable by title
- Selected value = task ID (used in template)
- Displays selected task's title in the trigger button

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

- Manages form values as `Record<string, string>`
- Renders each field using the appropriate component based on `field.type`
- Handles `dependsOn` by disabling fields whose dependency is empty
- Calls `command.template(values)` on submit
- Passes repo path to branch-picker when `dependsOn: 'repo'` is specified

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
| Create | `src/components/fields/RepoPickerField.tsx` | Repo input + browse + recent + validation |
| Create | `src/components/fields/BranchPickerField.tsx` | Searchable branch dropdown |
| Create | `src/components/fields/TaskPickerField.tsx` | Task title dropdown |
| Create | `src/components/CommandFieldForm.tsx` | Dynamic field form renderer |
| Modify | `src/lib/orchestrator-commands.ts` | Add `fields` + function templates to commands |
| Modify | `src/components/OrchestratorCommandBar.tsx` | Add `activeCommand` state, render form |
| Modify | `src/components/CreateTaskDialog.tsx` | Refactor to use extracted field components |

### Edge Cases

- **Repo picker validation**: Debounced (500ms) git validation, same as CreateTaskDialog
- **Branch picker with no repo**: Disabled state, shows "Select a repository first"
- **Task picker with no tasks**: Shows "No tasks found"
- **dependsOn chain**: Branch picker resets when repo changes (branches reload)
- **Escape key**: When form is open, closes form (does not send). When form is closed, clears text input (existing behavior).
- **Switching commands**: Clicking a different chip while a form is open replaces it with the new command's form (values reset)

## What We're NOT Building

- Field validation beyond required/dependsOn (orchestrator handles validation)
- Saving form state across command switches
- Custom user-defined commands
- Draft mode or any CreateTaskDialog-specific features (draft checkbox) in the command bar form — the command bar sends to the orchestrator, not the REST API directly
