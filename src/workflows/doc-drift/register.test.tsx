import { describe, it, expect } from 'vitest';
import { getWorkflowUI } from '../registry';
import './register';

describe('doc-drift workflow UI registration', () => {
  it('registers navLabel, icon, ListView, and DetailView', () => {
    const ui = getWorkflowUI('doc-drift');
    expect(ui?.navLabel).toBe('Doc Drift');
    expect(ui?.icon).toBeDefined();
    expect(ui?.ListView).toBeDefined();
    expect(ui?.DetailView).toBeDefined();
  });
});
