import { describe, it, expect, beforeEach, afterEach } from '../bun-test.js';
import { createTestDb, insertTask } from '../test-helpers.js';
import {
  resolveRenderer,
  contributionsForSurface,
  panelsForTask,
  panelsForStore,
  promptOn,
} from './render.js';
import { registerSurface, resetSurfaces, freezeCoreSurfaces } from './registry.js';
import { registerCoreSurfaces } from './core.js';
import { defineStore, putRecord, resetRecords } from '../plugins/records.js';
import { registerPluginUiPanel, resetPluginUi } from '../plugins/ui-registry.js';
import type { SurfaceDefinition, SurfacePanel } from '@octomux/plugin-api';

describe('surfaces/render', () => {
  beforeEach(() => {
    const db = createTestDb();
    insertTask(db, { id: 'task-1' });
    resetRecords();
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

  describe('contributionsForSurface / panelsForTask', () => {
    it('throws on an unknown surface kind', () => {
      expect(() => contributionsForSurface('nope')).toThrow(/unknown surface "nope"/);
      expect(panelsForTask('nope', 'task-1')).rejects.toThrow(/unknown surface "nope"/);
    });

    it('panelsForTask on web throws — the client renders it, not the host', async () => {
      registerPluginUiPanel('coverage-bot', {
        slot: 'task.panel',
        record: 'coverage',
        as: 'stat',
        value: 'pct',
      });
      await expect(panelsForTask('web', 'task-1')).rejects.toThrow(
        /surface "web" has no render — the client renders it/,
      );
    });

    it('a throwing render skips only that panel, leaving siblings intact', async () => {
      defineStore('coverage-bot', { name: 'coverage', scope: 'task', mode: 'append' });
      defineStore('status-bot', { name: 'status', scope: 'task', mode: 'append' });
      registerPluginUiPanel('coverage-bot', {
        slot: 'task.panel',
        record: 'coverage',
        as: 'stat',
        value: 'pct',
      });
      registerPluginUiPanel('status-bot', {
        slot: 'task.badge',
        record: 'status',
        as: 'badge',
        value: 'value',
      });
      await putRecord('coverage-bot', 'coverage', { pct: 87 }, 'task-1');
      await putRecord('status-bot', 'status', { value: 'green' }, 'task-1');

      registerSurface({
        kind: 'demo:flaky',
        renderers: ['stat', 'badge'],
        render(panel: SurfacePanel) {
          if (panel.pluginId === 'coverage-bot') throw new Error('boom');
          return `[${panel.pluginId}]`;
        },
      });

      const panels = await panelsForTask('demo:flaky', 'task-1');
      expect(panels).toHaveLength(1);
      expect(panels[0].pluginId).toBe('status-bot');
    });

    it('drops a panel whose render returns undefined', async () => {
      defineStore('coverage-bot', { name: 'coverage', scope: 'task', mode: 'append' });
      registerPluginUiPanel('coverage-bot', { slot: 'task.panel', record: 'coverage', as: 'stat' });
      // No record written — cli's renderPanelText returns undefined for empty records.
      const panels = await panelsForTask('cli', 'task-1');
      expect(panels).toHaveLength(0);
    });

    it('a durable store binding renders nothing through the task walk — no row carries this taskId', async () => {
      defineStore('pipeline-bot', { name: 'leads', scope: 'durable', mode: 'upsert', key: 'id' });
      registerPluginUiPanel('pipeline-bot', {
        slot: 'settings.card',
        record: 'leads',
        as: 'table',
      });
      await putRecord('pipeline-bot', 'leads', { id: 'd-1', stage: 'won' });

      const panels = await panelsForTask('cli', 'task-1');
      expect(panels).toHaveLength(0);
    });
  });

  describe('panelsForStore', () => {
    it('throws on an unknown surface kind', async () => {
      await expect(panelsForStore('nope', 'coverage-bot:baselines')).rejects.toThrow(
        /unknown surface "nope"/,
      );
    });

    it('throws on web — the client renders it, not the host', async () => {
      defineStore('coverage-bot', {
        name: 'baselines',
        scope: 'durable',
        mode: 'upsert',
        key: 'branch',
      });
      registerPluginUiPanel('coverage-bot', {
        slot: 'settings.card',
        record: 'baselines',
        as: 'table',
      });
      await expect(panelsForStore('web', 'coverage-bot:baselines')).rejects.toThrow(
        /surface "web" has no render — the client renders it/,
      );
    });

    it('renders a store-bound panel on cli with real record data', async () => {
      defineStore('coverage-bot', {
        name: 'baselines',
        scope: 'durable',
        mode: 'upsert',
        key: 'branch',
      });
      registerPluginUiPanel('coverage-bot', {
        slot: 'settings.card',
        record: 'baselines',
        as: 'stat',
        value: 'pct',
      });
      await putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 91 });

      const panels = await panelsForStore('cli', 'coverage-bot:baselines');
      expect(panels).toHaveLength(1);
      expect(panels[0].pluginId).toBe('coverage-bot');
      expect(panels[0].text).toContain('91');
    });

    it('ignores contributions bound to a different store', async () => {
      defineStore('coverage-bot', {
        name: 'baselines',
        scope: 'durable',
        mode: 'upsert',
        key: 'branch',
      });
      defineStore('coverage-bot', { name: 'other', scope: 'durable', mode: 'upsert', key: 'id' });
      registerPluginUiPanel('coverage-bot', {
        slot: 'settings.card',
        record: 'other',
        as: 'table',
      });
      registerPluginUiPanel('coverage-bot', {
        slot: 'settings.card',
        record: 'baselines',
        as: 'stat',
        value: 'pct',
      });
      await putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 91 });
      await putRecord('coverage-bot', 'other', { id: 1 });

      const panels = await panelsForStore('cli', 'coverage-bot:baselines');
      expect(panels).toHaveLength(1);
      expect(panels[0].text).toContain('91');
    });

    it('returns [] when the store has no records', async () => {
      defineStore('coverage-bot', {
        name: 'baselines',
        scope: 'durable',
        mode: 'upsert',
        key: 'branch',
      });
      registerPluginUiPanel('coverage-bot', {
        slot: 'settings.card',
        record: 'baselines',
        as: 'stat',
        value: 'pct',
      });

      const panels = await panelsForStore('cli', 'coverage-bot:baselines');
      expect(panels).toHaveLength(0);
    });

    it('a throwing render skips only that panel, leaving siblings intact', async () => {
      defineStore('coverage-bot', {
        name: 'baselines',
        scope: 'durable',
        mode: 'upsert',
        key: 'branch',
      });
      registerPluginUiPanel('coverage-bot', {
        slot: 'settings.card',
        record: 'baselines',
        as: 'stat',
        value: 'pct',
      });
      registerPluginUiPanel('coverage-bot', {
        slot: 'settings.card',
        record: 'baselines',
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

      const panels = await panelsForStore('demo:flaky', 'coverage-bot:baselines');
      expect(panels).toHaveLength(1);
      expect(panels[0].as).toBe('badge');
    });

    it('honours q — limit narrows which records reach render', async () => {
      defineStore('coverage-bot', {
        name: 'baselines',
        scope: 'durable',
        mode: 'upsert',
        key: 'branch',
      });
      registerPluginUiPanel('coverage-bot', {
        slot: 'settings.card',
        record: 'baselines',
        as: 'timeline',
      });
      await putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 91 });
      await putRecord('coverage-bot', 'baselines', { branch: 'dev', pct: 42 });

      const panels = await panelsForStore('cli', 'coverage-bot:baselines', { limit: 1 });
      expect(panels).toHaveLength(1);
      // timeline renders every record it's handed — with limit:1 only one shows.
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
