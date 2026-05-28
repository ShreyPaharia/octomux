import { parseArgs } from 'node:util';
import { getDb } from '../../server/db.js';
import { addComment } from '../../server/inline-comments.js';
import type { InlineCommentRow } from '../../server/inline-comments.js';
import type { CommentSeverity } from '../../server/types.js';

const VALID = ['resolved', 'still_applies', 'partial', 'unclear'] as const;

export async function runCheckPrevious(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    options: {
      comment: { type: 'string' },
      status: { type: 'string' },
      note: { type: 'string' },
      'reflag-body': { type: 'string' },
    },
  });
  if (!values.comment || !values.status) {
    process.stderr.write(`--comment and --status are required\n`);
    process.exit(2);
  }
  if (!(VALID as readonly string[]).includes(values.status as string)) {
    process.stderr.write(`--status must be one of ${VALID.join(', ')}\n`);
    process.exit(2);
  }

  const db = getDb();
  const target = db.prepare(`SELECT * FROM inline_comments WHERE id = ?`).get(values.comment) as
    | InlineCommentRow
    | undefined;
  if (!target || target.status !== 'published') {
    process.stderr.write(`comment ${values.comment} is not a published row\n`);
    process.exit(2);
  }

  const run = db
    .prepare(
      `SELECT id FROM review_runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
    )
    .get(target.task_id) as { id: string } | undefined;
  if (!run) {
    process.stderr.write(`no running review_run for task ${target.task_id}\n`);
    process.exit(2);
  }

  db.prepare(
    `UPDATE inline_comments
        SET last_check_status = ?, last_check_run_id = ?
      WHERE id = ?`,
  ).run(values.status, run.id, values.comment);

  if (values.status === 'still_applies' && typeof values['reflag-body'] === 'string') {
    const task = db.prepare(`SELECT pr_head_sha FROM tasks WHERE id = ?`).get(target.task_id) as {
      pr_head_sha: string | null;
    };
    const headSha = task.pr_head_sha ?? target.original_commit_sha;
    addComment({
      task_id: target.task_id,
      file_path: target.file_path,
      line: target.line,
      side: target.side,
      original_commit_sha: headSha,
      body: values['reflag-body'] as string,
      kind: 'comment',
      severity: (target.severity ?? 'issue') as CommentSeverity,
      bucket: 'actionable',
      review_run_id: run.id,
      re_flag_of: target.id,
    });
  }

  process.stdout.write(JSON.stringify({ ok: true }) + '\n');
}
