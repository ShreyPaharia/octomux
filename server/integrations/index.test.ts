import { describe, it, expect } from 'vitest';
import { listProviders } from './registry.js';
import './index.js';

describe('integrations registry', () => {
  it('registers both jira and linear providers', () => {
    const kinds = listProviders().map((p) => p.kind);
    expect(kinds).toContain('jira');
    expect(kinds).toContain('linear');
  });
});
