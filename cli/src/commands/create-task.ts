import { Command } from 'commander';
import { getContext } from '../action.js';
import type { RunMode } from '../client.js';
import { outputJson, label, success, colorStatus } from '../format.js';

const VALID_MODES: readonly RunMode[] = ['new', 'existing', 'none', 'scratch'] as const;

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
    .option(
      '--mode <mode>',
      `run mode: ${VALID_MODES.join(' | ')} (default: new)`,
      'new',
    )
    .option('--worktree-path <path>', 'existing worktree path (required for existing mode)')
    .option('--draft', 'create as draft without starting')
    .action(async (opts, cmd) => {
      const { client, json } = getContext(cmd);

      const mode = opts.mode as RunMode;
      if (!VALID_MODES.includes(mode)) {
        cmd.error(`--mode must be one of: ${VALID_MODES.join(', ')}`);
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
