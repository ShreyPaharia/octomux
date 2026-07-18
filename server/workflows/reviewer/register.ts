import { registerWorkflow } from '../registry.js';
import { router as reviewsRouter } from '../../routes/reviews.js';
import type { WorkflowType } from '../types.js';

export const reviewerWorkflow: WorkflowType = {
  kind: 'reviewer',
  displayName: 'PR Reviewer',
  surfaces: ['feed', 'artifact'],
  apiRouter: reviewsRouter,
};

registerWorkflow(reviewerWorkflow);
