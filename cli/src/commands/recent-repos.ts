import chalk from 'chalk';
import { Command } from 'commander';
import type { OctomuxClient } from '../client.js';
import { isJsonMode, outputJson, heading } from '../format.js';

export function registerRecentRepos(program: Command): void {
  program
    .command('recent-repos')
    .description('List recently used repositories')
    .action(async (_opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client: OctomuxClient = globals._client;
      const repos = await client.recentRepos();
      if (isJsonMode(globals.json)) {
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
