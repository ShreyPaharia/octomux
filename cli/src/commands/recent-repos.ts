import chalk from 'chalk';
import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, printTable } from '../format.js';

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
      printTable(
        [
          { header: 'REPO PATH', width: 50, get: (r) => r.repo_path },
          { header: 'LAST USED', get: (r) => chalk.dim(r.last_used) },
        ],
        repos,
        { separatorWidth: 70 },
      );
    });
}
