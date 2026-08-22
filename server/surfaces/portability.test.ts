/**
 * server/surfaces/portability.test.ts
 *
 * This is the point of the whole `ctx.surfaces` ticket: a `ctx.ui` panel
 * binding is a declarative record-store + renderer-name pairing, never a DOM
 * node, a Block Kit block, or an ANSI escape. So a binding a plugin
 * registered a year before some surface existed still renders on it, with
 * zero change to the plugin that wrote the binding.
 *
 * "coverage-bot" here never mentions Discord. A brand-new `demo:discord`
 * surface is registered afterward, by nobody coverage-bot knows about, and
 * coverage-bot's panel shows up on it anyway — degraded to whatever renderer
 * Discord actually declared.
 *
 * Two describe blocks, kept deliberately separate (SHR-282 rewrite of
 * SHR-279's original split): the first covers the task-scoped path through
 * `panelsForTask`, the second the durable/no-task path through
 * `panelsForStore` — and the SHR-279 regression itself, where a durable
 * binding rendered nothing at all. Collapsing to one block because "there's
 * one binding kind now" would let a broken durable path pass the whole suite
 * silently — SHR-279's exact failure mode, one level deeper.
 */
import { describe, it, expect, beforeEach } from '../bun-test.js';
import { createTestDb, insertTask } from '../test-helpers.js';
import { defineStore, putRecord, resetRecords } from '../plugins/records.js';
import {
  registerPluginUiPanel,
  listUiContributions,
  resetPluginUi,
} from '../plugins/ui-registry.js';
import {
  registerSurface,
  unregisterSurface,
  resetSurfaces,
  freezeCoreSurfaces,
} from './registry.js';
import { registerCoreSurfaces } from './core.js';
import { panelsForTask, panelsForStore } from './render.js';

describe('surfaces portability', () => {
  beforeEach(() => {
    const db = createTestDb();
    insertTask(db, { id: 'task-1' });
    resetRecords();
    resetPluginUi();
    resetSurfaces();
    registerCoreSurfaces();
    freezeCoreSurfaces();
  });

  it('a binding registered before a surface existed renders on it once added — task-scoped', async () => {
    // Step 1: coverage-bot declares its record store and its panel binding,
    // and writes a record — all of this happens with ZERO surfaces beyond
    // core's four in existence. coverage-bot has no idea Discord will ever
    // exist.
    defineStore('coverage-bot', { name: 'coverage', scope: 'task', mode: 'append' });
    registerPluginUiPanel('coverage-bot', {
      slot: 'task.panel',
      record: 'coverage',
      as: 'stat',
      value: 'pct',
      title: 'Coverage',
    });
    await putRecord('coverage-bot', 'coverage', { pct: 87 }, 'task-1');

    // Step 2: only NOW does a Discord surface show up — registered by a
    // totally different plugin, which ships zero coverage-bot-aware code.
    // It only supports markdown.
    registerSurface({
      kind: 'demo:discord',
      renderers: ['markdown'],
      fallback: 'markdown',
      render(panel) {
        return panel.records.length === 0 ? undefined : `**${panel.title}**: rendered`;
      },
    });

    // Step 3: coverage-bot's `stat` binding degrades to Discord's declared
    // `markdown` fallback and still renders — non-empty text, no code from
    // coverage-bot involved.
    const discordPanels = await panelsForTask('demo:discord', 'task-1');
    expect(discordPanels).toHaveLength(1);
    expect(discordPanels[0].pluginId).toBe('coverage-bot');
    expect(discordPanels[0].as).toBe('stat');
    expect(discordPanels[0].renderer).toBe('markdown');
    expect(discordPanels[0].text.length).toBeGreaterThan(0);

    // Step 4: the SAME binding also renders on `cli`, which draws `stat`
    // natively — no fallback needed there.
    const cliPanels = await panelsForTask('cli', 'task-1');
    expect(cliPanels).toHaveLength(1);
    expect(cliPanels[0].pluginId).toBe('coverage-bot');
    expect(cliPanels[0].renderer).toBe('stat');
    expect(cliPanels[0].text).toContain('87');

    // Step 5: removing the Discord surface must not orphan the binding —
    // it's still in the ui-contribution table, and still renders on cli.
    expect(unregisterSurface('demo:discord')).toBe(true);
    const stillListed = listUiContributions().find((c) => c.pluginId === 'coverage-bot');
    expect(stillListed).toBeDefined();

    const cliPanelsAfter = await panelsForTask('cli', 'task-1');
    expect(cliPanelsAfter).toHaveLength(1);
    expect(cliPanelsAfter[0].renderer).toBe('stat');

    await expect(panelsForTask('demo:discord', 'task-1')).rejects.toThrow(
      /unknown surface "demo:discord"/,
    );
  });
});

