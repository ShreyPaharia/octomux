import { broadcast } from '../events.js';
import { sessionFor } from '../compute/index.js';
import { listRunningTerminals, updateUserTerminalStatus } from '../repositories/workers.js';
import { getTask } from '../repositories/tasks.js';
import type { UserTerminal } from '../types.js';

const SHELL_COMMANDS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash']);

interface TerminalRow extends UserTerminal {
  tmux_session: string;
}

export async function pollTerminalActivity(): Promise<void> {
  const rows = listRunningTerminals() as TerminalRow[];

  const changedTasks = new Set<string>();
  for (const row of rows) {
    try {
      // `listRunningTerminals` joins in the tmux session but not a full
      // Task — rehydrate so the probe hits the terminal's own compute, not
      // the local machine. One indexed getTask() per running user terminal
      // per poll tick; that count is small (interactive terminals a user
      // has open), so the N+1 here is cheap and correct beats silently
      // local-only.
      const task = getTask(row.task_id);
      if (!task) continue;
      const compute = await sessionFor(task);
      const { stdout } = await compute.tmux([
        'list-panes',
        '-t',
        `${row.tmux_session}:${row.window_index}`,
        '-F',
        '#{pane_current_command}',
      ]);
      const command = stdout.trim().split('\n')[0];
      const newStatus = SHELL_COMMANDS.has(command) ? 'idle' : 'working';
      if (newStatus !== row.status) {
        updateUserTerminalStatus(row.id, newStatus);
        changedTasks.add(row.task_id);
      }
    } catch {
      // Window may have been killed — ignore
    }
  }
  for (const taskId of changedTasks) {
    broadcast({ type: 'task:updated', payload: { taskId } });
  }
}
