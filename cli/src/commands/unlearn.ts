import { Command } from 'commander';
import { errorMessage, success } from '../format.js';

/**
 * octomux unlearn — soft-supersede a seeded learning that's now false.
 * Reversible (the row stays, just filtered out of future reads) and
 * auditable (the reason is recorded). `learn` stays add-only; "update" a
 * learning means `unlearn` the old one + `learn` the new one.
 */
export function registerUnlearn(program: Command): void {
  program
    .command('unlearn')
    .description('Soft-supersede a learning that is no longer true')
    .argument('<id>', 'the learning id (shown in seeded notes / recall output)')
    .requiredOption('--reason <text>', 'why this learning is no longer true')
    .action(async (id: string, opts: { reason: string }) => {
      const baseUrl = process.env.OCTOMUX_ACTION_BASE_URL;
      const token = process.env.OCTOMUX_ACTION_TOKEN;
      const taskId = process.env.OCTOMUX_TASK_ID;
      if (!baseUrl || !token || !taskId) {
        errorMessage(
          'octomux unlearn is not configured (missing OCTOMUX_ACTION_* / OCTOMUX_TASK_ID)',
        );
        process.exit(1);
        return;
      }

      const res = await fetch(`${baseUrl}/api/learnings/${id}/supersede`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ taskId, reason: opts.reason }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        errorMessage(`unlearn failed (HTTP ${res.status}): ${text}`);
        process.exit(1);
        return;
      }

      success('Learning superseded');
    });
}
