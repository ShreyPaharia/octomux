import { Command } from 'commander';
import { getContext } from '../action.js';
import {
  outputJson,
  colorStatus,
  printTable,
  taskDisplayStatus,
  taskMatchesStatusFilter,
} from '../format.js';

export function registerListTasks(program: Command): void {
  program
    .command('list-tasks')
    .alias('ls')
    .description('List all tasks')
    .option('--status <status>', 'filter by status (draft, setting_up, running, closed, error)')
    .option('--repo-path <path>', 'filter by repository path')
    .action(async (opts, cmd) => {
      const { client, json } = getContext(cmd);

      let tasks = await client.listTasks(opts.repoPath ? { repo_path: opts.repoPath } : undefined);

      if (opts.status) {
        tasks = tasks.filter((t) => taskMatchesStatusFilter(t, opts.status));
      }

      if (json) {
        outputJson(tasks);
        return;
      }

      if (tasks.length === 0) {
        console.log('No tasks found.');
        return;
      }

      printTable(
        [
          { header: 'ID', width: 14, get: (t) => t.id },
          { header: 'STATUS', width: 14, get: (t) => colorStatus(taskDisplayStatus(t)) },
          { header: 'TITLE', get: (t) => t.title },
        ],
        tasks,
      );
    });
}
