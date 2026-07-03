import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, success, colorStatus, label, taskDisplayStatus } from '../format.js';

export function registerResumeTask(program: Command): void {
  program
    .command('resume-task <id>')
    .description('Resume a closed or errored task')
    .action(async (id: string, _opts, cmd) => {
      const { client, json } = getContext(cmd);

      const task = await client.updateTask(id, { runtime_state: 'running' });

      if (json) {
        outputJson(task);
        return;
      }

      success(`Resumed task ${task.id}`);
      console.log(label('Title', task.title));
      console.log(label('Status', colorStatus(taskDisplayStatus(task))));
    });
}
