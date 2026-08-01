import { Command } from 'commander';
import { errorMessage, success } from '../format.js';

/**
 * octomux learn — the agent's own write path for durable, evidenced lessons.
 * Reads the base URL / bearer token / task id from the same OCTOMUX_ACTION_* /
 * OCTOMUX_TASK_ID env vars `octomux emit` reads, since they're set into the
 * running agent's shell the same way.
 */
export function registerLearn(program: Command): void {
  program
    .command('learn')
    .description('Record a durable learning for future runs on this repo')
    .requiredOption('--trigger <text>', 'the situation this applies to')
    .requiredOption('--lesson <text>', 'the durable fact or action')
    .requiredOption('--evidence <text>', 'the file/command/error that proves it')
    .option('--private', "store in this job's private lane instead of the shared repo pool", false)
    .action(
      async (opts: { trigger: string; lesson: string; evidence: string; private: boolean }) => {
        const baseUrl = process.env.OCTOMUX_ACTION_BASE_URL;
        const token = process.env.OCTOMUX_ACTION_TOKEN;
        const taskId = process.env.OCTOMUX_TASK_ID;
        if (!baseUrl || !token || !taskId) {
          errorMessage(
            'octomux learn is not configured (missing OCTOMUX_ACTION_* / OCTOMUX_TASK_ID)',
          );
          process.exit(1);
          return;
        }

        const res = await fetch(`${baseUrl}/api/learnings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            taskId,
            trigger: opts.trigger,
            lesson: opts.lesson,
            evidence: opts.evidence,
            private: opts.private,
          }),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          errorMessage(`learn failed (HTTP ${res.status}): ${text}`);
          process.exit(1);
          return;
        }

        success('Learning recorded');
      },
    );
}
