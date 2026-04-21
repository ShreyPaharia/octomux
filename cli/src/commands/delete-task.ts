import { Command } from 'commander';
import { getContext } from '../action.js';
import { success } from '../format.js';

export function registerDeleteTask(program: Command): void {
  program
    .command('delete-task <id>')
    .description('Delete a task (removes worktree, branch, and tmux session)')
    .action(async (id: string, _opts, cmd) => {
      const { client, json } = getContext(cmd);

      await client.deleteTask(id);

      if (json) {
        console.log(JSON.stringify({ deleted: id }));
        return;
      }

      success(`Deleted task ${id}`);
    });
}
