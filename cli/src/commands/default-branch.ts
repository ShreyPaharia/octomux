import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson } from '../format.js';

export function registerDefaultBranch(program: Command): void {
  program
    .command('default-branch')
    .description('Get default branch for a repository')
    .requiredOption('-r, --repo-path <path>', 'path to the git repository')
    .action(async (opts, cmd) => {
      const { client, json } = getContext(cmd);
      const result = await client.defaultBranch(opts.repoPath);
      if (json) {
        outputJson(result);
        return;
      }
      console.log(result.branch);
    });
}
