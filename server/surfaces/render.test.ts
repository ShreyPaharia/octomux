import { describe, it, expect, beforeEach, afterEach } from '../bun-test.js';
import { createTestDb, insertTask } from '../test-helpers.js';
import { resolveRenderer, contributionsForSurface, panelsForSurface, promptOn } from './render.js';
import { registerSurface, resetSurfaces, freezeCoreSurfaces } from './registry.js';
import { registerCoreSurfaces } from './core.js';
import { defineFactType, putFact, resetFacts } from '../plugins/facts.js';
import { registerPluginUiPanel, resetPluginUi } from '../plugins/ui-registry.js';
import type { SurfaceDefinition, SurfacePanel } from '@octomux/plugin-api';

describe('surfaces/render', () => {
  beforeEach(() => {
    const db = createTestDb();
    insertTask(db, { id: 'task-1' });
    resetFacts();
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
