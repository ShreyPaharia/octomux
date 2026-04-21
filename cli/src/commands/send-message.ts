import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, success } from '../format.js';

export function registerSendMessage(program: Command): void {
  program
    .command('send-message <message>')
    .description('Send a message to an agent via tmux send-keys')
    .requiredOption('-t, --task <task-id>', 'task ID')
    .requiredOption('-a, --agent <agent-id>', 'agent ID')
    .action(async (message: string, opts, cmd) => {
      const { client, json } = getContext(cmd);

      const result = await client.sendMessage(opts.task, opts.agent, message);

      if (json) {
        outputJson(result);
        return;
      }

      success(`Message sent to agent ${opts.agent} on task ${opts.task}`);
    });
}
