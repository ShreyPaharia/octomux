import { parseArgs } from 'node:util';
import { completeRun, getCurrentRun } from '../../server/repositories/review-runs.js';
import { autoResolvePublished } from '../../server/review-staleness.js';

export async function runComplete(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    options: {
      task: { type: 'string' },
      'require-walkthrough': { type: 'boolean', default: false },
    },
  });
  if (!values.task) {
    process.stderr.write(`--task is required\n`);
    process.exit(2);
  }
  const taskId = values.task as string;

  const run = getCurrentRun(taskId);
  if (!run) {
    process.stderr.write(`no current review_run for task ${taskId}\n`);
    process.exit(2);
  }

  if (values['require-walkthrough'] && !run.walkthrough) {
    process.stderr.write(`walkthrough has not been written for run ${run.id}\n`);
    process.exit(2);
  }

  completeRun(run.id);
  await autoResolvePublished(taskId, run.id);

  process.stdout.write(JSON.stringify({ ok: true, run_id: run.id }) + '\n');
}
