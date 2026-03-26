import { Command } from 'commander';
import type { OctomuxClient } from '../client.js';
import { isJsonMode, success } from '../format.js';

export function registerStopAgent(program: Command): void {
  program
    .command('stop-agent <agent-id>')
    .description('Stop a specific agent on a task')
    .requiredOption('-t, --task <task-id>', 'task ID')
    .action(async (agentId: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client: OctomuxClient = globals._client;

      await client.stopAgent(opts.task, agentId);

      if (isJsonMode(globals.json)) {
        console.log(JSON.stringify({ stopped: agentId, task: opts.task }));
        return;
      }

      success(`Stopped agent ${agentId} on task ${opts.task}`);
    });
}
