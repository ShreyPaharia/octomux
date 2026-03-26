import { Command } from 'commander';
import type { OctomuxClient } from '../client.js';
import { isJsonMode, outputJson } from '../format.js';

export function registerDefaultBranch(program: Command): void {
  program
    .command('default-branch')
    .description('Get default branch for a repository')
    .requiredOption('-r, --repo-path <path>', 'path to the git repository')
    .action(async (opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client: OctomuxClient = globals._client;
      const result = await client.defaultBranch(opts.repoPath);
      if (isJsonMode(globals.json)) {
        outputJson(result);
        return;
      }
      console.log(result.branch);
    });
}
