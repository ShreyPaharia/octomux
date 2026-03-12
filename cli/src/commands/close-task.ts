import { Command } from 'commander';
import type { OctomuxClient } from '../client.js';
import { isJsonMode, outputJson, success } from '../format.js';

export function registerCloseTask(program: Command): void {
  program
    .command('close-task <id>')
    .description('Close a running task')
    .action(async (id: string, _opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client: OctomuxClient = globals._client;

      const task = await client.updateTask(id, { status: 'closed' });

      if (isJsonMode(globals.json)) {
        outputJson(task);
        return;
      }

      success(`Closed task ${task.id} (${task.title})`);
    });
}
