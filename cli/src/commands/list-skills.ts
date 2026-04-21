import chalk from 'chalk';
import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, heading } from '../format.js';

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
      heading(`${'NAME'.padEnd(30)}DESCRIPTION`);
      console.log(chalk.dim('─'.repeat(60)));
      for (const s of skills) {
        console.log(`${s.name.padEnd(30)}${chalk.dim(s.description || '—')}`);
      }
    });
}
