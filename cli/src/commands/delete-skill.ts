import { Command } from 'commander';
import { getContext } from '../action.js';
import { success } from '../format.js';

export function registerDeleteSkill(program: Command): void {
  program
    .command('delete-skill <name>')
    .description('Delete a skill')
    .action(async (name: string, _opts, cmd) => {
      const { client, json } = getContext(cmd);
      await client.deleteSkill(name);
      if (json) {
        console.log(JSON.stringify({ deleted: name }));
        return;
      }
      success(`Deleted skill "${name}"`);
    });
}
