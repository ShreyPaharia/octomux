import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import { getContext } from '../action.js';
import { outputJson, printTable, errorMessage } from '../format.js';

interface FilesOptions {
  repo?: string;
}

function repoPath(opts: FilesOptions): string {
  return opts.repo ?? process.cwd();
}

export function registerFiles(program: Command): void {
  const files = program
    .command('files')
    .description('List, read, and write repo-portable saved files under .octomux/files/');

  files
    .command('list')
    .description('List saved files in <repo>/.octomux/files/')
    .option('-r, --repo <path>', 'repository path (default: cwd)')
    .action(async (opts: FilesOptions, cmd: Command) => {
      const { client, json } = getContext(cmd);
      const entries = await client.listSavedFiles(repoPath(opts));
      if (json) {
        outputJson(entries);
        return;
      }
      if (entries.length === 0) {
        console.log('No saved files.');
        return;
      }
      printTable(
        [
          { header: 'PATH', width: 40, get: (e) => e.path },
          { header: 'SIZE', width: 10, get: (e) => String(e.size) },
        ],
        entries,
      );
    });

  files
    .command('get <path>')
    .description('Read a saved file')
    .option('-r, --repo <path>', 'repository path (default: cwd)')
    .action(async (filePath: string, opts: FilesOptions, cmd: Command) => {
      const { client, json } = getContext(cmd);
      const file = await client.getSavedFile(repoPath(opts), filePath);
      if (json) {
        outputJson(file);
        return;
      }
      console.log(file.content);
    });

  files
    .command('put <path>')
    .description('Write a saved file (content from --content or stdin)')
    .option('-r, --repo <path>', 'repository path (default: cwd)')
    .option('-c, --content <text>', 'file content (default: read stdin)')
    .action(async (filePath: string, opts: FilesOptions & { content?: string }, cmd: Command) => {
      const { client, json } = getContext(cmd);
      let content = opts.content;
      if (content === undefined) {
        if (process.stdin.isTTY) {
          errorMessage('Provide --content or pipe content on stdin');
          process.exit(1);
        }
        content = await fs.promises.readFile(0, 'utf-8');
      }
      const file = await client.putSavedFile(repoPath(opts), filePath, content);
      if (json) {
        outputJson(file);
        return;
      }
      console.log(chalk.green(`Wrote ${file.path}`));
    });
}
