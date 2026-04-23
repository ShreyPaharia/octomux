import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { Command } from 'commander';
import { getContext } from '../action.js';
import type { OctomuxClient, Task } from '../client.js';
import { outputJson, label, success, colorStatus } from '../format.js';

const execFileAsync = promisify(execFile);

export interface ForkResolution {
  baseBranch: string;
  repoPath: string;
  warnings: string[];
}

export async function resolveForkFrom(
  client: OctomuxClient,
  forkFromId: string,
  explicitRepoPath: string | undefined,
  git: (args: string[], cwd: string) => Promise<{ stdout: string }> = defaultGit,
): Promise<ForkResolution> {
  let source: Task;
  try {
    source = await client.getTask(forkFromId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot fork from ${forkFromId}: source not found (${msg})`);
  }

  const status = source.status;
  const runMode = source.run_mode ?? (source.no_worktree ? 'scratch' : 'new');

  if (runMode === 'scratch' || runMode === 'none') {
    throw new Error(
      `cannot fork from ${forkFromId}: source has no branch (status=${status}, run_mode=${runMode})`,
    );
  }
  if (status === 'draft') {
    throw new Error(
      `cannot fork from ${forkFromId}: source has no branch (status=${status}, run_mode=${runMode})`,
    );
  }

  const baseBranch = `agents/${forkFromId}`;
  const repoPath = explicitRepoPath ?? source.repo_path;

  const warnings: string[] = [];
  if (source.worktree) {
    try {
      const { stdout: dirty } = await git(['status', '--porcelain'], source.worktree);
      if (dirty.trim().length > 0) {
        let shortSha = '';
        try {
          const { stdout: sha } = await git(['rev-parse', '--short', 'HEAD'], source.worktree);
          shortSha = sha.trim();
        } catch {
          shortSha = 'unknown';
        }
        warnings.push(
          `Source task ${forkFromId} has uncommitted changes; fork starts from last commit ${shortSha}. Those changes will not be in the fork.`,
        );
      }
    } catch {
      // Worktree unreadable; skip cleanliness check silently.
    }
  }

  return { baseBranch, repoPath, warnings };
}

async function defaultGit(args: string[], cwd: string): Promise<{ stdout: string }> {
  return execFileAsync('git', ['-C', cwd, ...args]);
}

export function registerCreateTask(program: Command): void {
  program
    .command('create-task')
    .description('Create a new agent task')
    .requiredOption('-t, --title <title>', 'task title')
    .requiredOption('-d, --description <desc>', 'task description')
    .option('-r, --repo-path <path>', 'repository path (inherited from source when using --fork-from)')
    .option('-p, --initial-prompt <prompt>', 'initial prompt for the agent')
    .option('-b, --branch <name>', 'branch name')
    .option('--base-branch <name>', 'base branch name')
    .option('--fork-from <task-id>', 'fork from an existing task (sets base branch to agents/<id>)')
    .option('--draft', 'create as draft without starting')
    .option('--no-worktree', 'run agent in the repo directory without creating a worktree')
    .action(async (opts, cmd) => {
      const { client, json } = getContext(cmd);

      if (opts.forkFrom && opts.baseBranch) {
        throw new Error('--fork-from and --base-branch are mutually exclusive');
      }

      if (opts.forkFrom) {
        const fork = await resolveForkFrom(client, opts.forkFrom, opts.repoPath);
        opts.baseBranch = fork.baseBranch;
        opts.repoPath = fork.repoPath;
        for (const w of fork.warnings) {
          console.error(chalk.yellow('Warning:') + ' ' + w);
        }
      }

      if (!opts.repoPath) {
        throw new Error("required option '-r, --repo-path <path>' not specified");
      }

      // Auto-fill base branch from repo config if not specified
      if (!opts.baseBranch) {
        try {
          const config = await client.getRepoConfig(opts.repoPath);
          if (config.base_branch) {
            opts.baseBranch = config.base_branch;
          }
        } catch {
          // Non-critical: server may not be running or repo not configured
        }
      }

      const task = await client.createTask({
        title: opts.title,
        description: opts.description,
        repo_path: opts.repoPath,
        initial_prompt: opts.initialPrompt,
        branch: opts.branch,
        base_branch: opts.baseBranch,
        draft: opts.draft,
        no_worktree: opts.noWorktree,
      });

      if (json) {
        outputJson(task);
        return;
      }

      success(`Created task ${task.id}`);
      console.log(label('Title', task.title));
      console.log(label('Status', colorStatus(task.status)));
      console.log(label('Branch', task.branch));
      console.log(label('Repo', task.repo_path));
    });
}
