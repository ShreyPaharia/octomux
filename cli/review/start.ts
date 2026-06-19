import { parseArgs } from 'node:util';
import { getDb } from '../../server/db.js';
import { createReviewRun, getCurrentRun } from '../../server/review-runs.js';
import { getLatestPublishedReview } from '../../server/published-reviews.js';
import { listLearningsForRepo } from '../../server/review-learnings.js';
import { findInstructionFiles } from '../../server/instruction-files.js';
import { markStaleDrafts } from '../../server/review-staleness.js';
import { readPlaybook } from '../../server/review-playbook.js';
import { SELECT_TASK_SQL } from '../../server/task-select.js';
import type { Task } from '../../server/types.js';
import type { InlineCommentRow } from '../../server/inline-comments.js';

type PreviousComment = Pick<
  InlineCommentRow,
  'id' | 'file_path' | 'line' | 'side' | 'body' | 'severity' | 'bucket' | 'kind'
>;

interface PreviousReview {
  head_sha: string;
  verdict: string;
  walkthrough: unknown | null;
  comments: PreviousComment[];
}

export async function runStart(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    options: { task: { type: 'string' } },
  });
  if (!values.task) {
    process.stderr.write('--task is required\n');
    process.exit(2);
  }
  const taskId = values.task as string;

  const db = getDb();
  const task = db.prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(taskId) as Task | undefined;
  if (!task) {
    process.stderr.write(`task not found: ${taskId}\n`);
    process.exit(2);
  }
  if (task.source !== 'auto_review') {
    process.stderr.write(
      `task ${taskId} is not a review task (source=${task.source ?? 'null'}). ` +
        `--task must be the review task id from your prompt's "Review task id:" line, ` +
        `not the source task being reviewed.\n`,
    );
    process.exit(2);
  }
  if (!task.pr_head_sha) {
    process.stderr.write(`task ${taskId} has no pr_head_sha\n`);
    process.exit(2);
  }

  // Run staleness against the new head before starting/locating a run, so
  // drafts from prior heads get flipped to 'stale' first.
  await markStaleDrafts(taskId, task.pr_head_sha);

  let run = getCurrentRun(taskId);
  if (!run || run.pr_head_sha !== task.pr_head_sha) {
    run = createReviewRun({ task_id: taskId, pr_head_sha: task.pr_head_sha });
  } else if (run.status !== 'running') {
    // Re-review of the same head. review_runs is UNIQUE(task_id, pr_head_sha) so
    // we can't create a second run — reset this one in place: clear the ingested
    // walkthrough and the handoff flag so the walkthrough re-ingests and the
    // poller re-attaches the deep-review agent (otherwise deep_review_attached
    // stays 1 and the deep phase never re-runs).
    getDb()
      .prepare(
        `UPDATE review_runs
            SET status = 'running', deep_review_attached = 0,
                walkthrough = NULL, completed_at = NULL, error = NULL
          WHERE id = ?`,
      )
      .run(run.id);
    run = getCurrentRun(taskId) as typeof run;
  }

  const prev = getLatestPublishedReview(taskId);
  let previous_review: PreviousReview | null = null;
  if (prev) {
    const prevRunWalkthrough =
      (
        db
          .prepare(
            `SELECT walkthrough FROM review_runs WHERE task_id = ? AND pr_head_sha = ?
             ORDER BY started_at DESC, id DESC LIMIT 1`,
          )
          .get(taskId, prev.head_sha) as { walkthrough: string | null } | undefined
      )?.walkthrough ?? null;
    const comments = db
      .prepare(
        `SELECT id, file_path, line, side, body, severity, bucket, kind
           FROM inline_comments
          WHERE published_review_id = ?
          ORDER BY file_path, line`,
      )
      .all(prev.id) as PreviousComment[];
    previous_review = {
      head_sha: prev.head_sha,
      verdict: prev.verdict,
      walkthrough: prevRunWalkthrough ? safeParse(prevRunWalkthrough) : null,
      comments,
    };
  }

  const repoPath = task.repo_path ?? '';
  const learnings = repoPath ? listLearningsForRepo(repoPath) : [];
  const instruction_files = task.worktree ? findInstructionFiles(task.worktree) : [];
  const playbook = repoPath ? readPlaybook(repoPath) : { index: null, files: [] };
  const walkthrough = run.walkthrough ? safeParse(run.walkthrough) : null;

  const carry_forward = db
    .prepare(
      `SELECT id, file_path, line, status FROM inline_comments
        WHERE task_id = ? AND status IN ('draft', 'accepted', 'stale')
              AND (review_run_id != ? OR review_run_id IS NULL)
        ORDER BY file_path, line`,
    )
    .all(taskId, run.id) as Array<{ id: string; file_path: string; line: number; status: string }>;

  process.stdout.write(
    JSON.stringify(
      {
        review_run_id: run.id,
        pr_head_sha: task.pr_head_sha,
        base_sha: task.base_sha ?? null,
        pr_url: task.pr_url ?? null,
        worktree: task.worktree ?? null,
        previous_review,
        learnings: learnings.map((l) => ({ id: l.id, why: l.why })),
        instruction_files,
        carry_forward,
        playbook,
        walkthrough,
      },
      null,
      2,
    ),
  );
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
