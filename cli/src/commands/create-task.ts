import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { Command } from 'commander';
import { getContext } from '../action.js';
import type { OctomuxClient, RunMode, Task } from '../client.js';
import { outputJson, label, success, colorStatus } from '../format.js';

const execFileAsync = promisify(execFile);

const VALID_MODES: readonly RunMode[] = ['new', 'existing', 'none', 'scratch'] as const;

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
  const runMode = source.run_mode ?? 'new';

  if (runMode === 'scratch' || runMode === 'none' || runMode === 'existing') {
    throw new Error(
      `cannot fork from ${forkFromId}: source has no managed branch (status=${status}, run_mode=${runMode})`,
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
    .option('-r, --repo-path <path>', 'repository path (required for new/none)')
    .option('-p, --initial-prompt <prompt>', 'initial prompt for the agent')
    .option('-b, --branch <name>', 'branch name (new mode only)')
    .option('--base-branch <name>', 'base branch name (new mode only)')
    .option('--mode <mode>', `run mode: ${VALID_MODES.join(' | ')} (default: new)`, 'new')
    .option('--worktree-path <path>', 'existing worktree path (required for existing mode)')
    .option(
      '--fork-from <task-id>',
      'fork from an existing new-mode task (sets base_branch to agents/<id>)',
    )
    .option('--draft', 'create as draft without starting')
    .option(
      '--harness <id>',
      'coding agent (harness id): claude-code | cursor (default: server setting)',
    )
    .option('--model <id>', 'per-task model override (e.g. claude-opus-4-8, claude-sonnet-4-6)')
    .action(async (opts, cmd) => {
      const { client, json } = getContext(cmd);

      const mode = opts.mode as RunMode;
      if (!VALID_MODES.includes(mode)) {
        cmd.error(`--mode must be one of: ${VALID_MODES.join(', ')}`);
      }

      // --fork-from is only meaningful for new mode — it derives base_branch.
      if (opts.forkFrom) {
        if (mode !== 'new') cmd.error('--fork-from is only valid with --mode=new');
        if (opts.baseBranch) cmd.error('--fork-from and --base-branch are mutually exclusive');
        const fork = await resolveForkFrom(client, opts.forkFrom, opts.repoPath);
        opts.baseBranch = fork.baseBranch;
        opts.repoPath = fork.repoPath;
        for (const w of fork.warnings) {
          console.error(chalk.yellow('Warning:') + ' ' + w);
        }
      }

      // Mode-specific field validation
      if (mode === 'existing') {
        if (!opts.worktreePath) cmd.error('--worktree-path is required for --mode=existing');
        if (opts.baseBranch) cmd.error('--base-branch is not allowed for --mode=existing');
      }
      if (mode === 'none') {
        if (!opts.repoPath) cmd.error('--repo-path is required for --mode=none');
        if (opts.baseBranch) cmd.error('--base-branch is not allowed for --mode=none');
        if (opts.branch) cmd.error('--branch is not allowed for --mode=none');
        if (opts.worktreePath) cmd.error('--worktree-path is not allowed for --mode=none');
      }
      if (mode === 'scratch') {
        if (opts.repoPath) cmd.error('--repo-path is not allowed for --mode=scratch');
        if (opts.baseBranch) cmd.error('--base-branch is not allowed for --mode=scratch');
        if (opts.branch) cmd.error('--branch is not allowed for --mode=scratch');
        if (opts.worktreePath) cmd.error('--worktree-path is not allowed for --mode=scratch');
      }
      if (mode === 'new' && !opts.repoPath) {
        cmd.error('--repo-path is required for --mode=new');
      }

      // Auto-fill base branch from repo config (new mode only)
      if (mode === 'new' && !opts.baseBranch && opts.repoPath) {
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
        run_mode: mode,
        worktree_path: opts.worktreePath,
        ...(opts.harness ? { harness_id: opts.harness } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      });

      if (json) {
        outputJson(task);
        return;
      }

      success(`Created task ${task.id}`);
      console.log(label('Title', task.title));
      console.log(label('Mode', mode));
      console.log(label('Status', colorStatus(task.status)));
      console.log(label('Branch', task.branch));
      console.log(label('Repo', task.repo_path));
    });
}
