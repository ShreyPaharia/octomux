import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, success, label } from '../format.js';

function parseMetadata(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('--metadata is invalid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--metadata must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function registerTaskRefAdd(program: Command): void {
  program
    .command('task-ref-add <id> <integration> <external_id>')
    .description('Link an external reference (e.g. Jira ticket, Linear issue) to a task')
    .option('-u, --url <url>', 'URL for the external item')
    .option('-t, --title <title>', 'display title for the external item')
    .option('-m, --metadata <json>', 'JSON object with integration-specific metadata')
    .action(async (id: string, integration: string, externalId: string, opts, cmd) => {
      const { client, json } = getContext(cmd);

      const metadata = parseMetadata(opts.metadata as string | undefined);
      const mergedMetadata =
        opts.title !== undefined ? { ...metadata, title: opts.title } : metadata;

      const ref = await client.addTaskRef(id, {
        integration,
        ref: externalId,
        url: opts.url,
        ...(mergedMetadata !== undefined ? { metadata: mergedMetadata } : {}),
      });

      if (json) {
        outputJson(ref);
        return;
      }

      success(`Linked ${integration}:${externalId} to task ${id}`);
      if (ref.url) console.log(label('URL', ref.url));
      console.log(label('Ref', ref.ref));
    });
}
