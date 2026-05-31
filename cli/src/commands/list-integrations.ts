import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, printTable } from '../format.js';
import type { IntegrationRow } from '../client.js';

/** The non-secret, tracker-relevant fields the create-task flow cares about. */
export interface TrackerDefaults {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  base_url?: string;
  default_project?: string;
  default_team_key?: string;
}

export function toTrackerDefaults(row: IntegrationRow): TrackerDefaults {
  const cfg = row.config ?? {};
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled,
    base_url: str(cfg.base_url),
    default_project: str(cfg.default_project),
    default_team_key: str(cfg.default_team_key),
  };
}

export function registerListIntegrations(program: Command): void {
  program
    .command('list-integrations')
    .description(
      'List configured integrations with their tracker defaults (secrets masked). ' +
        'Use this to resolve the default Jira project / Linear team for a task.',
    )
    .option('--enabled', 'only show enabled integrations')
    .action(async (opts: { enabled?: boolean }, cmd) => {
      const { client, json } = getContext(cmd);

      let rows = await client.listIntegrations();
      if (opts.enabled) rows = rows.filter((r) => r.enabled);
      const defaults = rows.map(toTrackerDefaults);

      if (json) {
        outputJson(defaults);
        return;
      }

      if (defaults.length === 0) {
        console.log('No integrations configured.');
        return;
      }

      printTable(
        [
          { header: 'KIND', width: 10, get: (r: TrackerDefaults) => r.kind },
          { header: 'NAME', width: 22, get: (r: TrackerDefaults) => r.name },
          { header: 'ENABLED', width: 9, get: (r: TrackerDefaults) => (r.enabled ? 'yes' : 'no') },
          {
            header: 'DEFAULT',
            get: (r: TrackerDefaults) => r.default_project ?? r.default_team_key ?? '—',
          },
        ],
        defaults,
      );
    });
}
