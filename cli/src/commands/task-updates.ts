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
        const who = u.author ? ` [${u.author}]` : '';
        const ts = new Date(u.created_at).toLocaleString();
        console.log(`  ${ts}${who}  ${u.kind}`);
        if (u.payload) {
          try {
            const parsed = JSON.parse(u.payload);
            if (parsed.note) console.log(`    ${parsed.note}`);
            if (parsed.summary) console.log(`    ${parsed.summary}`);
            if (parsed.to) console.log(`    → ${parsed.to}`);
          } catch {
            console.log(`    ${u.payload}`);
          }
        }
      }
    });
}
