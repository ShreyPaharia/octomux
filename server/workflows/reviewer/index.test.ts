import { describe, it, expect } from 'vitest';
import { getWorkflow } from '../registry.js';
import { router as reviewerRouter } from './routes.js';
import './index.js';

describe('reviewer workflow registration', () => {
  it('registers the reviewer kind with feed+artifact surfaces and the reviews router', () => {
    const wf = getWorkflow('reviewer');
    expect(wf).toBeDefined();
    expect(wf?.displayName).toBe('PR Reviewer');
    expect(wf?.surfaces).toEqual(['feed', 'artifact']);
    expect(wf?.apiRouter).toBe(reviewerRouter);
    expect(wf?.trigger).toEqual({ kind: 'github', event: 'review_requested' });
    expect(wf?.run).toBeTypeOf('function');
  });
});
