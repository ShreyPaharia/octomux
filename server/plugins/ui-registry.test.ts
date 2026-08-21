import { describe, it, expect, beforeEach } from '../bun-test.js';
import { default as pino } from 'pino';
import { setLogger } from '../logger.js';
import {
  registerPluginUiPanel,
  listUiContributions,
  unregisterPluginUi,
  resetPluginUi,
} from './ui-registry.js';
import { defineFactType, resetFacts } from './facts.js';
import { defineCollection, resetCollections } from './collections.js';

describe('plugins/ui-registry', () => {
  beforeEach(() => {
    resetPluginUi();
    resetFacts();
    resetCollections();
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

  // Finding 4: a typo in binding.fact yields a permanently empty panel with
  // no diagnostic today. listUiContributions() must warn (never throw — the
  // plugin author's define()/panel() ordering inside one apply() is not
  // something core should police with a hard failure).
  describe('binding.fact typo diagnostic', () => {
    it('warns once when a panel binds a fact type nothing defined', () => {
      const logs: string[] = [];
      setLogger(pino({ level: 'trace' }, { write: (msg: string) => logs.push(msg) }));

      registerPluginUiPanel('coverage-bot', {
        slot: 'task.panel',
        fact: 'coverge', // typo of 'coverage'
        as: 'stat',
      });

      listUiContributions();
      listUiContributions(); // second read must not double-log

      const warnLines = logs.filter(
        (l) => l.includes('"level":40') && l.includes('coverage-bot:coverge'),
      );
      expect(warnLines).toHaveLength(1);
    });

    it('does not warn when the bound fact type is actually defined', () => {
      const logs: string[] = [];
      setLogger(pino({ level: 'trace' }, { write: (msg: string) => logs.push(msg) }));

      defineFactType('coverage-bot', { type: 'coverage', schema: { type: 'object' } });
      registerPluginUiPanel('coverage-bot', {
        slot: 'task.panel',
        fact: 'coverage',
        as: 'stat',
      });

      listUiContributions();

      expect(logs.some((l) => l.includes('"level":40'))).toBe(false);
    });
  });

  // SHR-275: a panel can bind to a durable collection instead of a task-scoped
  // fact. `UiPanelBinding` is now a union of the two shapes; these cover the
  // new branch without touching any of the fact-bound cases above.
  describe('collection-bound panels (SHR-275)', () => {
    it('qualifies the bare collection name and attaches no factType', () => {
      registerPluginUiPanel('coverage-bot', {
        slot: 'task.panel',
        collection: 'baselines',
        as: 'table',
        title: 'Baselines',
      });

      const contributions = listUiContributions();
      expect(contributions).toHaveLength(1);
      expect(contributions[0]).toMatchObject({
        pluginId: 'coverage-bot',
        slot: 'task.panel',
        collection: 'baselines',
        collectionName: 'coverage-bot:baselines',
        as: 'table',
        title: 'Baselines',
      });
      expect(contributions[0].factType).toBeUndefined();
    });

    it('a fact binding still qualifies to factType with no collectionName', () => {
      registerPluginUiPanel('coverage-bot', {
        slot: 'task.panel',
        fact: 'coverage',
        as: 'stat',
      });

      const contributions = listUiContributions();
      expect(contributions[0].factType).toBe('coverage-bot:coverage');
      expect(contributions[0].collectionName).toBeUndefined();
    });

    it('throws when neither fact nor collection is set', () => {
      expect(() =>
        registerPluginUiPanel('coverage-bot', {
          slot: 'task.panel',
          as: 'stat',
        } as never),
      ).toThrow(/exactly one of "fact" or "collection"/);
    });

    it('throws when both fact and collection are set', () => {
      expect(() =>
        registerPluginUiPanel('coverage-bot', {
          slot: 'task.panel',
          fact: 'coverage',
          collection: 'baselines',
          as: 'stat',
        } as never),
      ).toThrow(/exactly one of "fact" or "collection"/);
    });

    it('warns once when a panel binds a collection nothing defined', () => {
      const logs: string[] = [];
      setLogger(pino({ level: 'trace' }, { write: (msg: string) => logs.push(msg) }));

      registerPluginUiPanel('coverage-bot', {
        slot: 'task.panel',
        collection: 'baseins', // typo of 'baselines'
        as: 'table',
      });

      listUiContributions();
      listUiContributions(); // second read must not double-log

      const warnLines = logs.filter(
        (l) => l.includes('"level":40') && l.includes('coverage-bot:baseins'),
      );
      expect(warnLines).toHaveLength(1);
    });

    it('does not warn when the bound collection is actually defined', () => {
      const logs: string[] = [];
      setLogger(pino({ level: 'trace' }, { write: (msg: string) => logs.push(msg) }));

      defineCollection('coverage-bot', {
        name: 'baselines',
        schema: { type: 'object' },
        key: 'branch',
      });
      registerPluginUiPanel('coverage-bot', {
        slot: 'task.panel',
        collection: 'baselines',
        as: 'table',
      });

      listUiContributions();

      expect(logs.some((l) => l.includes('"level":40'))).toBe(false);
    });

    it('unregisterPluginUi drops collection bindings too', () => {
      registerPluginUiPanel('coverage-bot', {
        slot: 'task.panel',
        collection: 'baselines',
        as: 'table',
      });

      unregisterPluginUi('coverage-bot');

      expect(listUiContributions()).toHaveLength(0);
    });
  });
});
