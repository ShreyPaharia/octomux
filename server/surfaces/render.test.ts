import { describe, it, expect, beforeEach, afterEach } from '../bun-test.js';
import { createTestDb, insertTask } from '../test-helpers.js';
import {
  resolveRenderer,
  contributionsForSurface,
  panelsForSurface,
  renderCollectionPanels,
  promptOn,
} from './render.js';
import { registerSurface, resetSurfaces, freezeCoreSurfaces } from './registry.js';
import { registerCoreSurfaces } from './core.js';
import { defineFactType, putFact, resetFacts } from '../plugins/facts.js';
import { defineCollection, putRecord, resetCollections } from '../plugins/collections.js';
import { registerPluginUiPanel, resetPluginUi } from '../plugins/ui-registry.js';
import type { SurfaceDefinition, SurfacePanel } from '@octomux/plugin-api';

describe('surfaces/render', () => {
  beforeEach(() => {
    const db = createTestDb();
    insertTask(db, { id: 'task-1' });
    resetFacts();
    resetCollections();
    resetPluginUi();
    resetSurfaces();
    registerCoreSurfaces();
    freezeCoreSurfaces();
  });

  afterEach(() => {
    resetSurfaces();
    registerCoreSurfaces();
    freezeCoreSurfaces();
  });

  describe('resolveRenderer', () => {
    it('passes through a renderer the surface declares', () => {
      const surface: SurfaceDefinition = { kind: 'demo:x', renderers: ['stat', 'badge'] };
      expect(resolveRenderer(surface, 'stat')).toBe('stat');
    });

    it('falls back to json by default when the surface cannot draw it', () => {
      const surface: SurfaceDefinition = { kind: 'demo:x', renderers: ['markdown'] };
      expect(resolveRenderer(surface, 'stat')).toBe('json');
    });

    it('falls back to the surface-declared fallback', () => {
      const surface: SurfaceDefinition = {
        kind: 'demo:x',
        renderers: ['markdown'],
        fallback: 'markdown',
      };
      expect(resolveRenderer(surface, 'table')).toBe('markdown');
    });
  });

  describe('contributionsForSurface / panelsForSurface', () => {
    it('throws on an unknown surface kind', () => {
      expect(() => contributionsForSurface('nope')).toThrow(/unknown surface "nope"/);
      expect(panelsForSurface('nope', 'task-1')).rejects.toThrow(/unknown surface "nope"/);
    });

    it('panelsForSurface on web throws — the client renders it, not the host', async () => {
      registerPluginUiPanel('coverage-bot', {
        slot: 'task.panel',
        fact: 'coverage',
        as: 'stat',
        value: 'pct',
      });
      await expect(panelsForSurface('web', 'task-1')).rejects.toThrow(
        /surface "web" has no render — the client renders it/,
      );
    });

    it('a throwing render skips only that panel, leaving siblings intact', async () => {
      defineFactType('coverage-bot', { type: 'coverage', schema: { type: 'object' } });
      defineFactType('status-bot', { type: 'status', schema: { type: 'object' } });
      registerPluginUiPanel('coverage-bot', {
        slot: 'task.panel',
        fact: 'coverage',
        as: 'stat',
        value: 'pct',
      });
      registerPluginUiPanel('status-bot', {
        slot: 'task.badge',
        fact: 'status',
        as: 'badge',
        value: 'value',
      });
      await putFact('coverage-bot', 'task-1', 'coverage', { pct: 87 });
      await putFact('status-bot', 'task-1', 'status', { value: 'green' });

      registerSurface({
        kind: 'demo:flaky',
        renderers: ['stat', 'badge'],
        render(panel: SurfacePanel) {
          if (panel.pluginId === 'coverage-bot') throw new Error('boom');
          return `[${panel.pluginId}]`;
        },
      });

      const panels = await panelsForSurface('demo:flaky', 'task-1');
      expect(panels).toHaveLength(1);
      expect(panels[0].pluginId).toBe('status-bot');
    });

    it('drops a panel whose render returns undefined', async () => {
      defineFactType('coverage-bot', { type: 'coverage', schema: { type: 'object' } });
      registerPluginUiPanel('coverage-bot', {
        slot: 'task.panel',
        fact: 'coverage',
        as: 'stat',
      });
      // No fact written — cli's renderPanelText returns undefined for empty facts.
      const panels = await panelsForSurface('cli', 'task-1');
      expect(panels).toHaveLength(0);
    });

    it('skips a collection-bound contribution rather than rendering it empty or crashing', async () => {
      defineCollection('coverage-bot', {
        name: 'baselines',
        schema: { type: 'object' },
        key: 'branch',
      });
      registerPluginUiPanel('coverage-bot', {
        slot: 'settings.card',
        collection: 'baselines',
        as: 'table',
      });
      await putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 87 });

      const panels = await panelsForSurface('cli', 'task-1');
      expect(panels).toHaveLength(0);
    });
  });

  describe('renderCollectionPanels', () => {
    it('throws on an unknown surface kind', async () => {
      await expect(renderCollectionPanels('nope', 'coverage-bot:baselines')).rejects.toThrow(
        /unknown surface "nope"/,
      );
    });

    it('throws on web — the client renders it, not the host', async () => {
      defineCollection('coverage-bot', {
        name: 'baselines',
        schema: { type: 'object' },
        key: 'branch',
      });
      registerPluginUiPanel('coverage-bot', {
        slot: 'settings.card',
        collection: 'baselines',
        as: 'table',
      });
      await expect(renderCollectionPanels('web', 'coverage-bot:baselines')).rejects.toThrow(
        /surface "web" has no render — the client renders it/,
      );
    });

    it('renders a collection-bound panel on cli with real record data', async () => {
      defineCollection('coverage-bot', {
        name: 'baselines',
        schema: { type: 'object' },
        key: 'branch',
      });
      registerPluginUiPanel('coverage-bot', {
        slot: 'settings.card',
        collection: 'baselines',
        as: 'stat',
        value: 'pct',
      });
      await putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 91 });

      const panels = await renderCollectionPanels('cli', 'coverage-bot:baselines');
      expect(panels).toHaveLength(1);
      expect(panels[0].pluginId).toBe('coverage-bot');
      expect(panels[0].text).toContain('91');
    });

    it('ignores fact-bound contributions and contributions bound to a different collection', async () => {
      defineFactType('status-bot', { type: 'status', schema: { type: 'object' } });
      defineCollection('coverage-bot', {
        name: 'baselines',
        schema: { type: 'object' },
        key: 'branch',
      });
      defineCollection('coverage-bot', {
        name: 'other',
        schema: { type: 'object' },
        key: 'id',
      });
      registerPluginUiPanel('status-bot', { slot: 'task.badge', fact: 'status', as: 'badge' });
      registerPluginUiPanel('coverage-bot', {
        slot: 'settings.card',
        collection: 'other',
        as: 'table',
      });
      registerPluginUiPanel('coverage-bot', {
        slot: 'settings.card',
        collection: 'baselines',
        as: 'stat',
        value: 'pct',
      });
      await putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 91 });
      await putRecord('coverage-bot', 'other', { id: 1 });

      const panels = await renderCollectionPanels('cli', 'coverage-bot:baselines');
      expect(panels).toHaveLength(1);
      expect(panels[0].text).toContain('91');
    });

    it('returns [] when the collection has no records', async () => {
      defineCollection('coverage-bot', {
        name: 'baselines',
        schema: { type: 'object' },
        key: 'branch',
      });
      registerPluginUiPanel('coverage-bot', {
        slot: 'settings.card',
        collection: 'baselines',
        as: 'stat',
        value: 'pct',
      });

      const panels = await renderCollectionPanels('cli', 'coverage-bot:baselines');
      expect(panels).toHaveLength(0);
    });

    it('a throwing render skips only that panel, leaving siblings intact', async () => {
      defineCollection('coverage-bot', {
        name: 'baselines',
        schema: { type: 'object' },
        key: 'branch',
      });
      registerPluginUiPanel('coverage-bot', {
        slot: 'settings.card',
        collection: 'baselines',
        as: 'stat',
        value: 'pct',
      });
      registerPluginUiPanel('coverage-bot', {
        slot: 'settings.card',
        collection: 'baselines',
        as: 'badge',
        value: 'pct',
      });
      await putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 91 });

      registerSurface({
        kind: 'demo:flaky',
        renderers: ['stat', 'badge'],
        render(panel: SurfacePanel) {
          if (panel.as === 'stat') throw new Error('boom');
          return `[${panel.as}]`;
        },
      });

      const panels = await renderCollectionPanels('demo:flaky', 'coverage-bot:baselines');
      expect(panels).toHaveLength(1);
      expect(panels[0].as).toBe('badge');
    });

    it('honours q — limit narrows which records reach render', async () => {
      defineCollection('coverage-bot', {
        name: 'baselines',
        schema: { type: 'object' },
        key: 'branch',
      });
      registerPluginUiPanel('coverage-bot', {
        slot: 'settings.card',
        collection: 'baselines',
        as: 'timeline',
      });
      await putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 91 });
      await putRecord('coverage-bot', 'baselines', { branch: 'dev', pct: 42 });

      const panels = await renderCollectionPanels('cli', 'coverage-bot:baselines', { limit: 1 });
      expect(panels).toHaveLength(1);
      // timeline renders every fact it's handed — with limit:1 only one record shows.
      const lines = panels[0].text.split('\n').filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(1);
    });
  });

  describe('promptOn', () => {
    it('throws on an unknown surface kind', async () => {
      await expect(promptOn('nope', { question: 'ok?' })).rejects.toThrow(/unknown surface "nope"/);
    });

    it('throws naming a read-only core surface', async () => {
      await expect(promptOn('cli', { question: 'ok?' })).rejects.toThrow(
        /surface "cli" is read-only — it renders panels but cannot prompt/,
      );
    });

    it('returns the answer from a surface that declares prompt', async () => {
      registerSurface({
        kind: 'demo:interactive',
        renderers: ['json'],
        async prompt(ask) {
          return `answered: ${ask.question}`;
        },
      });
      await expect(promptOn('demo:interactive', { question: 'ship it?' })).resolves.toBe(
        'answered: ship it?',
      );
    });
  });
});
