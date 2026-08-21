import { describe, it, expect, beforeEach } from '../bun-test.js';
import { default as pino } from 'pino';
import { setLogger } from '../logger.js';
import {
  registerPluginUiPanel,
  listUiContributions,
  unregisterPluginUi,
  resetPluginUi,
  registerPluginUiAction,
  listUiActions,
  listPluginUiActionIds,
  invokeUiAction,
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

// SHR-257: ctx.ui.action() — the write half. `run` is stored host-side only;
// `listUiActions()` must never leak it, and invoking is validated/logged the
// same way `putFact` validates a fact payload.
describe('plugins/ui-registry — actions', () => {
  beforeEach(() => {
    resetPluginUi();
  });

  it('registers, qualifies the bare id, and lists it', () => {
    registerPluginUiAction('coverage-bot', {
      id: 'rerun',
      label: 'Re-run coverage',
      slot: 'task.panel',
      run: async () => ({ message: 'done' }),
    });

    const actions = listUiActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      pluginId: 'coverage-bot',
      actionId: 'coverage-bot:rerun',
      id: 'rerun',
      label: 'Re-run coverage',
      slot: 'task.panel',
    });
  });

  it('filters by slot', () => {
    registerPluginUiAction('coverage-bot', {
      id: 'rerun',
      label: 'Re-run',
      slot: 'task.panel',
      run: async () => {},
    });
    registerPluginUiAction('coverage-bot', {
      id: 'purge',
      label: 'Purge',
      slot: 'settings.card',
      run: async () => {},
    });

    expect(listUiActions('task.panel').map((a) => a.id)).toEqual(['rerun']);
    expect(listUiActions('settings.card').map((a) => a.id)).toEqual(['purge']);
    expect(listUiActions()).toHaveLength(2);
  });

  it('never includes "run" in a listed contribution', () => {
    registerPluginUiAction('coverage-bot', {
      id: 'rerun',
      label: 'Re-run',
      run: async () => {},
    });

    const [action] = listUiActions();
    expect((action as unknown as Record<string, unknown>).run).toBeUndefined();
    expect(Object.keys(action)).not.toContain('run');
  });

  it('rejects a duplicate qualified action id', () => {
    registerPluginUiAction('coverage-bot', { id: 'rerun', label: 'Re-run', run: async () => {} });
    expect(() =>
      registerPluginUiAction('coverage-bot', { id: 'rerun', label: 'Again', run: async () => {} }),
    ).toThrow(/already defined/);
  });

  it('rejects a missing or blank label', () => {
    expect(() =>
      registerPluginUiAction('coverage-bot', { id: 'rerun', label: '', run: async () => {} }),
    ).toThrow(/non-empty string "label"/);
    expect(() =>
      registerPluginUiAction('coverage-bot', {
        id: 'rerun2',
        label: undefined as never,
        run: async () => {},
      }),
    ).toThrow(/non-empty string "label"/);
  });

  it('rejects a non-function run', () => {
    expect(() =>
      registerPluginUiAction('coverage-bot', {
        id: 'rerun',
        label: 'Re-run',
        run: 'nope' as never,
      }),
    ).toThrow(/"run" function/);
  });

  it('rejects a slot outside the six declared slots', () => {
    expect(() =>
      registerPluginUiAction('coverage-bot', {
        id: 'rerun',
        label: 'Re-run',
        slot: 'sidebar.custom' as never,
        run: async () => {},
      }),
    ).toThrow(/slot" must be one of/);
  });

  it("listPluginUiActionIds returns only that plugin's qualified ids", () => {
    registerPluginUiAction('coverage-bot', { id: 'rerun', label: 'Re-run', run: async () => {} });
    registerPluginUiAction('reviewer-bot', { id: 'flag', label: 'Flag', run: async () => {} });

    expect(listPluginUiActionIds('coverage-bot')).toEqual(['coverage-bot:rerun']);
    expect(listPluginUiActionIds('reviewer-bot')).toEqual(['reviewer-bot:flag']);
  });

  describe('invokeUiAction', () => {
    it('runs an action with no schema, defaulting input to {}', async () => {
      let seen: unknown;
      registerPluginUiAction('coverage-bot', {
        id: 'rerun',
        label: 'Re-run',
        run: async (invocation) => {
          seen = invocation;
          return { message: 'ok' };
        },
      });

      const result = await invokeUiAction('coverage-bot:rerun', { taskId: 'task-1' });

      expect(result).toEqual({ message: 'ok' });
      expect(seen).toEqual({ taskId: 'task-1', input: {} });
    });

    it('validates input against the declared schema and passes it through', async () => {
      let seen: unknown;
      registerPluginUiAction('coverage-bot', {
        id: 'rerun',
        label: 'Re-run',
        schema: {
          type: 'object',
          properties: { branch: { type: 'string' } },
          required: ['branch'],
        },
        run: async (invocation) => {
          seen = invocation;
        },
      });

      await invokeUiAction('coverage-bot:rerun', { input: { branch: 'main' } });

      expect(seen).toEqual({ taskId: undefined, input: { branch: 'main' } });
    });

    it('rejects an input that violates the declared schema', async () => {
      registerPluginUiAction('coverage-bot', {
        id: 'rerun',
        label: 'Re-run',
        schema: {
          type: 'object',
          properties: { branch: { type: 'string' } },
          required: ['branch'],
        },
        run: async () => {},
      });

      await expect(invokeUiAction('coverage-bot:rerun', { input: {} })).rejects.toThrow(
        /invalid input for ui action/,
      );
    });

    it('rejects a non-object input when no schema is declared', async () => {
      registerPluginUiAction('coverage-bot', {
        id: 'rerun',
        label: 'Re-run',
        run: async () => {},
      });

      await expect(invokeUiAction('coverage-bot:rerun', { input: 'nope' })).rejects.toThrow(
        /invalid input for ui action/,
      );
      await expect(invokeUiAction('coverage-bot:rerun', { input: ['nope'] })).rejects.toThrow(
        /invalid input for ui action/,
      );
    });

    it('rejects invocation of an unknown action id', async () => {
      await expect(invokeUiAction('coverage-bot:nope', {})).rejects.toThrow(/unknown ui action/);
    });

    it('unregisterPluginUi removes actions, and a later invoke fails as unknown', async () => {
      registerPluginUiAction('coverage-bot', { id: 'rerun', label: 'Re-run', run: async () => {} });

      unregisterPluginUi('coverage-bot');

      expect(listUiActions()).toHaveLength(0);
      await expect(invokeUiAction('coverage-bot:rerun', {})).rejects.toThrow(/unknown ui action/);
    });

    it('unregisterPluginUi is safe for a plugin that registered only actions (no panels)', () => {
      registerPluginUiAction('coverage-bot', { id: 'rerun', label: 'Re-run', run: async () => {} });

      expect(() => unregisterPluginUi('coverage-bot')).not.toThrow();
      expect(listUiActions()).toHaveLength(0);
    });
  });
});
