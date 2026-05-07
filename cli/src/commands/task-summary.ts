import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, success, label } from '../format.js';

export function registerTaskSummary(program: Command): void {
  program
    .command('task-summary <id> <summary>')
    .description('Update the current summary of a task')
    .option('-a, --author <author>', 'author label (default: cli)')
    .action(async (id: string, summary: string, opts, cmd) => {
      const { client, json } = getContext(cmd);

      const task = await client.postTaskSummary(id, {
        summary,
        author: opts.author,
      });

      if (json) {
        outputJson(task);
        return;
      }

      success(`Updated summary for task ${task.id}`);
      console.log(label('Title', task.title));
      console.log(label('Summary', task.current_summary ?? '(none)'));
    });
}
