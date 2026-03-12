import chalk from 'chalk';
import { Command } from 'commander';
import type { OctomuxClient } from '../client.js';
import { isJsonMode, outputJson, colorStatus, heading } from '../format.js';

export function registerListTasks(program: Command): void {
  program
    .command('list-tasks')
    .alias('ls')
    .description('List all tasks')
    .option('--status <status>', 'filter by status (draft, setting_up, running, closed, error)')
    .option('--repo-path <path>', 'filter by repository path')
    .action(async (opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client: OctomuxClient = globals._client;

      let tasks = await client.listTasks(opts.repoPath ? { repo_path: opts.repoPath } : undefined);

      if (opts.status) {
        tasks = tasks.filter((t) => t.status === opts.status);
      }

      if (isJsonMode(globals.json)) {
        outputJson(tasks);
        return;
      }

      if (tasks.length === 0) {
        console.log('No tasks found.');
        return;
      }

      heading(`${'ID'.padEnd(14)}${'STATUS'.padEnd(14)}TITLE`);
      console.log(chalk.dim('─'.repeat(60)));
      for (const t of tasks) {
        console.log(`${t.id.padEnd(14)}${colorStatus(t.status).padEnd(14 + 10)}${t.title}`);
      }
    });
}
