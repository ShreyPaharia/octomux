import { Command, Option } from 'commander';
import { errorMessage, success } from '../format.js';

const EMIT_STATUSES = ['done', 'blocked', 'needs_human'] as const;
type EmitStatus = (typeof EMIT_STATUSES)[number];

/**
 * octomux emit — the loop-harness completion callback. Reads the base URL and
 * bearer token from the same OCTOMUX_ACTION_* env vars the orchestrator's
 * other hook-calling code (server/orchestrator/mcp/write.ts) reads, since
 * they're set into the loop agent's shell the same way.
 *
 * Posts to POST /api/runs/:id/emit (the `run.emit` capability,
 * server/registry/capabilities/run.ts) — `--run` takes a `runs.id`, not a
 * loop_runs.id, since the loop/loop-group route collapse (see
 * server/routes/runs.ts's module doc).
 */
export function registerEmit(program: Command): void {
  program
    .command('emit')
    .description('Report loop-run completion status back to octomux')
    .requiredOption('-r, --run <run-id>', 'run ID (a `runs.id`)')
    .addOption(
      new Option('-s, --status <status>', 'completion status')
        .choices(EMIT_STATUSES)
        .makeOptionMandatory(),
    )
    .requiredOption('--reason <text>', 'reason for the status')
    .action(async (opts: { run: string; status: EmitStatus; reason: string }) => {
      const baseUrl = process.env.OCTOMUX_ACTION_BASE_URL;
      const token = process.env.OCTOMUX_ACTION_TOKEN;
      if (!baseUrl || !token) {
        errorMessage(
          'octomux emit is not configured (missing OCTOMUX_ACTION_BASE_URL / OCTOMUX_ACTION_TOKEN)',
        );
        process.exit(1);
        return;
      }

      const res = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(opts.run)}/emit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: opts.status, reason: opts.reason }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        errorMessage(`emit failed (HTTP ${res.status}): ${text}`);
        process.exit(1);
        return;
      }

      success(`Emitted ${opts.status} for loop run ${opts.run}`);
    });
}
