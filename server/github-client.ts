import { spawn } from 'child_process';
import { childLogger } from './logger.js';

const logger = childLogger('github-client');

export interface PullRequestReviewComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
}

export interface PostPullRequestReviewInput {
  owner: string;
  repo: string;
  pull_number: number;
  commit_id: string;
  body: string;
  event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
  comments: PullRequestReviewComment[];
}

export interface PostPullRequestReviewResult {
  id: number;
  html_url: string;
}

/**
 * Posts a pull request review to GitHub using `gh api`.
 * Sends the JSON payload on stdin via `--input -`.
 *
 * Test-only stub: when NODE_ENV === 'test' AND the OCTOMUX_GH_STUB_RESPONSE env
 * var is set, returns the parsed JSON from that env var without invoking `gh`.
 */
export async function postPullRequestReview(
  input: PostPullRequestReviewInput,
): Promise<PostPullRequestReviewResult> {
  // ─── Test-only stub hatch ─────────────────────────────────────────────────
  if (process.env.NODE_ENV === 'test' && process.env.OCTOMUX_GH_STUB_RESPONSE) {
    logger.info({ event: input.event, comment_count: input.comments.length }, 'gh stub fired');
    return JSON.parse(process.env.OCTOMUX_GH_STUB_RESPONSE) as PostPullRequestReviewResult;
  }

  const { owner, repo, pull_number, ...payload } = input;
  const endpoint = `/repos/${owner}/${repo}/pulls/${pull_number}/reviews`;
  const body = JSON.stringify(payload);

  logger.info(
    { owner, repo, pull_number, event: input.event, comment_count: input.comments.length },
    'posting pull request review',
  );

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('gh', ['api', '--method', 'POST', endpoint, '--input', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`gh api exited with code ${code}: ${err}`));
      } else {
        resolve(out);
      }
    });
    child.on('error', reject);
    child.stdin.write(body);
    child.stdin.end();
  });

  const result = JSON.parse(stdout) as { id: number; html_url: string };

  logger.info(
    { owner, repo, pull_number, review_id: result.id },
    'pull request review posted',
  );

  return { id: result.id, html_url: result.html_url };
}
