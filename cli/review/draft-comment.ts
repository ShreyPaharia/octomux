import { parseArgs } from 'node:util';
import { getDb } from '../../server/db.js';
import { getCurrentRun } from '../../server/repositories/review-runs.js';
import { addComment } from '../../server/repositories/inline-comments.js';
import { showFileAtSha } from '../../server/diff.js';
import { SELECT_TASK_SQL } from '../../server/task-select.js';
import type { CommentBucket, CommentSeverity, Task } from '../../server/types.js';

export async function runDraftComment(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    options: {
      task: { type: 'string' },
      file: { type: 'string' },
      line: { type: 'string' },
      'start-line': { type: 'string' },
      side: { type: 'string' },
      severity: { type: 'string' },
      bucket: { type: 'string' },
      kind: { type: 'string', default: 'comment' },
      body: { type: 'string' },
      'existing-code': { type: 'string' },
      'suggested-code': { type: 'string' },
      'reflag-of': { type: 'string' },
    },
  });

  const required = ['task', 'file', 'line', 'side', 'severity', 'bucket', 'body'] as const;
  for (const k of required) {
    if (!values[k]) {
      process.stderr.write(`--${k} is required\n`);
      process.exit(2);
    }
  }
  if (!['new', 'old'].includes(values.side as string)) {
    process.stderr.write(`--side must be 'new' or 'old'\n`);
    process.exit(2);
  }
  if (!['nit', 'suggestion', 'issue', 'critical'].includes(values.severity as string)) {
    process.stderr.write(`--severity must be one of nit|suggestion|issue|critical\n`);
    process.exit(2);
  }
  if (!['actionable', 'informational'].includes(values.bucket as string)) {
    process.stderr.write(`--bucket must be 'actionable' or 'informational'\n`);
    process.exit(2);
  }
  const kind = values.kind as 'comment' | 'suggestion';
  if (!['comment', 'suggestion'].includes(kind)) {
    process.stderr.write(`--kind must be 'comment' or 'suggestion'\n`);
    process.exit(2);
  }

  const taskId = values.task as string;
  const line = Number(values.line);
  if (!Number.isInteger(line) || line < 1) {
    process.stderr.write(`--line must be a positive integer\n`);
    process.exit(2);
  }

  const db = getDb();
  const task = db.prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(taskId) as Task | undefined;
  if (!task || !task.worktree || !task.pr_head_sha) {
    process.stderr.write(`task ${taskId} is not ready\n`);
    process.exit(2);
  }

  const run = getCurrentRun(taskId);
  if (!run) {
    process.stderr.write(`no current review_run for task ${taskId}\n`);
    process.exit(2);
  }

  let content: string;
  try {
    content = await showFileAtSha({
      worktree: task.worktree,
      sha: task.pr_head_sha,
      relPath: values.file as string,
    });
  } catch {
    process.stderr.write(`file ${values.file} does not exist at sha ${task.pr_head_sha}\n`);
    process.exit(2);
  }
  const fileLines = content.split('\n');
  if (line > fileLines.length) {
    process.stderr.write(`line ${line} is out of range (file has ${fileLines.length} lines)\n`);
    process.exit(2);
  }

  if (kind === 'suggestion') {
    const existing = values['existing-code'];
    const suggested = values['suggested-code'];
    if (typeof existing !== 'string' || typeof suggested !== 'string') {
      process.stderr.write(
        `--existing-code and --suggested-code are required when --kind=suggestion\n`,
      );
      process.exit(2);
    }
    const startLine = values['start-line'] ? Number(values['start-line']) : line;
    if (!Number.isInteger(startLine) || startLine < 1 || startLine > line) {
      process.stderr.write(`--start-line must be a positive integer <= --line\n`);
      process.exit(2);
    }
    const expectedSlice = fileLines.slice(startLine - 1, line).join('\n');
    if (expectedSlice !== existing) {
      process.stderr.write(
        `existing_code mismatch at ${values.file}:${startLine}-${line}\n` +
          diffLikeHint(expectedSlice, existing) +
          '\n',
      );
      process.exit(2);
    }
    const suggestionRow = addComment({
      task_id: taskId,
      file_path: values.file as string,
      line,
      side: values.side as 'new' | 'old',
      original_commit_sha: task.pr_head_sha,
      body: values.body as string,
      kind: 'suggestion',
      severity: values.severity as CommentSeverity,
      bucket: values.bucket as CommentBucket,
      review_run_id: run.id,
      existing_code: existing,
      suggested_code: suggested,
      re_flag_of: (values['reflag-of'] as string) ?? null,
    });
    process.stdout.write(
      JSON.stringify({ id: suggestionRow.id, status: suggestionRow.status }) + '\n',
    );
    return;
  }

  const row = addComment({
    task_id: taskId,
    file_path: values.file as string,
    line,
    side: values.side as 'new' | 'old',
    original_commit_sha: task.pr_head_sha,
    body: values.body as string,
    kind,
    severity: values.severity as CommentSeverity,
    bucket: values.bucket as CommentBucket,
    review_run_id: run.id,
    re_flag_of: (values['reflag-of'] as string) ?? null,
  });

  process.stdout.write(JSON.stringify({ id: row.id, status: row.status }) + '\n');
}

function diffLikeHint(expected: string, actual: string): string {
  const e = expected.split('\n');
  const a = actual.split('\n');
  const out: string[] = [];
  const max = Math.max(e.length, a.length);
  for (let i = 0; i < max; i++) {
    if (e[i] === a[i]) {
      out.push(`  ${e[i] ?? ''}`);
    } else {
      if (e[i] !== undefined) out.push(`-${e[i]}`);
      if (a[i] !== undefined) out.push(`+${a[i]}`);
    }
  }
  return out.join('\n');
}
