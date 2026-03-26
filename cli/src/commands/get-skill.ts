import { Command } from 'commander';
import type { OctomuxClient } from '../client.js';
import { isJsonMode, outputJson, heading } from '../format.js';

export function registerGetSkill(program: Command): void {
  program
    .command('get-skill <name>')
    .description('Get skill content')
    .action(async (name: string, _opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client: OctomuxClient = globals._client;
      const skill = await client.getSkill(name);
      if (isJsonMode(globals.json)) {
        outputJson(skill);
        return;
      }
      heading(`Skill: ${skill.name}`);
      console.log('');
      console.log(skill.content);
    });
}
