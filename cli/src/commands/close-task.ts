import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, success } from '../format.js';

export function registerCloseTask(program: Command): void {
  program
    .command('close-task <id>')
    .description('Close a running task')
    .action(async (id: string, _opts, cmd) => {
      const { client, json } = getContext(cmd);

      const task = await client.updateTask(id, { runtime_state: 'idle' });

      if (json) {
        outputJson(task);
        return;
      }

      success(`Closed task ${task.id} (${task.title})`);
    });
}
