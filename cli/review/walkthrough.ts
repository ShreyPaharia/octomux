import fs from 'fs';
import { parseArgs } from 'node:util';
import { getDb } from '../../server/db.js';
import { getCurrentRun, setWalkthrough } from '../../server/review-runs.js';
import { listChangedFiles } from '../../server/diff.js';
import { validateWalkthrough, appendOrphansGroup } from '../../server/walkthrough.js';
import { SELECT_TASK_SQL } from '../../server/task-select.js';
import type { Task, Walkthrough } from '../../server/types.js';

export async function runWalkthrough(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    options: {
      task: { type: 'string' },
      'json-file': { type: 'string' },
    },
  });
  if (!values.task) {
    process.stderr.write('--task is required\n');
    process.exit(2);
  }
  if (!values['json-file']) {
    process.stderr.write('--json-file is required\n');
    process.exit(2);
  }

  const taskId = values.task as string;
  const jsonPath = values['json-file'] as string;

  const db = getDb();
  const task = db.prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(taskId) as Task | undefined;
  if (!task || !task.worktree || !task.pr_head_sha || !task.base_sha) {
    process.stderr.write(`task ${taskId} is not ready for walkthrough ingest\n`);
    process.exit(2);
  }

  const run = getCurrentRun(taskId);
  if (!run) {
    process.stderr.write(`no current review_run for task ${taskId}\n`);
    process.exit(2);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(jsonPath, 'utf-8');
  } catch (err) {
    process.stderr.write(`could not read ${jsonPath}: ${(err as Error).message}\n`);
    process.exit(2);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`invalid JSON in ${jsonPath}: ${(err as Error).message}\n`);
    process.exit(2);
  }

  const diffFiles = await listChangedFiles({
    worktree: task.worktree,
    base: task.base_sha,
    head: task.pr_head_sha,
  });

  const result = validateWalkthrough(parsed, diffFiles);
  if (!result.ok) {
    for (const e of result.errors) process.stderr.write(`${e}\n`);
    process.exit(2);
  }

  const walkthrough = appendOrphansGroup(parsed as Walkthrough, result.orphans);
  if (result.orphans.length > 0) {
    process.stderr.write(
      `auto-appended ${result.orphans.length} orphan file(s) to "Other changes": ${result.orphans.join(', ')}\n`,
    );
  }

  setWalkthrough(run.id, JSON.stringify(walkthrough));
  process.stdout.write(
    JSON.stringify({ ok: true, run_id: run.id, orphans: result.orphans }) + '\n',
  );
}
