import { Command } from 'commander';
import type { OctomuxClient } from '../client.js';
import { isJsonMode, success } from '../format.js';

export function registerDeleteSkill(program: Command): void {
  program
    .command('delete-skill <name>')
    .description('Delete a skill')
    .action(async (name: string, _opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client: OctomuxClient = globals._client;
      await client.deleteSkill(name);
      if (isJsonMode(globals.json)) {
        console.log(JSON.stringify({ deleted: name }));
        return;
      }
      success(`Deleted skill "${name}"`);
    });
}
