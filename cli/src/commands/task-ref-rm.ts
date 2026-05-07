import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, success } from '../format.js';

export function registerTaskRefRm(program: Command): void {
  program
    .command('task-ref-rm <id> <integration>')
    .description('Remove an external reference from a task')
    .action(async (id: string, integration: string, _opts, cmd) => {
      const { client, json } = getContext(cmd);

      await client.deleteTaskRef(id, integration);

      if (json) {
        outputJson({ ok: true });
        return;
      }

      success(`Removed ${integration} ref from task ${id}`);
    });
}
