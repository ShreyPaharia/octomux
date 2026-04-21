import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, heading } from '../format.js';

export function registerGetSkill(program: Command): void {
  program
    .command('get-skill <name>')
    .description('Get skill content')
    .action(async (name: string, _opts, cmd) => {
      const { client, json } = getContext(cmd);
      const skill = await client.getSkill(name);
      if (json) {
        outputJson(skill);
        return;
      }
      heading(`Skill: ${skill.name}`);
      console.log('');
      console.log(skill.content);
    });
}
