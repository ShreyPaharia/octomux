import { Command } from 'commander';
import type { OctomuxClient } from '../client.js';
import { isJsonMode, outputJson, success } from '../format.js';

export function registerCreateSkill(program: Command): void {
  program
    .command('create-skill')
    .description('Create a new skill')
    .requiredOption('-n, --name <name>', 'skill name (lowercase, hyphens)')
    .option('-c, --content <content>', 'initial content', '')
    .action(async (opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client: OctomuxClient = globals._client;
      const content = opts.content || `---\nname: ${opts.name}\ndescription: \n---\n\n`;
      const skill = await client.createSkill({ name: opts.name, content });
      if (isJsonMode(globals.json)) {
        outputJson(skill);
        return;
      }
      success(`Created skill "${skill.name}"`);
    });
}
