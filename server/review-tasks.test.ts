import { describe, it, expect } from './bun-test.js';
import {
  buildPrReviewPrompt,
  buildManualReviewPrompt,
  buildDeepReviewPrompt,
  insertReviewTask,
} from './review-tasks.js';
import { createTestDb } from './test-helpers.js';

describe('buildPrReviewPrompt', () => {
  const input = {
    reviewTaskId: 'REVIEW123abc',
    title: 'Fix the thing',
    number: 42,
    url: 'https://github.com/o/r/pull/42',
    author: 'octocat',
    headRefOid: 'deadbeef',
    requestedAt: '2026-01-01T00:00:00Z',
  };

  it('instructs the review-artifact flow and closing the task by its own id', () => {
    const prompt = buildPrReviewPrompt(input);
    expect(prompt).toContain('Review task id: REVIEW123abc');
    expect(prompt).toContain('/review-artifact');
    expect(prompt).toContain('octomux close-task REVIEW123abc');
    expect(prompt).toContain('PR: Fix the thing (#42)');
    expect(prompt).not.toContain('review-walkthrough');
  });

  it('includes the Slack ping instruction only when the channel env is set', () => {
    const prev = process.env.OCTOMUX_REVIEW_SLACK_CHANNEL;
    try {
      delete process.env.OCTOMUX_REVIEW_SLACK_CHANNEL;
      expect(buildPrReviewPrompt(input)).not.toContain('chat.postMessage');

      process.env.OCTOMUX_REVIEW_SLACK_CHANNEL = 'C0TEST';
      const prompt = buildPrReviewPrompt(input);
      expect(prompt).toContain('chat.postMessage');
      expect(prompt).toContain('channel=C0TEST');
      expect(prompt).toContain('OCTOMUX_GATEWAY_SLACK_BOT_TOKEN');
    } finally {
      if (prev === undefined) delete process.env.OCTOMUX_REVIEW_SLACK_CHANNEL;
      else process.env.OCTOMUX_REVIEW_SLACK_CHANNEL = prev;
    }
  });
});

describe('buildManualReviewPrompt', () => {
  it('uses the review task id for --task, never the source task id', () => {
    const prompt = buildManualReviewPrompt({
      reviewTaskId: 'REVIEW123abc',
      sourceId: 'SOURCE999xyz',
      sourceTitle: 'BAC-6 cutover',
      repoShort: 'nucleus',
      branch: 'feature/x',
      baseBranch: 'main',
      baseSha: 'basesha',
      prHeadSha: 'headsha',
      requestedAt: '2026-01-01T00:00:00Z',
    });
    expect(prompt.startsWith('/octomux:review-walkthrough')).toBe(true);
    // The review task's own id is what the CLI must be invoked with.
    expect(prompt).toContain('Review task id: REVIEW123abc');
    expect(prompt).toMatch(/--task REVIEW123abc/);
    // The source id must remain available as context...
    expect(prompt).toContain('SOURCE999xyz');
    // ...but must NOT be presented as the --task value (the original bug).
    expect(prompt).not.toMatch(/--task SOURCE999xyz/);
  });
});

it('manual prompt still invokes the walkthrough skill', () => {
  const manual = buildManualReviewPrompt({
    reviewTaskId: 'rt1',
    sourceId: 's1',
    sourceTitle: 'T',
    repoShort: 'r',
    branch: 'b',
    baseBranch: 'main',
    baseSha: 'bs',
    prHeadSha: 'h',
    requestedAt: 'now',
  });
  expect(manual).toContain('/octomux:review-walkthrough');
  expect(manual).not.toContain('/review-orchestrator');
});

it('buildDeepReviewPrompt invokes the deep skill and pins the task id', () => {
  const p = buildDeepReviewPrompt({ reviewTaskId: 'rt1' });
  expect(p).toContain('/octomux:review-deep');
  expect(p).toContain('Review task id: rt1');
  expect(p).toContain('--task rt1');
});

describe('insertReviewTask', () => {
  it('uses the caller-provided id when one is given', () => {
    createTestDb();
    const id = insertReviewTask({
      id: 'FIXEDID12345',
      repoPath: '/repos/foo',
      branch: 'review/foo-task-src1',
      baseBranch: 'main',
      baseSha: 'basesha',
      title: 'Review: thing',
      description: 'manual',
      initialPrompt: 'prompt',
      prUrl: null,
      prNumber: null,
      prHeadSha: 'headsha',
    });
    expect(id).toBe('FIXEDID12345');
  });

  it('generates an id when none is provided', () => {
    createTestDb();
    const id = insertReviewTask({
      repoPath: '/repos/foo',
      branch: 'review/foo-pr-1',
      baseBranch: 'main',
      title: 'Review: pr',
      description: 'auto',
      initialPrompt: 'prompt',
      prUrl: 'https://github.com/o/r/pull/1',
      prNumber: 1,
      prHeadSha: 'headsha',
    });
    expect(id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
  });
});
