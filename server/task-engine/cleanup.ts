import { childLogger } from '../logger.js';
import { sessionFor, releaseSession } from '../compute/index.js';
import type { Task, Worker } from '../types.js';
import {
  setRuntimeState,
  stopAllAgents,
  softDeleteTask as softDeleteTaskRepo,
  stopRunningAgentsForTask,
  stopAgent as stopAgentRepo,
  deleteUserTerminalsByTask,
  unlinkWorktree,
  releaseWorktree,
  deleteWorktree,
} from '../repositories/index.js';
import {
  resolveTaskPermissionPrompts,
  resolveAgentPermissionPrompts,
} from '../repositories/permission-prompts.js';
import { getHarness } from '../harnesses/index.js';
import { isTmuxTargetMissing } from './sessions.js';
import { scratchDirFor } from './reconcile.js';
import { cleanupLinkedSessions } from './sessions.js';

const logger = childLogger('task-engine/cleanup');

export interface CloseReport {
  /** task.runtime_state was already 'idle' when closeTask was entered. */
  alreadyIdle: boolean;
  /** A tmux session existed and kill-session actually succeeded. */
  tmuxKilled: boolean;
}

export async function closeTask(task: Task): Promise<CloseReport> {
  const alreadyIdle = task.runtime_state === 'idle';

  logger.info(
    { task_id: task.id, operation: 'closeTask', run_mode: task.run_mode },
    'closeTask: start',
  );

  resolveTaskPermissionPrompts(task.id);
  deleteUserTerminalsByTask(task.id);
  setRuntimeState(task.id, 'idle');
  stopAllAgents(task.id);
  // Release the worktree so Phase 2b Workspaces can show it as available.
  if (task.worktree_id) {
    releaseWorktree(task.worktree_id);
  }
  logger.info(
    { task_id: task.id, operation: 'closeTask' },
    'closeTask: DB marked task closed + agents stopped',
  );

  const compute = await sessionFor(task);

  let tmuxKilled = false;
  if (task.tmux_session) {
    await cleanupLinkedSessions(compute, task.tmux_session);
    try {
      await compute.tmux(['kill-session', '-t', task.tmux_session]);
      tmuxKilled = true;
      logger.info(
        { task_id: task.id, operation: 'closeTask', tmux_session: task.tmux_session },
        'closeTask: tmux session killed',
      );
    } catch (err) {
      if (isTmuxTargetMissing(err)) {
        logger.debug(
          { task_id: task.id, operation: 'closeTask', tmux_session: task.tmux_session },
          'closeTask: tmux session already gone',
        );
      } else {
        logger.warn(
          { task_id: task.id, operation: 'closeTask', tmux_session: task.tmux_session, err },
          'closeTask: tmux kill-session failed',
        );
      }
    }
  }

  // No `destroy` — closeTask preserves the worktree (and, for a remote
  // provider, the compute itself) so a later resume can re-attach. Only
  // `deleteTask` tears the box down; here we just drop octomux's in-process
  // handle on it.
  await releaseSession(task.id);

  logger.info(
    {
      task_id: task.id,
      operation: 'closeTask',
      already_idle: alreadyIdle,
      tmux_killed: tmuxKilled,
    },
    'closeTask: complete',
  );

  return { alreadyIdle, tmuxKilled };
}

/**
 * Soft-delete a task: kill tmux + flag for the purge poller. Keeps worktree,
 * branch, and all DB rows so the user can restore from the trash column
 * within the grace window. The purge poller calls `deleteTask` on rows past
 * grace.
 */
export async function softDeleteTask(task: Task): Promise<void> {
  logger.info({ task_id: task.id, operation: 'softDeleteTask' }, 'softDeleteTask: start');

  const compute = await sessionFor(task);

  if (task.tmux_session) {
    await cleanupLinkedSessions(compute, task.tmux_session);
    try {
      await compute.tmux(['kill-session', '-t', task.tmux_session]);
    } catch (err) {
      if (!isTmuxTargetMissing(err)) {
        logger.warn(
          { task_id: task.id, tmux_session: task.tmux_session, err },
          'softDeleteTask: tmux kill-session failed',
        );
      }
    }
  }

  softDeleteTaskRepo(task.id);
  stopRunningAgentsForTask(task.id);

  logger.info({ task_id: task.id, operation: 'softDeleteTask' }, 'softDeleteTask: complete');
}

