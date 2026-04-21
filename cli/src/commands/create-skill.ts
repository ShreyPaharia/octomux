import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, success } from '../format.js';

export function registerCreateSkill(program: Command): void {
  program
    .command('create-skill')
    .description('Create a new skill')
    .requiredOption('-n, --name <name>', 'skill name (lowercase, hyphens)')
    .option('-c, --content <content>', 'initial content', '')
    .action(async (opts, cmd) => {
      const { client, json } = getContext(cmd);
      const content = opts.content || `---\nname: ${opts.name}\ndescription: \n---\n\n`;
      const skill = await client.createSkill({ name: opts.name, content });
      if (json) {
        outputJson(skill);
        return;
      }
      success(`Created skill "${skill.name}"`);
    });
}
