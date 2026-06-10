import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, success, label } from '../format.js';

export function registerAddAgent(program: Command): void {
  program
    .command('add-agent')
    .description('Add a new agent (tmux window) to an existing running task')
    .requiredOption('-t, --task <task-id>', 'task ID to add the agent to')
    .requiredOption('-p, --prompt <prompt>', 'initial prompt for the new agent')
    .option('-a, --agent <agent-type>', 'Claude Code agent type (e.g. code-reviewer)')
    .option('-l, --label <label>', 'label for the new agent (default: server-assigned "Agent N")')
    .option('--model <id>', 'per-agent model override (e.g. claude-opus-4-8, claude-sonnet-4-6)')
    .option('--skeleton <name>', 'role skeleton to load from <repo>/.octomux/agents/<name>.md')
    .option('--notify-agent <agent-id>', 'agent ID to notify when this agent finishes')
    .action(async (opts, cmd) => {
      const { client, json } = getContext(cmd);

      const payload: {
        prompt: string;
        agent?: string;
        label?: string;
        model?: string;
        skeleton?: string;
        notify_agent_id?: string;
      } = {
        prompt: opts.prompt,
      };
      if (opts.agent) payload.agent = opts.agent;
      if (opts.label) payload.label = opts.label;
      if (opts.model) payload.model = opts.model;
      if (opts.skeleton) payload.skeleton = opts.skeleton;
      if (opts.notifyAgent) payload.notify_agent_id = opts.notifyAgent;

      const agent = await client.addAgent(opts.task, payload);

      if (json) {
        outputJson(agent);
        return;
      }

      success(`Added agent to task ${opts.task}`);
      console.log(label('Agent ID', agent.id));
      console.log(label('Label', agent.label));
      console.log(label('Window', String(agent.window_index)));
    });
}
