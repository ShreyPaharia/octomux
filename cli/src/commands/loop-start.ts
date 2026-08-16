import fs from 'node:fs';
import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, label, success } from '../format.js';

function resolvePrompt(raw: string): string {
  if (raw.startsWith('@')) {
    return fs.readFileSync(raw.slice(1), 'utf-8');
  }
  return raw;
}

/**
 * octomux loop start — begin a fresh-context Ralph loop against a running
 * task. Uses --stall-after (not --no-progress): commander treats any flag
 * literally starting with `no-` as a boolean negation, which cannot carry a
 * value, so a `--no-progress <n>` flag would silently misparse.
 */
export function registerLoopStart(program: Command): void {
  program
    .command('loop-start')
    .description('Start a fresh-context Ralph loop against a running task')
    .requiredOption('--task <id>', 'task ID to loop')
    .requiredOption('--prompt <text|@file>', 'loop prompt, or @path to read it from a file')
    .requiredOption('--verify <cmd>', 'shell command that must exit 0 for the loop to be done')
    .requiredOption('--max-iterations <n>', 'maximum number of iterations', (v) => parseInt(v, 10))
    .option('--budget-tokens <n>', 'token budget ceiling', (v) => parseInt(v, 10))
    .option(
      '--stall-after <n>',
      'stop after N consecutive no-op iterations (maps to spec.noProgress.afterIters)',
      (v) => parseInt(v, 10),
    )
    .action(async (opts, cmd) => {
      const { client, json } = getContext(cmd);

      const result = await client.startLoop({
        taskId: opts.task,
        spec: {
          prompt: resolvePrompt(opts.prompt),
          verify: opts.verify,
          maxIterations: opts.maxIterations,
          ...(opts.budgetTokens != null ? { budget: { tokens: opts.budgetTokens } } : {}),
          ...(opts.stallAfter != null ? { noProgress: { afterIters: opts.stallAfter } } : {}),
        },
      });

      if (json) {
        outputJson(result);
        return;
      }

      // result.id is a `runs.id` — the id `octomux emit --run <id>` will report
      // back against, not the nested loop_run's own id.
      success(`Started loop run ${result.id}`);
      console.log(label('Task', result.loop?.task_id ?? opts.task));
      console.log(label('Status', result.loop?.status ?? result.status));
    });
}
