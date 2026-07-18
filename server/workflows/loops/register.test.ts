import { describe, it, expect } from 'vitest';
import { getWorkflow } from '../registry.js';
import './register.js';

describe('loops workflow registration', () => {
  it('registers the loops kind with feed/artifact/session surfaces', () => {
    const wf = getWorkflow('loops');
    expect(wf).toBeDefined();
    expect(wf?.displayName).toBe('Loops');
    expect(wf?.surfaces).toEqual(['feed', 'artifact', 'session']);
    expect(wf?.apiRouter).toBeDefined();
    expect(wf?.trigger).toEqual({ kind: 'manual' });
  });
});
