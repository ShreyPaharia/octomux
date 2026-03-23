export interface CommandField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'repo-picker' | 'branch-picker' | 'task-picker' | 'checkbox';
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
      {
        name: 'description',
        label: 'Description',
        type: 'textarea',
        placeholder: 'Describe what needs to be done...',
      },
      {
        name: 'prompt',
        label: 'Initial Prompt',
        type: 'textarea',
        placeholder: 'Tell the agent what to do...',
      },
      {
        name: 'draft',
        label: 'Save as draft (start later)',
        type: 'checkbox',
      },
    ],
    buildMessage: (v) =>
      `Create a task titled "${v.title}" in repo ${v.repo}${v.baseBranch ? ` with base branch ${v.baseBranch}` : ''}${v.description ? `. Description: ${v.description}` : ''}${v.prompt ? `. Prompt: ${v.prompt}` : ''}${v.draft === 'true' ? '. Create it as a draft — do not start it yet.' : ''}`,
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
    fields: [{ name: 'task', label: 'Task', type: 'task-picker', required: true }],
    buildMessage: (v) => `What is the status of task ${v.task}?`,
  },
  {
    slash: '/create-pr',
    chipLabel: 'Create PR',
    description: 'Create a PR for a completed task',
    fields: [{ name: 'task', label: 'Task', type: 'task-picker', required: true }],
    buildMessage: (v) => `Create a PR for task ${v.task}`,
  },
];

export function filterCommands(query: string): OrchestratorCommand[] {
  const q = query.toLowerCase();
  return COMMANDS.filter((cmd) => cmd.slash.slice(1).startsWith(q));
}
