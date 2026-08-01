import { describe, it, expect } from 'vitest';
import { registerWorkflowUI, getWorkflowUI, listWorkflowUIs } from './registry';

function Icon() {
  return <svg data-testid="icon" />;
}

describe('client workflow UI registry', () => {
  it('registers a kind and resolves it', () => {
    registerWorkflowUI('rt-kind', { navLabel: 'RT Kind', icon: Icon });
    expect(getWorkflowUI('rt-kind')?.navLabel).toBe('RT Kind');
  });

  it('returns undefined for an unregistered kind', () => {
    expect(getWorkflowUI('rt-missing')).toBeUndefined();
  });

  it('lists registered kinds with their `kind` merged in', () => {
    registerWorkflowUI('rt-list', { navLabel: 'RT List', icon: Icon });
    const entry = listWorkflowUIs().find((w) => w.kind === 'rt-list');
    expect(entry?.navLabel).toBe('RT List');
  });
});
