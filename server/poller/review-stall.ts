import { childLogger } from '../logger.js';
import { execTmux } from '../tmux-bin.js';
import { sendMessageToAgent } from '../tmux-input.js';
import { countPendingByTask } from '../repositories/permission-prompts.js';
import { findFirstActiveAgent } from '../repositories/workers.js';
import { addTaskUpdate, listStalledAutoReviewTasks } from '../repositories/tasks.js';
import { REVIEW_STALL_AFTER_MS, REVIEW_STALL_MAX_NUDGES } from './intervals.js';

const logger = childLogger('poller/review-stall');

/** Claude Code's TUI shows this in the status bar only while a turn is in flight. */
const IN_FLIGHT_MARKER = 'esc to interrupt';

function stallNudge(taskId: string): string {
  return (
    'Automated stall check: no agent activity detected for a while — your last turn may have ' +
    'died on a dropped API stream. Continue the review flow from where you left off. If the ' +
    `review is already complete, close this task with \`octomux close-task ${taskId}\`.`
  );
}

/**
 * Nudge auto-review agents whose turn died mid-stream. The Claude CLI abandons
 * a turn on a stream error WITHOUT firing the Stop hook, so the worker sits
 * 'active' with a stale hook_activity_updated_at while the TUI waits at an
 * idle prompt — invisible to the quiescence sweep, and the review never
 * finishes. Detect that shape and type a continue prompt into the session.
 *
 * A long tool-free turn (artifact synthesis) leaves the same stale-active DB
 * shape, so the pane is checked for the in-flight marker before nudging;
 * capture failure nudges anyway (a queued message in a live TUI is harmless —
 * it just becomes the next user message). Bounded by REVIEW_STALL_MAX_NUDGES
 * per task, recorded as task_updates notes.
 */
export async function pollReviewStalls(): Promise<void> {
  for (const task of listStalledAutoReviewTasks(REVIEW_STALL_AFTER_MS, REVIEW_STALL_MAX_NUDGES)) {
    if (countPendingByTask(task.id) > 0) continue;

    const agent = findFirstActiveAgent(task.id);
    if (!agent) continue;

    try {
      const { stdout } = await execTmux([
        'capture-pane',
        '-p',
        '-t',
        `${task.tmux_session}:${agent.window_index}`,
      ]);
      if (stdout.includes(IN_FLIGHT_MARKER)) continue;
    } catch {
      // Pane capture failed — fall through and nudge; send failure is handled below.
    }

    try {
      await sendMessageToAgent(task.tmux_session, agent.window_index, stallNudge(task.id));
    } catch (err) {
      logger.warn(
        { task_id: task.id, agent_id: agent.id, err: (err as Error).message },
        'stall nudge failed (session may be gone)',
      );
      continue;
    }

    addTaskUpdate({ task_id: task.id, kind: 'note', body: 'auto: stall nudge' });
    logger.warn(
      { task_id: task.id, agent_id: agent.id, operation: 'review_stall_nudge' },
      'nudged stalled review agent',
    );
  }
}
