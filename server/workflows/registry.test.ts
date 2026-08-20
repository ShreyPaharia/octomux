import { describe, it, expect, beforeEach } from '../bun-test.js';
import type { WorkflowType } from './types.js';
import {
  registerWorkflow,
  registerPluginWorkflow,
  getWorkflow,
  listWorkflows,
  unregisterWorkflow,
} from './registry.js';

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

  // Regression guard: registerWorkflow must stay a plain, unguarded Map.set.
  // server/workflows/presets.ts calls registerWorkflow a second time on kinds
  // that are already registered, on purpose, to overlay preset display metadata
  // onto the existing code handler (mergePresetsIntoRegistry, ~line 195), and
  // reloadPresets() replays that overlay on every UI kind write. If this ever
  // grows a duplicate guard (to mirror integrations/registry.ts or
  // harnesses/registry.ts), the second registerWorkflow call becomes a no-op
  // and kind editing silently stops taking effect. Re-registering the same
  // kind with different fields must always win.
  it('re-registering the same kind overwrites the previous registration', () => {
    registerWorkflow({ kind: 're-reg', displayName: 'Original', surfaces: ['feed'] });
    registerWorkflow({ kind: 're-reg', displayName: 'Overlaid', surfaces: ['feed'] });
    expect(getWorkflow('re-reg')?.displayName).toBe('Overlaid');
  });
});

describe('registerPluginWorkflow', () => {
  it('accepts a valid qualified kind', () => {
    registerPluginWorkflow('demo:changelog', {
      kind: 'demo:changelog',
      displayName: 'Changelog',
      surfaces: ['feed'],
    });
    expect(getWorkflow('demo:changelog')?.displayName).toBe('Changelog');
  });

  it('rejects an unqualified id', () => {
    expect(() =>
      registerPluginWorkflow('changelog', {
        kind: 'changelog',
        displayName: 'Changelog',
        surfaces: ['feed'],
      }),
    ).toThrow();
  });

  it('rejects a core kind (core kinds are always bare, never qualified)', () => {
    registerWorkflow({ kind: 'weekly-update', displayName: 'Weekly Update', surfaces: ['feed'] });
    expect(() =>
      registerPluginWorkflow('weekly-update', {
        kind: 'weekly-update',
        displayName: 'Hijacked',
        surfaces: ['feed'],
      }),
    ).toThrow();
    // untouched — the throw happened before any Map.set
    expect(getWorkflow('weekly-update')?.displayName).toBe('Weekly Update');
  });
});

describe('registerPluginWorkflow key/kind agreement', () => {
  it('overwrites a bare wf.kind with the qualified id so key and kind agree', () => {
    registerPluginWorkflow('demo:changelog', { kind: 'changelog' } as WorkflowType);
    expect(getWorkflow('demo:changelog')?.kind).toBe('demo:changelog');
    expect(getWorkflow('changelog')).toBeUndefined();
  });
});

describe('unregisterWorkflow', () => {
  it('removes a qualified (plugin-owned) kind', () => {
    registerPluginWorkflow('unreg-demo:thing', {
      kind: 'unreg-demo:thing',
      displayName: 'Thing',
      surfaces: ['feed'],
    });
    expect(unregisterWorkflow('unreg-demo:thing')).toBe(true);
    expect(getWorkflow('unreg-demo:thing')).toBeUndefined();
  });

  it('returns false for a kind that was never registered', () => {
    expect(unregisterWorkflow('unreg-demo:never-existed')).toBe(false);
  });

  // R4: a bare kind is always core/home/built-in — refusing on shape alone
  // (no `:`) makes it structurally impossible for a plugin unmount to delete
  // a kind the UI still needs, with no duplicate-registration guard required.
  it('refuses a bare (unqualified) kind, even one that exists', () => {
    registerWorkflow({ kind: 'core-ish', displayName: 'Core-ish', surfaces: ['feed'] });
    expect(unregisterWorkflow('core-ish')).toBe(false);
    expect(getWorkflow('core-ish')).toBeDefined();
  });
});
