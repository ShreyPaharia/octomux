import { parseArgs } from 'node:util';
import { addLearning, touchLearning } from '../../server/repositories/agent-learnings.js';

const REVIEW_LANE = 'review';

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
    const fromComment = (values['from-comment'] as string) || null;
    const row = addLearning({
      repo_path: values['repo-path'] as string,
      lane: REVIEW_LANE,
      trigger: 'PR review learning',
      lesson: values.why as string,
      evidence: fromComment ?? REVIEW_LANE,
      source_run_id: fromComment,
    });
    process.stdout.write(JSON.stringify({ id: row ? row.id : null, deduped: row === null }) + '\n');
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
