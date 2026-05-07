import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, success } from '../format.js';

export function registerTaskNote(program: Command): void {
  program
    .command('task-note <id> <note>')
    .description('Add a note to a task activity log')
    .option('-a, --author <author>', 'author label (default: cli)')
    .action(async (id: string, note: string, opts, cmd) => {
      const { client, json } = getContext(cmd);

      const result = await client.postTaskNote(id, {
        note,
        author: opts.author,
      });

      if (json) {
        outputJson(result);
        return;
      }

      success(`Note added to task ${id}`);
    });
}
