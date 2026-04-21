import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, label, success, colorStatus } from '../format.js';

export function registerCreateTask(program: Command): void {
  program
    .command('create-task')
    .description('Create a new agent task')
    .requiredOption('-t, --title <title>', 'task title')
    .requiredOption('-d, --description <desc>', 'task description')
    .requiredOption('-r, --repo-path <path>', 'repository path')
    .option('-p, --initial-prompt <prompt>', 'initial prompt for the agent')
    .option('-b, --branch <name>', 'branch name')
    .option('--base-branch <name>', 'base branch name')
    .option('--draft', 'create as draft without starting')
    .option('--no-worktree', 'run agent in the repo directory without creating a worktree')
    .action(async (opts, cmd) => {
      const { client, json } = getContext(cmd);

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
