import { registerWorkflow } from '../registry.js';
import { createReviewTaskFromPr } from './run.js';
import { router as reviewerRouter } from './routes.js';
import type { RunContext, WorkflowType } from '../types.js';

export interface ReviewerRequestEvent {
  pr_number: number;
  pr_url: string;
  pr_head_sha: string;
  base_branch: string;
  title: string;
  author: string | null;
  requested_at: string;
}

export const reviewerWorkflow: WorkflowType = {
  kind: 'reviewer',
  displayName: 'PR Reviewer',
  surfaces: ['feed', 'artifact'],
  apiRouter: reviewerRouter,
  trigger: { kind: 'github', event: 'review_requested' },
  run: async (ctx: RunContext) => {
    const event = ctx.event as ReviewerRequestEvent;
    await createReviewTaskFromPr({
      repo_path: ctx.repoPath,
      pr_number: event.pr_number,
      pr_url: event.pr_url,
      pr_head_sha: event.pr_head_sha,
      base_branch: event.base_branch,
      title: event.title,
      author: event.author,
      requested_at: event.requested_at,
    });
  },
};

registerWorkflow(reviewerWorkflow);
