/**
 * Comment-observing trigger for `prod_log_triage` tasks: for each running
 * triage task with an open PR, ingest any new inbound review comments into
 * that loop's playbook. NOT `merged-pr.ts` — this fires on comments, not
 * merge, and there is no other existing poller that observes inbound PR
 * review comments.
 */
import { childLogger } from '../logger.js';
import { listRunningTasksWithPr } from '../repositories/tasks.js';
import { ingestReviewComments } from '../services/comment-feedback.js';

const logger = childLogger('poller');

export async function checkTriagePrComments(): Promise<void> {
  const tasks = listRunningTasksWithPr().filter((task) => task.source === 'prod_log_triage');

  for (const task of tasks) {
    if (!task.repo_path || task.pr_number == null) continue;
    try {
      const count = await ingestReviewComments({
        repoPath: task.repo_path,
        prNumber: task.pr_number,
      });
      if (count > 0) {
        logger.info(
          { task_id: task.id, pr_number: task.pr_number, count },
          'ingested triage PR review comments into loop playbook',
        );
      }
    } catch (err) {
      logger.error(
        { task_id: task.id, pr_number: task.pr_number, err: (err as Error).message },
        'failed to ingest triage PR review comments',
      );
    }
  }
}

export async function pollTriagePrComments(): Promise<void> {
  try {
    await checkTriagePrComments();
  } catch (err) {
    logger.error({ err, operation: 'pollTriagePrComments' }, 'pollTriagePrComments failed');
  }
}
