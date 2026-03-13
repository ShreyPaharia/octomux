import { Command } from 'commander';
import type { OctomuxClient } from '../client.js';
import { isJsonMode, outputJson, success } from '../format.js';

export function registerSendMessage(program: Command): void {
  program
    .command('send-message <message>')
    .description('Send a message to an agent via tmux send-keys')
    .requiredOption('-t, --task <task-id>', 'task ID')
    .requiredOption('-a, --agent <agent-id>', 'agent ID')
    .action(async (message: string, opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client: OctomuxClient = globals._client;

      const result = await client.sendMessage(opts.task, opts.agent, message);

      if (isJsonMode(globals.json)) {
        outputJson(result);
        return;
      }

      success(`Message sent to agent ${opts.agent} on task ${opts.task}`);
    });
}