export interface TeardownReport {
  /** The worktree path is CONFIRMED gone (or there was nothing to remove). */
  worktreeRemoved: boolean;
  /** The branch is CONFIRMED gone (or there was none). */
  branchDeleted: boolean;
  /** Human-readable failures; empty when the teardown fully succeeded. */
  errors: string[];
}

/**
 * Tear down a task's worktree, branch, and tmux session, and DELETE its DB
 * rows. Never throws — `pollSoftDeletes` calls this from a purge loop and a
 * thrown error there would retry forever, so every failure is reported
 * instead via `TeardownReport.errors`.
 */
export async function deleteTask(task: Task): Promise<TeardownReport> {
  logger.info(
    { task_id: task.id, operation: 'deleteTask', run_mode: task.run_mode },
    'deleteTask: start',
  );

  const compute = await sessionFor(task);
  const errors: string[] = [];

  // Kill tmux first — applies to every mode
  if (task.tmux_session) {
    await cleanupLinkedSessions(compute, task.tmux_session);
    try {
      await compute.tmux(['kill-session', '-t', task.tmux_session]);
      logger.info(
        { task_id: task.id, operation: 'deleteTask', tmux_session: task.tmux_session },
        'deleteTask: tmux session killed',
      );
    } catch (err) {
      if (isTmuxTargetMissing(err)) {
        logger.debug(
          { task_id: task.id, operation: 'deleteTask', tmux_session: task.tmux_session },
          'deleteTask: tmux session already gone',
        );
      } else {
        logger.warn(
          { task_id: task.id, operation: 'deleteTask', tmux_session: task.tmux_session, err },
          'deleteTask: tmux kill-session failed',
        );
      }
    }
  }

  let worktreeRemoved = true;
  let branchDeleted = true;

  switch (task.run_mode) {
    case 'new': {
      if (task.worktree) {
        let removeFailed = false;
        try {
          await compute.exec([
            'git',
            '-C',
            task.repo_path,
            'worktree',
            'remove',
            task.worktree,
            '--force',
          ]);
          logger.info(
            { task_id: task.id, operation: 'deleteTask', worktree: task.worktree },
            'deleteTask: worktree removed',
          );
        } catch (err) {
          removeFailed = true;
          logger.warn(
            { task_id: task.id, operation: 'deleteTask', worktree: task.worktree, err },
            'deleteTask: worktree remove failed (may already be gone, or a dangling registration)',
          );
        }

        const stillExists = await compute.files.exists(task.worktree);
        if (stillExists) {
          await compute.files.rm(task.worktree, { recursive: true }).catch(() => {});
          await compute
            .exec(['git', '-C', task.repo_path, 'worktree', 'prune'], { allowFailure: true })
            .catch(() => {});
        } else if (removeFailed) {
          // The directory was already gone but `worktree remove` still
          // errored — that's exactly the dangling-registration case: git
          // keeps the administrative entry and `git worktree list` keeps
          // showing it until pruned.
          await compute
            .exec(['git', '-C', task.repo_path, 'worktree', 'prune'], { allowFailure: true })
            .catch(() => {});
        }

        worktreeRemoved = !(await compute.files.exists(task.worktree));
        if (!worktreeRemoved) {
          const msg = `worktree ${task.worktree} could not be removed`;
          errors.push(msg);
          logger.error(
            { task_id: task.id, operation: 'deleteTask', worktree: task.worktree },
            'deleteTask: worktree still present after teardown',
          );
        }
      }
      if (task.branch) {
        try {
          await compute.exec(['git', '-C', task.repo_path, 'branch', '-D', task.branch]);
          logger.info(
            { task_id: task.id, operation: 'deleteTask', branch: task.branch },
            'deleteTask: branch deleted',
          );
        } catch (err) {
          logger.warn(
            { task_id: task.id, operation: 'deleteTask', branch: task.branch, err },
            'deleteTask: branch delete failed (may already be gone)',
          );
        }

        const verify = await compute.exec(
          [
            'git',
            '-C',
            task.repo_path,
            'rev-parse',
            '--verify',
            '--quiet',
            `refs/heads/${task.branch}`,
          ],
          { allowFailure: true },
        );
        branchDeleted = verify.exitCode !== 0;
        if (!branchDeleted) {
          const msg = `branch ${task.branch} still exists after delete`;
          errors.push(msg);
          logger.error(
            { task_id: task.id, operation: 'deleteTask', branch: task.branch },
            'deleteTask: branch still present after teardown',
          );
        }
      }
      break;
    }
    case 'existing':
    case 'none': {
      // The user's worktree/repo is never removed — but our hook wiring must
      // be, or it outlives the worker rows holding its token and every later
      // session in that directory 401s on every hook. (Two live tasks sharing
      // one path already clobber each other's token at install time, so there
      // is nothing extra to guard here.)
      const dir = task.worktree || task.repo_path;
      try {
        await getHarness(task.harness_id).uninstallHooks(dir, compute.files);
        logger.info(
          { task_id: task.id, operation: 'deleteTask', run_mode: task.run_mode, dir },
          'deleteTask: hook config removed from user-owned path',
        );
      } catch (err) {
        logger.warn(
          { task_id: task.id, operation: 'deleteTask', run_mode: task.run_mode, dir, err },
          'deleteTask: hook config removal failed',
        );
      }
      break;
    }
    case 'scratch': {
      const dir = task.worktree || scratchDirFor(task.id);
      try {
        await compute.files.rm(dir, { recursive: true });
        logger.info(
          { task_id: task.id, operation: 'deleteTask', scratch_dir: dir },
          'deleteTask: scratch dir removed',
        );
      } catch (err) {
        logger.warn(
          { task_id: task.id, operation: 'deleteTask', scratch_dir: dir, err },
          'deleteTask: scratch dir remove failed (may already be gone)',
        );
      }

      worktreeRemoved = !(await compute.files.exists(dir));
      if (!worktreeRemoved) {
        const msg = `scratch dir ${dir} could not be removed`;
        errors.push(msg);
        logger.error(
          { task_id: task.id, operation: 'deleteTask', scratch_dir: dir },
          'deleteTask: scratch dir still present after teardown',
        );
      }
      break;
    }
  }

  // Worktree row fate: `new`/`scratch` own the filesystem, so their row goes
  // away with the task. `existing`/`none` belong to the user — keep the row
  // so Phase 2b Workspaces still sees it.
  //
  // FK ordering: tasks.worktree_id references worktrees.id. Unlink the task
  // from the worktree row before deleting the row, else the FK check fires.
  const wtId = task.worktree_id;
  if (wtId) {
    unlinkWorktree(task.id);
    if (task.run_mode === 'new' || task.run_mode === 'scratch') {
      deleteWorktree(wtId);
    } else {
      releaseWorktree(wtId);
    }
  }

  // `destroy: true` — deleteTask is the full-teardown path, so a remote
  // provider must actually tear the box down here, not just drop the cache
  // entry (which would leak the remote compute forever).
  await releaseSession(task.id, { destroy: true });

  logger.info(
    {
      task_id: task.id,
      operation: 'deleteTask',
      worktree_removed: worktreeRemoved,
      branch_deleted: branchDeleted,
      errors,
    },
    'deleteTask: complete',
  );

  return { worktreeRemoved, branchDeleted, errors };
}

export async function stopAgent(task: Task, agent: Worker): Promise<void> {
  logger.info(
    {
      task_id: task.id,
      agent_id: agent.id,
      operation: 'stopAgent',
      window_index: agent.window_index,
    },
    'stopAgent: start',
  );

  resolveAgentPermissionPrompts(agent.id);

  const compute = await sessionFor(task);

  await compute
    .tmux(['kill-window', '-t', `${task.tmux_session}:${agent.window_index}`])
    .catch((err) => {
      if (isTmuxTargetMissing(err)) {
        logger.debug(
          { task_id: task.id, agent_id: agent.id, operation: 'stopAgent' },
          'stopAgent: tmux window already gone',
        );
      } else {
        logger.warn(
          { task_id: task.id, agent_id: agent.id, operation: 'stopAgent', err },
          'stopAgent: kill-window failed',
        );
      }
    });

  stopAgentRepo(agent.id);

  logger.info(
    { task_id: task.id, agent_id: agent.id, operation: 'stopAgent' },
    'stopAgent: complete',
  );
}
