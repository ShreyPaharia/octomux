import { Command } from 'commander';
import type { OctomuxClient } from '../client.js';
import { isJsonMode, outputJson, success, colorStatus, label } from '../format.js';

export function registerResumeTask(program: Command): void {
  program
    .command('resume-task <id>')
    .description('Resume a closed or errored task')
    .action(async (id: string, _opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client: OctomuxClient = globals._client;

      const task = await client.updateTask(id, { status: 'running' });

      if (isJsonMode(globals.json)) {
        outputJson(task);
        return;
      }

      success(`Resumed task ${task.id}`);
      console.log(label('Title', task.title));
      console.log(label('Status', colorStatus(task.status)));
    });
}
