import { Command } from 'commander';
import type { OctomuxClient } from '../client.js';
import { isJsonMode, outputJson, success, label } from '../format.js';

export function registerAddAgent(program: Command): void {
  program
    .command('add-agent <task-id>')
    .description('Add a new agent to a running task')
    .option('-p, --prompt <prompt>', 'initial prompt for the agent')
    .action(async (taskId: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client: OctomuxClient = globals._client;

      const agent = await client.addAgent(
        taskId,
        opts.prompt ? { prompt: opts.prompt } : undefined,
      );

      if (isJsonMode(globals.json)) {
        outputJson(agent);
        return;
      }

      success(`Added agent to task ${taskId}`);
      console.log(label('Agent ID', agent.id));
      console.log(label('Label', agent.label));
      console.log(label('Window', String(agent.window_index)));
    });
}
