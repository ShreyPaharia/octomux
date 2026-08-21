/**
 * server/surfaces/portability.test.ts
 *
 * This is the point of the whole `ctx.surfaces` ticket: a `ctx.ui` panel
 * binding is a declarative fact-type + renderer-name pairing, never a DOM
 * node, a Block Kit block, or an ANSI escape. So a binding a plugin
 * registered a year before some surface existed still renders on it, with
 * zero change to the plugin that wrote the binding.
 *
 * "coverage-bot" here never mentions Discord. A brand-new `demo:discord`
 * surface is registered afterward, by nobody coverage-bot knows about, and
 * coverage-bot's panel shows up on it anyway — degraded to whatever renderer
 * Discord actually declared.
 */
import { describe, it, expect, beforeEach } from '../bun-test.js';
import { createTestDb, insertTask } from '../test-helpers.js';
import { defineFactType, putFact, resetFacts } from '../plugins/facts.js';
import { defineCollection, putRecord, resetCollections } from '../plugins/collections.js';
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
import { panelsForSurface, renderCollectionPanels } from './render.js';

describe('surfaces portability', () => {
  beforeEach(() => {
    const db = createTestDb();
    insertTask(db, { id: 'task-1' });
    resetFacts();
    resetPluginUi();
    resetSurfaces();
    registerCoreSurfaces();
    freezeCoreSurfaces();
  });

  it('a binding registered before a surface existed renders on that surface once added, unchanged', async () => {
    // Step 1: coverage-bot declares its fact type and its panel binding, and
    // writes a fact — all of this happens with ZERO surfaces beyond core's
    // four in existence. coverage-bot has no idea Discord will ever exist.
    defineFactType('coverage-bot', {
      type: 'coverage',
      schema: { type: 'object', properties: { pct: { type: 'number' } } },
    });
    registerPluginUiPanel('coverage-bot', {
      slot: 'task.panel',
      fact: 'coverage',
      as: 'stat',
      value: 'pct',
      title: 'Coverage',
    });
    await putFact('coverage-bot', 'task-1', 'coverage', { pct: 87 });

    // Step 2: only NOW does a Discord surface show up — registered by a
    // totally different plugin, which ships zero coverage-bot-aware code.
    // It only supports markdown.
    registerSurface({
      kind: 'demo:discord',
      renderers: ['markdown'],
      fallback: 'markdown',
      render(panel) {
        return panel.facts.length === 0 ? undefined : `**${panel.title}**: rendered`;
      },
    });

    // Step 3: coverage-bot's `stat` binding degrades to Discord's declared
    // `markdown` fallback and still renders — non-empty text, no code from
    // coverage-bot involved.
    const discordPanels = await panelsForSurface('demo:discord', 'task-1');
    expect(discordPanels).toHaveLength(1);
    expect(discordPanels[0].pluginId).toBe('coverage-bot');
    expect(discordPanels[0].as).toBe('stat');
    expect(discordPanels[0].renderer).toBe('markdown');
    expect(discordPanels[0].text.length).toBeGreaterThan(0);

    // Step 4: the SAME binding also renders on `cli`, which draws `stat`
    // natively — no fallback needed there.
    const cliPanels = await panelsForSurface('cli', 'task-1');
    expect(cliPanels).toHaveLength(1);
    expect(cliPanels[0].pluginId).toBe('coverage-bot');
    expect(cliPanels[0].renderer).toBe('stat');
    expect(cliPanels[0].text).toContain('87');

    // Step 5: removing the Discord surface must not orphan the binding —
    // it's still in the ui-contribution table, and still renders on cli.
    expect(unregisterSurface('demo:discord')).toBe(true);
    const stillListed = listUiContributions().find((c) => c.pluginId === 'coverage-bot');
    expect(stillListed).toBeDefined();

    const cliPanelsAfter = await panelsForSurface('cli', 'task-1');
    expect(cliPanelsAfter).toHaveLength(1);
    expect(cliPanelsAfter[0].renderer).toBe('stat');

    await expect(panelsForSurface('demo:discord', 'task-1')).rejects.toThrow(
      /unknown surface "demo:discord"/,
    );
  });
});

