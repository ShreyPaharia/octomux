import { describe, it, expect, beforeEach } from 'vitest';
import { registerWorkflow, getWorkflow, listWorkflows } from './registry.js';

describe('workflow registry', () => {
  beforeEach(() => {
    // registry is a module-level singleton; re-registering the same kind is idempotent
    // (Map.set overwrites), so tests can safely register fixtures per-test without reset plumbing.
  });

  it('registers a workflow and resolves it by kind', () => {
    registerWorkflow({ kind: 'test-kind', displayName: 'Test Kind', surfaces: ['feed'] });
    expect(getWorkflow('test-kind')).toEqual({
      kind: 'test-kind',
      displayName: 'Test Kind',
      surfaces: ['feed'],
    });
  });

  it('returns undefined for an unregistered kind', () => {
    expect(getWorkflow('does-not-exist')).toBeUndefined();
  });

  it('lists all registered workflows', () => {
    registerWorkflow({ kind: 'list-a', displayName: 'A', surfaces: ['feed'] });
    registerWorkflow({ kind: 'list-b', displayName: 'B', surfaces: ['artifact'] });
    const kinds = listWorkflows().map((w) => w.kind);
    expect(kinds).toEqual(expect.arrayContaining(['list-a', 'list-b']));
  });
});
