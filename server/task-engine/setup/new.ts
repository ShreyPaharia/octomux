import path from 'path';
import { childLogger } from '../../logger.js';
import { computeMergeBase } from '../../git-commits.js';
import { validateRepo, revParseHead, addWorktreeWithBranch, slugifyTitle } from '../git.js';
import { writeAgentLocalSettings, DISABLED_PLUGINS_IN_WORKTREES } from '../launch.js';
import type { ComputeSession } from '../../compute/types.js';
import type { Task } from '../../types.js';
import type { SetupResult } from './types.js';

const logger = childLogger('task-engine/setup/new');

export async function setupNew(c: ComputeSession, task: Task): Promise<SetupResult> {
  await validateRepo(c, c.repoPath);

  const slug = slugifyTitle(task.title, task.id);
  const branch = task.branch || `agents/${slug}`;
  const worktreeDir = task.branch || slug;
  const worktreePath = path.join(c.repoPath, '.worktrees', worktreeDir);

  const worktreeBaseDir = path.join(c.repoPath, '.worktrees');
  await c.files.mkdirp(worktreeBaseDir);

  // `worktree add -b <branch>` creates a NEW branch and fails if it already
  // exists (e.g. left over from a prior task — octomux preserves branches on
  // close). If the branch exists and isn't checked out elsewhere, check it out
  // into the new worktree instead; otherwise fall back to a unique branch name
  // so task creation never dies on a name collision.
  const finalBranch = await addWorktreeWithBranch(
    c,
    c.repoPath,
    worktreePath,
    branch,
    task.base_branch,
  );

  // For review tasks, move HEAD to pr_head_sha so the diff UI and merge-base
  // see the PR's actual commit. Auto-review tasks need a fetch first (the SHA
  // may not be a local object yet); manual-review tasks reuse the source
  // task's local HEAD and skip the fetch. Failures here are logged but never
  // abort setup — the agent can recover even with an empty diff.
  if (task.source === 'auto_review' && task.pr_head_sha) {
    if (task.pr_number) {
      try {
        await c.exec(['git', '-C', c.repoPath, 'fetch', 'origin', `pull/${task.pr_number}/head`]);
      } catch (err) {
        logger.warn(
          { task_id: task.id, operation: 'createTask', err },
          'createTask: failed to fetch PR head; review may show no files',
        );
      }
    }
    try {
      await c.exec(['git', '-C', worktreePath, 'reset', '--hard', task.pr_head_sha]);
    } catch (err) {
      logger.warn(
        { task_id: task.id, operation: 'createTask', err },
        'createTask: failed to reset worktree to pr_head_sha; leaving at base-branch tip',
      );
    }
  }

  const baseRef = task.base_branch || 'HEAD';
  let baseSha: string;
  if (task.source === 'auto_review' && task.pr_head_sha && task.base_branch) {
    try {
      baseSha = await computeMergeBase(c.repoPath, task.base_branch, task.pr_head_sha);
    } catch (err) {
      logger.warn(
        { task_id: task.id, operation: 'createTask', err },
        'createTask: git merge-base failed, falling back to rev-parse',
      );
      baseSha = await revParseHead(c, c.repoPath, baseRef);
    }
  } else {
    baseSha = await revParseHead(c, c.repoPath, baseRef);
  }

  // Copy .claude/settings.local.json if it exists
  const settingsSrc = path.join(c.repoPath, '.claude', 'settings.local.json');
  const settingsDst = path.join(worktreePath, '.claude', 'settings.local.json');
  if (await c.files.exists(settingsSrc)) {
    await c.files.mkdirp(path.dirname(settingsDst));
    await c.files.copy(settingsSrc, settingsDst);
  }

  await writeAgentLocalSettings(c, worktreePath);
  logger.info(
    {
      task_id: task.id,
      operation: 'createTask',
      settings_path: settingsDst,
      disabled_plugins: DISABLED_PLUGINS_IN_WORKTREES.length,
    },
    'createTask: wrote agent-local settings',
  );

  return {
    worktreePath,
    branch: finalBranch,
    baseBranch: task.base_branch,
    baseSha,
    installHooksAt: worktreePath,
  };
}
