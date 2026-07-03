import { childLogger } from '../logger.js';
import { buildDeepReviewPrompt } from '../review-tasks.js';
import { addAgent } from '../task-engine/index.js';
import { listWalkthroughHandoffTasks } from '../repositories/tasks.js';
import { claimDeepReviewAttach } from '../repositories/review-runs.js';
import type { Task } from '../types.js';

const logger = childLogger('poller');

export async function attachDeepReviewAgent(task: Task): Promise<void> {
  const changes = claimDeepReviewAttach(task.id);
  if (changes !== 1) {
    return;
  }
  const prompt = buildDeepReviewPrompt({ reviewTaskId: task.id });
  await addAgent(task, { prompt });
  logger.info(
    { task_id: task.id, operation: 'attachDeepReviewAgent' },
    'deep-review agent attached',
  );
}

export async function pollWalkthroughHandoffs(): Promise<void> {
  const rows = listWalkthroughHandoffTasks();
  for (const task of rows) {
    try {
      await attachDeepReviewAgent(task);
    } catch (err) {
      logger.error(
        { err, task_id: task.id, operation: 'pollWalkthroughHandoffs' },
        'handoff failed',
      );
    }
  }
}
