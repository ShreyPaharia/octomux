import { broadcast } from '../events.js';
import { execTmux } from '../tmux-bin.js';
import { listRunningTerminals, updateUserTerminalStatus } from '../repositories/agent-runtime.js';
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
      const { stdout } = await execTmux([
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
