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
import { panelsForSurface } from './render.js';

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
