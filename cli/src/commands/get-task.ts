import chalk from 'chalk';
import { Command } from 'commander';
import type { OctomuxClient } from '../client.js';
import {
  isJsonMode,
  outputJson,
  label,
  heading,
  colorStatus,
  colorAgentStatus,
} from '../format.js';

export function registerGetTask(program: Command): void {
  program
    .command('get-task <id>')
    .alias('info')
    .description('Get task details')
    .action(async (id: string, _opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client: OctomuxClient = globals._client;

      const task = await client.getTask(id);

      if (isJsonMode(globals.json)) {
        outputJson(task);
        return;
      }

      heading(`Task ${task.id}`);
      console.log(label('Title', task.title));
      console.log(label('Status', colorStatus(task.status)));
      console.log(label('Repo', task.repo_path));
      console.log(label('Branch', task.branch));
      if (task.base_branch) console.log(label('Base Branch', task.base_branch));
      if (task.pr_url) console.log(label('PR', task.pr_url));
      if (task.error) console.log(label('Error', chalk.red(task.error)));
      console.log(label('Created', task.created_at));
      console.log(label('Updated', task.updated_at));

      if (task.agents && task.agents.length > 0) {
        console.log('');
        heading('Agents');
        for (const agent of task.agents) {
          console.log(
            `  ${agent.label.padEnd(20)} ${colorAgentStatus(agent.status).padEnd(18 + 10)} window:${agent.window_index}`,
          );
        }
      }
    });
}
