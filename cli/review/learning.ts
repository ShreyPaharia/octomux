import { parseArgs } from 'node:util';
import { addLearning, touchLearning } from '../../server/review-learnings.js';

export async function runLearning(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === 'add') {
    const { values } = parseArgs({
      args: rest,
      strict: false,
      options: {
        'repo-path': { type: 'string' },
        why: { type: 'string' },
        'from-comment': { type: 'string' },
      },
    });
    if (!values['repo-path'] || !values.why) {
      process.stderr.write(`--repo-path and --why are required\n`);
      process.exit(2);
    }
    const row = addLearning({
      repo_path: values['repo-path'] as string,
      why: values.why as string,
      created_from_comment_id: (values['from-comment'] as string) ?? null,
    });
    process.stdout.write(JSON.stringify({ id: row.id }) + '\n');
    return;
  }
  if (sub === 'touch') {
    const { values } = parseArgs({
      args: rest,
      strict: false,
      options: { id: { type: 'string' } },
    });
    if (!values.id) {
      process.stderr.write(`--id is required\n`);
      process.exit(2);
    }
    touchLearning(values.id as string);
    process.stdout.write(JSON.stringify({ ok: true }) + '\n');
    return;
  }
  process.stderr.write(`unknown learning subcommand: ${sub}\n`);
  process.exit(2);
}
