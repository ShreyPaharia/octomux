import { Command } from 'commander';
import type { OctomuxClient } from '../client.js';
import { isJsonMode, success } from '../format.js';

export function registerDeleteTask(program: Command): void {
  program
    .command('delete-task <id>')
    .description('Delete a task (removes worktree, branch, and tmux session)')
    .action(async (id: string, _opts, cmd) => {
      const globals = cmd.optsWithGlobals();
      const client: OctomuxClient = globals._client;

      await client.deleteTask(id);

      if (isJsonMode(globals.json)) {
        console.log(JSON.stringify({ deleted: id }));
        return;
      }

      success(`Deleted task ${id}`);
    });
}
