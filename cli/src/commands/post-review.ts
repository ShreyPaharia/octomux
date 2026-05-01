import { Command, Option } from 'commander';
import { getContext } from '../action.js';
import { errorMessage, outputJson, success } from '../format.js';
import type { PostCommentInput } from '../client.js';

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function registerPostReview(program: Command): void {
  program
    .command('post-review')
    .description('Post an inline review comment on a file/line in a task worktree')
    .requiredOption('-t, --task <task-id>', 'task ID')
    .requiredOption('-f, --file <path>', 'file path relative to worktree root')
    .requiredOption('-l, --line <n>', 'line number (1-based)', (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error('--line must be a positive integer');
      }
      return n;
    })
    .requiredOption('-b, --body <text>', "comment body, or '-' to read from stdin")
    .addOption(new Option('-s, --side <side>', 'diff side').choices(['old', 'new']).default('new'))
    .option('-a, --agent <agent-id>', 'agent ID (falls back to OCTOMUX_AGENT_ID)')
    .option('-c, --commit <sha>', 'anchor commit SHA (defaults to worktree HEAD)')
    .action(async (opts, cmd) => {
      const { client, json } = getContext(cmd);

      let body = opts.body as string;
      if (body === '-') {
        body = await readStdin(process.stdin);
      }
      if (!body.trim()) {
        errorMessage('body is empty');
        process.exit(1);
      }

      const agentId = (opts.agent as string | undefined) ?? process.env.OCTOMUX_AGENT_ID;

      const payload: PostCommentInput = {
        file_path: opts.file,
        line: opts.line,
        side: opts.side,
        body,
      };
      if (agentId) payload.agent_id = agentId;
      if (opts.commit) payload.anchor_commit_sha = opts.commit;

      const row = await client.postComment(opts.task, payload);

      if (json) {
        outputJson(row);
        return;
      }
      success(`Posted comment ${row.id} on ${row.file_path}:${row.line}`);
    });
}
