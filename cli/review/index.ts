import { runStart } from './start.js';
import { runWalkthrough } from './walkthrough.js';
import { runDraftComment } from './draft-comment.js';
import { runCheckPrevious } from './check-previous.js';
import { runComplete } from './complete.js';
import { runLearning } from './learning.js';

const USAGE = `octomux review <subcommand> [options]

Subcommands:
  start          Print current run state + previous review + learnings (JSON).
  walkthrough    Ingest a Walkthrough JSON file onto the current run.
  draft-comment  File a draft inline comment (kind=comment) or suggestion (kind=suggestion).
  check-previous Record verify-previous result on a published comment.
  complete       Mark the current run completed; runs auto-resolve.
  learning       add | touch  - manage repo-scoped review learnings.

All subcommands require --task <id> except 'learning'.
`;

export async function runReview(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
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
