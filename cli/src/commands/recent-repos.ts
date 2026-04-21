import chalk from 'chalk';
import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, heading } from '../format.js';

export function registerRecentRepos(program: Command): void {
  program
    .command('recent-repos')
    .description('List recently used repositories')
    .action(async (_opts, cmd) => {
      const { client, json } = getContext(cmd);
      const repos = await client.recentRepos();
      if (json) {
        outputJson(repos);
        return;
      }
      if (repos.length === 0) {
        console.log('No recent repos.');
        return;
      }
      heading(`${'REPO PATH'.padEnd(50)}LAST USED`);
      console.log(chalk.dim('─'.repeat(70)));
      for (const r of repos) {
        console.log(`${r.repo_path.padEnd(50)}${chalk.dim(r.last_used)}`);
      }
    });
}