/**
 * The same property, for a COLLECTION-bound binding (SHR-279).
 *
 * SHR-275 made a panel bindable to a durable collection instead of a
 * task-scoped fact, and for a while nothing rendered those at all. The
 * binding model is only half true if portability holds for one kind of
 * binding and not the other — a plugin picked `collection` over `fact` for a
 * storage reason, not a rendering one, and that choice must not decide which
 * surfaces its panel can ever appear on.
 *
 * "pipeline-bot" here never mentions Discord either, and never mentions a
 * task: its records outlive every task in the workspace.
 */
describe('surfaces portability — collection bindings', () => {
  beforeEach(() => {
    createTestDb();
    resetFacts();
    resetCollections();
    resetPluginUi();
    resetSurfaces();
    registerCoreSurfaces();
    freezeCoreSurfaces();
  });

  it('a collection-bound binding registered before a surface existed renders on that surface once added, unchanged', async () => {
    // Step 1: pipeline-bot defines a durable collection, binds a panel to it
    // and writes records — with zero surfaces beyond core's four in
    // existence, and no task anywhere in the story.
    defineCollection('pipeline-bot', {
      name: 'deals',
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, stage: { type: 'string' } },
      },
      key: 'id',
    });
    registerPluginUiPanel('pipeline-bot', {
      slot: 'settings.card',
      collection: 'deals',
      as: 'table',
      title: 'Pipeline',
    });
    await putRecord('pipeline-bot', 'deals', { id: 'd-1', stage: 'won' });
    await putRecord('pipeline-bot', 'deals', { id: 'd-2', stage: 'lost' });

    // Step 2: a Discord surface shows up, registered by a different plugin
    // that ships zero pipeline-bot-aware code — and, crucially, zero
    // collection-aware code. It reads `panel.facts`, the only data field
    // `SurfacePanel` has ever had.
    registerSurface({
      kind: 'demo:discord',
      renderers: ['markdown'],
      fallback: 'markdown',
      render(panel) {
        return panel.facts.length === 0 ? undefined : `**${panel.title}**: ${panel.facts.length}`;
      },
    });

    // Step 3: the `table` binding degrades to Discord's declared `markdown`
    // fallback and renders both records — no code from pipeline-bot, and no
    // collection handling from Discord, involved.
    const discordPanels = await renderCollectionPanels('demo:discord', 'pipeline-bot:deals');
    expect(discordPanels).toHaveLength(1);
    expect(discordPanels[0].pluginId).toBe('pipeline-bot');
    expect(discordPanels[0].as).toBe('table');
    expect(discordPanels[0].renderer).toBe('markdown');
    expect(discordPanels[0].text).toBe('**Pipeline**: 2');

    // Step 4: the SAME binding renders on `cli`, which draws `table`
    // natively — no fallback needed there.
    const cliPanels = await renderCollectionPanels('cli', 'pipeline-bot:deals');
    expect(cliPanels).toHaveLength(1);
    expect(cliPanels[0].renderer).toBe('table');
    expect(cliPanels[0].text).toContain('d-1');
    expect(cliPanels[0].text).toContain('won');

    // Step 5: removing Discord must not orphan the binding — still listed,
    // still renders on cli, and asking the dead surface throws the same way
    // it does for a fact-bound panel.
    expect(unregisterSurface('demo:discord')).toBe(true);
    expect(listUiContributions().find((c) => c.pluginId === 'pipeline-bot')).toBeDefined();
    expect(await renderCollectionPanels('cli', 'pipeline-bot:deals')).toHaveLength(1);
    await expect(renderCollectionPanels('demo:discord', 'pipeline-bot:deals')).rejects.toThrow(
      /unknown surface "demo:discord"/,
    );
  });

  it('web declares it cannot render server-side — for a collection exactly as for a task', async () => {
    defineCollection('pipeline-bot', { name: 'deals', schema: {}, key: 'id' });
    registerPluginUiPanel('pipeline-bot', {
      slot: 'settings.card',
      collection: 'deals',
      as: 'table',
    });
    await putRecord('pipeline-bot', 'deals', { id: 'd-1' });

    await expect(renderCollectionPanels('web', 'pipeline-bot:deals')).rejects.toThrow(
      /has no render/,
    );
  });
});
