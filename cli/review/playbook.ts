import { parseArgs } from 'node:util';
import { getDb } from '../../server/db.js';
import { readPlaybook, appendPlaybookNote } from '../../server/review-playbook.js';
import { SELECT_TASK_SQL } from '../../server/task-select.js';
import type { Task } from '../../server/types.js';

function resolveRepoPath(taskId: string): string {
  const task = getDb().prepare(`${SELECT_TASK_SQL} WHERE t.id = ?`).get(taskId) as Task | undefined;
  if (!task) {
    process.stderr.write(`task not found: ${taskId}\n`);
    process.exit(2);
  }
  if (!task.repo_path) {
    process.stderr.write(`task ${taskId} has no repo_path\n`);
    process.exit(2);
  }
  return task.repo_path;
}

export async function runPlaybook(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    strict: false,
    options: {
      task: { type: 'string' },
      topic: { type: 'string' },
      note: { type: 'string' },
    },
  });
  if (!values.task) {
    process.stderr.write('--task is required\n');
    process.exit(2);
  }
  const repoPath = resolveRepoPath(values.task as string);

  if (sub === 'show') {
    process.stdout.write(JSON.stringify(readPlaybook(repoPath), null, 2));
    return;
  }
  if (sub === 'add') {
    if (!values.topic || !values.note) {
      process.stderr.write('add requires --topic and --note\n');
      process.exit(2);
    }
    appendPlaybookNote(repoPath, values.topic as string, values.note as string);
    process.stdout.write(JSON.stringify({ ok: true, topic: values.topic }, null, 2));
    return;
  }
  process.stderr.write(`unknown playbook subcommand: ${sub ?? '(none)'}\n`);
  process.exit(2);
}
