import { describe, it, expect } from 'vitest';
import { getWorkflow } from '../registry.js';
import './index.js';

describe('pr-extract workflow registration', () => {
  it('registers the pr-extract kind with an output schema and github run handler', () => {
    const wf = getWorkflow('pr-extract');
    expect(wf).toBeDefined();
    expect(wf?.displayName).toBe('PR Extracts');
    expect(wf?.surfaces).toEqual(['feed', 'artifact']);
    expect(wf?.output).toMatchObject({
      required: ['area', 'risk', 'has_migration', 'surface', 'loc'],
    });
    expect(wf?.trigger).toEqual({ kind: 'github', event: 'pr_merged' });
    expect(wf?.run).toBeTypeOf('function');
    expect(wf?.apiRouter).toBeDefined();
  });
});
