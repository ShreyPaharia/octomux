import { describe, it, expect, beforeEach } from '../bun-test.js';
import {
  registerPluginUiPanel,
  listUiContributions,
  unregisterPluginUi,
  resetPluginUi,
} from './ui-registry.js';

describe('plugins/ui-registry', () => {
  beforeEach(() => {
    resetPluginUi();
  });

  it('qualifies the bare fact type and attaches the owning plugin id', () => {
    registerPluginUiPanel('coverage-bot', {
      slot: 'task.panel',
      fact: 'coverage',
      as: 'stat',
      title: 'Coverage',
    });

    const contributions = listUiContributions();
    expect(contributions).toHaveLength(1);
    expect(contributions[0]).toMatchObject({
      pluginId: 'coverage-bot',
      slot: 'task.panel',
      fact: 'coverage',
      factType: 'coverage-bot:coverage',
      as: 'stat',
      title: 'Coverage',
    });
  });

  it('lists contributions from multiple plugins', () => {
    registerPluginUiPanel('coverage-bot', { slot: 'task.panel', fact: 'coverage', as: 'stat' });
    registerPluginUiPanel('reviewer-bot', { slot: 'task.badge', fact: 'status', as: 'badge' });

    const contributions = listUiContributions();
    expect(contributions).toHaveLength(2);
    expect(contributions.map((c) => c.pluginId).sort()).toEqual(['coverage-bot', 'reviewer-bot']);
  });

  it('rejects a slot outside the six declared slots', () => {
    expect(() =>
      registerPluginUiPanel('coverage-bot', {
        slot: 'sidebar.custom' as never,
        fact: 'coverage',
        as: 'stat',
      }),
    ).toThrow(/slot" must be one of/);
  });

  it('does not validate "as" against the renderer list — an unknown renderer is legal', () => {
    expect(() =>
      registerPluginUiPanel('coverage-bot', {
        slot: 'task.panel',
        fact: 'coverage',
        as: 'some-future-renderer',
      }),
    ).not.toThrow();
    expect(listUiContributions()[0].as).toBe('some-future-renderer');
  });

  it("unregisterPluginUi drops only that plugin's contributions", () => {
    registerPluginUiPanel('coverage-bot', { slot: 'task.panel', fact: 'coverage', as: 'stat' });
    registerPluginUiPanel('reviewer-bot', { slot: 'task.badge', fact: 'status', as: 'badge' });

    unregisterPluginUi('coverage-bot');

    const contributions = listUiContributions();
    expect(contributions).toHaveLength(1);
    expect(contributions[0].pluginId).toBe('reviewer-bot');
  });

  it('unregisterPluginUi is safe for a plugin that registered nothing', () => {
    expect(() => unregisterPluginUi('never-registered')).not.toThrow();
  });
});
