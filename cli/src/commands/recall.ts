import { Command } from 'commander';
import { errorMessage } from '../format.js';

interface RecalledLearning {
  id: string;
  lesson: string;
  evidence: string | null;
}

/**
 * octomux recall — the agent's on-demand pull, mid-run, for more than the
 * deterministic seed floor. Same env-var contract as `octomux learn`/`emit`.
 */
export function registerRecall(program: Command): void {
  program
    .command('recall')
    .description('Pull past learnings on this repo matching a topic')
    .requiredOption('--query <text>', 'topic to search trigger/lesson for')
    .action(async (opts: { query: string }) => {
      const baseUrl = process.env.OCTOMUX_ACTION_BASE_URL;
      const token = process.env.OCTOMUX_ACTION_TOKEN;
      const taskId = process.env.OCTOMUX_TASK_ID;
      if (!baseUrl || !token || !taskId) {
        errorMessage(
          'octomux recall is not configured (missing OCTOMUX_ACTION_* / OCTOMUX_TASK_ID)',
        );
        process.exit(1);
        return;
      }

      const url = new URL(`${baseUrl}/api/learnings`);
      url.searchParams.set('taskId', taskId);
      url.searchParams.set('query', opts.query);

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        errorMessage(`recall failed (HTTP ${res.status}): ${text}`);
        process.exit(1);
        return;
      }

      const rows = (await res.json()) as RecalledLearning[];
      if (rows.length === 0) {
        console.log('No learnings found.');
        return;
      }
      for (const row of rows) {
        console.log(
          row.evidence
            ? `[${row.id}] ${row.lesson} (${row.evidence})`
            : `[${row.id}] ${row.lesson}`,
        );
      }
    });
}
