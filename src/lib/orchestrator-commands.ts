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
