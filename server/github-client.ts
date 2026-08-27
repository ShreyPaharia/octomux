import { spawn, execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { childLogger } from './logger.js';

const logger = childLogger('github-client');
const execFile = promisify(execFileCb);

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

  logger.info({ owner, repo, pull_number, review_id: result.id }, 'pull request review posted');

  return { id: result.id, html_url: result.html_url };
}

export interface PostedReviewComment {
  id: number;
  path: string;
  body: string;
}

/**
 * Comments created by a specific review — used to backfill github_comment_id
 * right after publishReview posts (the batch create response carries no
 * per-comment ids).
 */
export async function listReviewComments(input: {
  owner: string;
  repo: string;
  pull_number: number;
  review_id: number;
}): Promise<PostedReviewComment[]> {
  const { stdout } = await execFile('gh', [
    'api',
    `/repos/${input.owner}/${input.repo}/pulls/${input.pull_number}/reviews/${input.review_id}/comments?per_page=100`,
  ]);
  const raw = JSON.parse(stdout.trim() || '[]') as Array<{
    id: number;
    path: string;
    body: string;
  }>;
  return raw.map((c) => ({ id: c.id, path: c.path, body: c.body }));
}

/** Reply in an existing PR review-comment thread. */
export async function replyToReviewComment(input: {
  owner: string;
  repo: string;
  pull_number: number;
  comment_id: number;
  body: string;
}): Promise<void> {
  await execFile('gh', [
    'api',
    '--method',
    'POST',
    `/repos/${input.owner}/${input.repo}/pulls/${input.pull_number}/comments/${input.comment_id}/replies`,
    '-f',
    `body=${input.body}`,
  ]);
  logger.info(
    {
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pull_number,
      comment_id: input.comment_id,
    },
    'replied to review comment thread',
  );
}

export interface InboundReviewComment {
  id: string;
  body: string;
  path?: string;
}

/**
 * Fetches inbound (human reviewer) review comments for a PR via `gh api`.
 * Uses `gh`'s `{owner}/{repo}` template placeholders, resolved from the repo
 * checked out at `repoPath` (`cwd`) — no manual remote parsing needed.
 *
 * ponytail: single page (up to 100 comments), no --paginate — PR review
 * threads rarely exceed that; add pagination if a PR does.
 */
export async function fetchPrReviewComments(
  repoPath: string,
  prNumber: number,
): Promise<InboundReviewComment[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFile(
      'gh',
      ['api', `repos/{owner}/{repo}/pulls/${prNumber}/comments?per_page=100`],
      { cwd: repoPath },
    ));
  } catch (err) {
    logger.debug(
      { repoPath, prNumber, err: (err as Error).message },
      'gh api pulls/comments failed',
    );
    return [];
  }

  const raw = JSON.parse(stdout.trim() || '[]') as Array<{
    id: number;
    body: string;
    path?: string;
  }>;
  return raw.map((c) => ({ id: String(c.id), body: c.body, path: c.path }));
}
