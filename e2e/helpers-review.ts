import { type Page, expect } from '@playwright/test';
import { execSync } from 'child_process';

const SERVER_URL = (process.env.OCTOMUX_URL || 'http://localhost:7777').replace(/\/$/, '');
const API = `${SERVER_URL}/api`;

export interface ReviewFixtureOpts {
  taskId?: string;
  runId?: string;
  prUrl?: string;
  prNumber?: number;
  /** Override walkthrough JSON string (must include valid `global` scalars for CLI). */
  walkthrough?: string;
  /** SHA that both pr_head_sha and original_commit_sha will be set to.
   *  Defaults to the git HEAD of the current worktree so that staleness
   *  checks resolve against real git objects. */
  prHeadSha?: string;
}

/**
 * Seeds a review task with a completed review run and two draft inline comments
 * by calling the test-only POST /api/__test__/seed-review endpoint.
 *
 * Comments use real file paths that exist at the current HEAD so that the
 * staleness check (`isAnchorOutdated`) resolves against actual git objects and
 * returns `false` (not stale), allowing the publish step to flip them to
 * `status='published'`.
 *
 * Returns the seeded task_id.
 */
export async function createReviewFixture(
  page: Page,
  opts: ReviewFixtureOpts = {},
): Promise<string> {
  const taskId = opts.taskId ?? `e2e-review-${Date.now()}`;
  const runId = opts.runId ?? `e2e-run-${Date.now()}`;
  const prUrl = opts.prUrl ?? 'https://github.com/octomux/demo/pull/99';
  const prNumber = opts.prNumber ?? 99;

  // Use the actual git HEAD SHA so that `git show <sha>:<real-file>` resolves.
  const prHeadSha =
    opts.prHeadSha ??
    (() => {
      try {
        return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
      } catch {
        return 'sha-e2e-test';
      }
    })();

  const walkthrough =
    opts.walkthrough ??
    JSON.stringify({
      global: {
        type: 'Other',
        risk: 'low',
        effort: 1,
        relevant_tests: 'no',
        security_concerns: null,
        ticket_compliance: [],
        summary: 'E2E test review',
        key_review_points: [],
      },
      groups: [],
    });

  const res = await page.request.post(`${API}/__test__/seed-review`, {
    data: {
      task: {
        id: taskId,
        title: `E2E review PR #${prNumber}`,
        pr_url: prUrl,
        pr_number: prNumber,
        pr_head_sha: prHeadSha,
      },
      review_run: {
        id: runId,
        walkthrough,
      },
      comments: [
        {
          id: `${taskId}-c1`,
          // Real files at HEAD: staleness check returns false (not stale).
          file_path: 'server/github-client.ts',
          line: 1,
          side: 'new',
          body: 'This looks like a potential null-dereference.',
          kind: 'comment',
          severity: 'issue',
          bucket: 'actionable',
        },
        {
          id: `${taskId}-c2`,
          file_path: 'server/publish-review.ts',
          line: 1,
          side: 'new',
          body: 'Consider using a const here.',
          kind: 'suggestion',
          severity: 'nit',
          bucket: 'actionable',
          existing_code: 'let x = 1;',
          suggested_code: 'const x = 1;',
        },
      ],
    },
  });

  expect(res.ok(), `seed-review failed: ${await res.text()}`).toBeTruthy();
  const data = await res.json();
  expect(data.task_id).toBe(taskId);

  return taskId;
}

/** Delete a review task (and all its DB rows via cascade). */
export async function deleteReviewTask(page: Page, taskId: string): Promise<void> {
  // DELETE /api/tasks/:id calls deleteTask which attempts git cleanup.
  // The seed endpoint sets repo_path='/tmp/e2e-norepo' so git operations
  // fail gracefully without touching the server's working directory.
  await page.request.delete(`${API}/tasks/${taskId}`);
}
