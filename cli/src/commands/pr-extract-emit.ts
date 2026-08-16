import { Command, Option } from 'commander';
import { errorMessage, success } from '../format.js';

const RISK_VALUES = ['low', 'medium', 'high'] as const;
type Risk = (typeof RISK_VALUES)[number];

/**
 * octomux pr-extract emit — reports the PR-extract workflow's structured
 * output back to octomux. Reads OCTOMUX_ACTION_BASE_URL/TOKEN the same way
 * `octomux emit` does (server/task-engine/launch.ts injects both into every
 * task's agent env, not just loop tasks). The server derives repo/PR
 * metadata from the task row itself — this command only carries the
 * extracted fields.
 */
export function registerPrExtractEmit(program: Command): void {
  const prExtract = program.command('pr-extract').description('PR-extract workflow commands');

  prExtract
    .command('emit')
    .description('Report extracted PR metadata back to octomux')
    .requiredOption('-t, --task <task-id>', 'extract task ID')
    .requiredOption('--area <area>', 'primary subsystem touched')
    .addOption(
      new Option('--risk <risk>', 'risk assessment').choices(RISK_VALUES).makeOptionMandatory(),
    )
    .requiredOption('--has-migration <bool>', 'true|false — includes a DB migration')
    .requiredOption('--surface <surface>', 'user-facing surface touched')
    .requiredOption('--loc <n>', 'total lines changed', (v: string) => parseInt(v, 10))
    .action(
      async (opts: {
        task: string;
        area: string;
        risk: Risk;
        hasMigration: string;
        surface: string;
        loc: number;
      }) => {
        const baseUrl = process.env.OCTOMUX_ACTION_BASE_URL;
        const token = process.env.OCTOMUX_ACTION_TOKEN;
        if (!baseUrl || !token) {
          errorMessage(
            'octomux pr-extract emit is not configured (missing OCTOMUX_ACTION_BASE_URL / ' +
              'OCTOMUX_ACTION_TOKEN)',
          );
          process.exit(1);
          return;
        }

        const res = await fetch(
          `${baseUrl}/api/pr-extracts/${encodeURIComponent(opts.task)}/emit`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              area: opts.area,
              risk: opts.risk,
              has_migration: opts.hasMigration === 'true',
              surface: opts.surface,
              loc: opts.loc,
            }),
          },
        );

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          errorMessage(`pr-extract emit failed (HTTP ${res.status}): ${text}`);
          process.exit(1);
          return;
        }

        success(`Emitted PR extract for task ${opts.task}`);
      },
    );
}