/**
 * The same property, for a DURABLE-store binding rendered through
 * `panelsForStore` (the original SHR-279 regression: a durable binding that
 * registers, lists in `ctx.catalog`, and is drawn by nothing).
 *
 * "pipeline-bot" here never mentions Discord either, and never mentions a
 * task: its records outlive every task in the workspace.
 */
describe('surfaces portability — durable stores', () => {
  beforeEach(() => {
    createTestDb();
    resetRecords();
    resetPluginUi();
    resetSurfaces();
    registerCoreSurfaces();
    freezeCoreSurfaces();
  });

  it('the same holds for a durable store rendered via panelsForStore', async () => {
    defineStore('pipeline-bot', { name: 'leads', scope: 'durable', mode: 'upsert', key: 'id' });
    registerPluginUiPanel('pipeline-bot', { slot: 'settings.card', record: 'leads', as: 'table' });
    await putRecord('pipeline-bot', 'leads', { id: 'd-1', stage: 'won' });

    registerSurface({
      kind: 'demo:discord',
      renderers: ['table'],
      render: (p) => `${p.records.length} rows`,
    });

    const panels = await panelsForStore('demo:discord', 'pipeline-bot:leads', { limit: 10 });
    expect(panels).toHaveLength(1);
  });

  it('a durable-store binding registered before a surface existed renders on that surface once added, unchanged', async () => {
    // Step 1: pipeline-bot defines a durable store, binds a panel to it and
    // writes records — with zero surfaces beyond core's four in existence,
    // and no task anywhere in the story.
    defineStore('pipeline-bot', { name: 'deals', scope: 'durable', mode: 'upsert', key: 'id' });
    registerPluginUiPanel('pipeline-bot', {
      slot: 'settings.card',
      record: 'deals',
      as: 'table',
      title: 'Pipeline',
    });
    await putRecord('pipeline-bot', 'deals', { id: 'd-1', stage: 'won' });
    await putRecord('pipeline-bot', 'deals', { id: 'd-2', stage: 'lost' });

    // Step 2: a Discord surface shows up, registered by a different plugin
    // that ships zero pipeline-bot-aware code — and, crucially, zero
    // store-aware code. It reads `panel.records`, the only data field
    // `SurfacePanel` has since SHR-282.
    registerSurface({
      kind: 'demo:discord',
      renderers: ['markdown'],
      fallback: 'markdown',
      render(panel) {
        return panel.records.length === 0
          ? undefined
          : `**${panel.title}**: ${panel.records.length}`;
      },
    });

    // Step 3: the `table` binding degrades to Discord's declared `markdown`
    // fallback and renders both records — no code from pipeline-bot involved.
    const discordPanels = await panelsForStore('demo:discord', 'pipeline-bot:deals');
    expect(discordPanels).toHaveLength(1);
    expect(discordPanels[0].pluginId).toBe('pipeline-bot');
    expect(discordPanels[0].as).toBe('table');
    expect(discordPanels[0].renderer).toBe('markdown');
    expect(discordPanels[0].text).toBe('**Pipeline**: 2');

    // Step 4: the SAME binding renders on `cli`, which draws `table`
    // natively — no fallback needed there.
    const cliPanels = await panelsForStore('cli', 'pipeline-bot:deals');
    expect(cliPanels).toHaveLength(1);
    expect(cliPanels[0].renderer).toBe('table');
    expect(cliPanels[0].text).toContain('d-1');
    expect(cliPanels[0].text).toContain('won');

    // Step 5: removing Discord must not orphan the binding — still listed,
    // still renders on cli, and asking the dead surface throws the same way
    // it does for the task-scoped path.
    expect(unregisterSurface('demo:discord')).toBe(true);
    expect(listUiContributions().find((c) => c.pluginId === 'pipeline-bot')).toBeDefined();
    expect(await panelsForStore('cli', 'pipeline-bot:deals')).toHaveLength(1);
    await expect(panelsForStore('demo:discord', 'pipeline-bot:deals')).rejects.toThrow(
      /unknown surface "demo:discord"/,
    );
  });

  it('web declares it cannot render server-side — for a durable store exactly as for a task', async () => {
    defineStore('pipeline-bot', { name: 'deals', scope: 'durable', mode: 'upsert', key: 'id' });
    registerPluginUiPanel('pipeline-bot', { slot: 'settings.card', record: 'deals', as: 'table' });
    await putRecord('pipeline-bot', 'deals', { id: 'd-1' });

    await expect(panelsForStore('web', 'pipeline-bot:deals')).rejects.toThrow(/has no render/);
  });
});
