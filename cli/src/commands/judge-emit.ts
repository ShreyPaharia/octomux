import { Command } from 'commander';
import { errorMessage, success } from '../format.js';

/**
 * octomux judge-emit — the best-of-N judge task's completion callback. Same
 * OCTOMUX_ACTION_BASE_URL / OCTOMUX_ACTION_TOKEN env-var pattern as `emit.ts`, since judge tasks
 * are launched through the same createTask path and get the same hook-token env injected.
 *
 * Posts to POST /api/runs/:id/emit (the `run.emit` capability,
 * server/registry/capabilities/run.ts) — `--group` takes the group's `runs.id`
 * (`loop_groups.run_id`), not its own `loop_groups.id`, since the loop/loop-group
 * route collapse (see server/routes/runs.ts's module doc).
 */
export function registerJudgeEmit(program: Command): void {
  program
    .command('judge-emit')
    .description('Report a best-of-N judge decision back to octomux')
    .requiredOption('--group <group-run-id>', "loop group's run ID (a `runs.id`)")
    .requiredOption('--winner <loop-run-id>', 'winning candidate loop run ID')
    .requiredOption('--rationale <text>', 'why this candidate won')
    .action(async (opts: { group: string; winner: string; rationale: string }) => {
      const baseUrl = process.env.OCTOMUX_ACTION_BASE_URL;
      const token = process.env.OCTOMUX_ACTION_TOKEN;
      if (!baseUrl || !token) {
        errorMessage(
          'octomux judge-emit is not configured (missing OCTOMUX_ACTION_BASE_URL / OCTOMUX_ACTION_TOKEN)',
        );
        process.exit(1);
        return;
      }

      const res = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(opts.group)}/emit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ winnerLoopRunId: opts.winner, rationale: opts.rationale }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        errorMessage(`judge-emit failed (HTTP ${res.status}): ${text}`);
        process.exit(1);
        return;
      }

      success(`Recorded judge winner ${opts.winner} for group ${opts.group}`);
    });
}
