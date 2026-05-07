import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, success, label } from '../format.js';

export function registerTaskRefAdd(program: Command): void {
  program
    .command('task-ref-add <id> <integration> <external_id>')
    .description('Link an external reference (e.g. Jira ticket) to a task')
    .option('-u, --url <url>', 'URL for the external item')
    .option('-t, --title <title>', 'display title for the external item')
    .action(async (id: string, integration: string, externalId: string, opts, cmd) => {
      const { client, json } = getContext(cmd);

      const ref = await client.addTaskRef(id, {
        integration,
        external_id: externalId,
        url: opts.url,
        title: opts.title,
      });

      if (json) {
        outputJson(ref);
        return;
      }

      success(`Linked ${integration}:${externalId} to task ${id}`);
      if (ref.url) console.log(label('URL', ref.url));
      if (ref.title) console.log(label('Title', ref.title));
    });
}
