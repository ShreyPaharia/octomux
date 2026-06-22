import { runStart } from './start.js';
import { runWalkthrough } from './walkthrough.js';
import { runDraftComment } from './draft-comment.js';
import { runCheckPrevious } from './check-previous.js';
import { runComplete } from './complete.js';
import { runLearning } from './learning.js';
import { runPlaybook } from './playbook.js';
import { runCreate } from './create.js';

const USAGE = `octomux review <subcommand> [options]

Subcommands:
  create         Create an auto_review task for a GitHub PR URL.
  start          Print current run state + previous review + learnings (JSON).
  walkthrough    Ingest a Walkthrough JSON file onto the current run.
  draft-comment  File a draft inline comment (kind=comment) or suggestion (kind=suggestion).
  check-previous Record verify-previous result on a published comment.
  complete       Mark the current run completed; runs auto-resolve.
  learning       add | touch  - manage repo-scoped review learnings.
  playbook       show | add  - read/append the per-repo review playbook.

All subcommands require --task <id> except 'learning' and 'create'.
`;

export async function runReview(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'create':
      return runCreate(rest);
    case 'start':
      return runStart(rest);
    case 'walkthrough':
      return runWalkthrough(rest);
    case 'draft-comment':
      return runDraftComment(rest);
    case 'check-previous':
      return runCheckPrevious(rest);
    case 'complete':
      return runComplete(rest);
    case 'learning':
      return runLearning(rest);
    case 'playbook':
      return runPlaybook(rest);
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`unknown subcommand: ${sub}\n${USAGE}`);
      process.exit(2);
  }
}

// When invoked directly (via tsx), parse argv and dispatch.
const isMain = (() => {
  try {
    const fileUrl = new URL(import.meta.url);
    if (process.argv[1] && fileUrl.pathname === process.argv[1]) return true;
    if (process.argv[1] && fileUrl.pathname.endsWith(process.argv[1])) return true;
  } catch {
    /* ignore */
  }
  return false;
})();

if (isMain) {
  runReview(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  });
}
