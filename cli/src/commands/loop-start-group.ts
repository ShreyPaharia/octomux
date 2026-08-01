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

const DEFAULT_N = 3;

/** octomux loop-start-group — launch the same LoopSpec as N parallel candidate loops (best-of-N),
 * each its own fresh task/worktree off --base-branch. See loop-start.ts for the single-loop form. */
export function registerLoopStartGroup(program: Command): void {
  program
    .command('loop-start-group')
    .description('Launch N parallel candidate loops (best-of-N) from the same spec')
    .requiredOption('--repo <path>', 'repo path to fan candidates out from')
    .requiredOption('--base-branch <branch>', 'base branch each candidate starts from')
    .requiredOption('--prompt <text|@file>', 'loop prompt, or @path to read it from a file')
    .requiredOption('--verify <cmd>', 'shell command that must exit 0 for a candidate to be done')
    .requiredOption('--max-iterations <n>', 'maximum iterations per candidate', (v) =>
      parseInt(v, 10),
    )
    .option('--n <count>', 'number of candidates', (v) => parseInt(v, 10), DEFAULT_N)
    .option('--budget-tokens <n>', 'per-candidate token budget ceiling', (v) => parseInt(v, 10))
    .action(async (opts, cmd) => {
      const { client, json } = getContext(cmd);

      const group = await client.startLoopGroup({
        repoPath: opts.repo,
        baseBranch: opts.baseBranch,
        spec: {
          prompt: resolvePrompt(opts.prompt),
          verify: opts.verify,
          maxIterations: opts.maxIterations,
          ...(opts.budgetTokens != null ? { budget: { tokens: opts.budgetTokens } } : {}),
        },
        n: opts.n,
      });

      if (json) {
        outputJson(group);
        return;
      }

      success(`Started loop group ${group.id} with ${group.n} candidates`);
      console.log(label('Repo', group.repo_path));
      console.log(label('Base branch', group.base_branch));
      for (const run of group.loopRuns) {
        console.log(label('Candidate', `${run.task_id} (loop run ${run.id})`));
      }
    });
}
