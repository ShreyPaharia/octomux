import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, heading } from '../format.js';

export function registerTaskUpdates(program: Command): void {
  program
    .command('task-updates <id>')
    .description('List activity log entries for a task')
    .action(async (id: string, _opts, cmd) => {
      const { client, json } = getContext(cmd);

      const { updates } = await client.getTaskUpdates(id);

      if (json) {
        outputJson(updates);
        return;
      }

      if (updates.length === 0) {
        console.log('No updates found.');
        return;
      }

      heading(`Updates for task ${id}`);
      for (const u of updates) {
        const ts = new Date(u.created_at).toLocaleString();
        const transition =
          u.from_status && u.to_status ? `${u.from_status} → ${u.to_status}` : null;
        console.log(`  ${ts}  ${u.kind}${transition ? `  ${transition}` : ''}`);
        if (u.body) {
          console.log(`    ${u.body}`);
        }
      }
    });
}
