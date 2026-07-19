import { describe, it, expect } from 'vitest';
import { getWorkflowUI } from '../registry';
import './register';

describe('prod-log-triage workflow UI registration', () => {
  it('registers navLabel, icon, ListView, and DetailView', () => {
    const ui = getWorkflowUI('prod-log-triage');
    expect(ui?.navLabel).toBe('Prod Log Triage');
    expect(ui?.icon).toBeDefined();
    expect(ui?.ListView).toBeDefined();
    expect(ui?.DetailView).toBeDefined();
  });
});
