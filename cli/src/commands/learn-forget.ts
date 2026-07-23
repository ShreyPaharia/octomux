import { Command } from 'commander';
import { errorMessage, success } from '../format.js';

/**
 * octomux learn-forget — hard-delete a learning. This stays a human/digest
 * action (see `unlearn` for the reversible soft-supersede an agent should
 * reach for instead), typically run after reviewing the weekly digest's
 * removal candidates (unused or superseded rows).
 */
export function registerLearnForget(program: Command): void {
  program
    .command('learn-forget')
    .description(
      'Permanently delete a learning (human/digest action — prefer `unlearn` to supersede)',
    )
    .argument('<id>', 'the learning id')
    .action(async (id: string) => {
      const baseUrl = process.env.OCTOMUX_ACTION_BASE_URL;
      const token = process.env.OCTOMUX_ACTION_TOKEN;
      if (!baseUrl || !token) {
        errorMessage(
          'octomux learn-forget is not configured (missing OCTOMUX_ACTION_BASE_URL / OCTOMUX_ACTION_TOKEN)',
        );
        process.exit(1);
        return;
      }

      const res = await fetch(`${baseUrl}/api/learnings/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        errorMessage(`learn-forget failed (HTTP ${res.status}): ${text}`);
        process.exit(1);
        return;
      }

      success('Learning deleted');
    });
}
