import { createTask } from '../client.js';

export async function createTaskCommand(args: string[]): Promise<void> {
  let title = '';
  let description = '';
  let repoPath = '';
  let initialPrompt = '';
  let branch = '';
  let baseBranch = '';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--title':
        title = args[++i] || '';
        break;
      case '--description':
        description = args[++i] || '';
        break;
      case '--repo-path':
        repoPath = args[++i] || '';
        break;
      case '--initial-prompt':
        initialPrompt = args[++i] || '';
        break;
      case '--branch':
        branch = args[++i] || '';
        break;
      case '--base-branch':
        baseBranch = args[++i] || '';
        break;
    }
  }

  if (!title || !description || !repoPath) {
    console.error('Usage: octomux create-task --title "..." --description "..." --repo-path "..."');
    console.error('  [--initial-prompt "..."] [--branch "..."] [--base-branch "..."]');
    process.exit(1);
  }

  const task = await createTask({
    title,
    description,
    repo_path: repoPath,
    initial_prompt: initialPrompt || undefined,
    branch: branch || undefined,
    base_branch: baseBranch || undefined,
  });

  console.log(JSON.stringify(task, null, 2));
}
