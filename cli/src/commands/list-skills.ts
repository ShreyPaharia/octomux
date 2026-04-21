import chalk from 'chalk';
import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, printTable } from '../format.js';

export function registerListSkills(program: Command): void {
  program
    .command('list-skills')
    .description('List all installed skills')
    .action(async (_opts, cmd) => {
      const { client, json } = getContext(cmd);
      const skills = await client.listSkills();
      if (json) {
        outputJson(skills);
        return;
      }
      if (skills.length === 0) {
        console.log('No skills installed.');
        return;
      }
      printTable(
        [
          { header: 'NAME', width: 30, get: (s) => s.name },
          { header: 'DESCRIPTION', get: (s) => chalk.dim(s.description || '—') },
        ],
        skills,
      );
    });
}
