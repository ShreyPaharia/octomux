// octomux-plugin-discord-surface — registers a `discord` ctx.surfaces surface.
// Reference implementation of `ctx.surfaces.register` — see
// docs/plugins/api-reference.md §ctx.surfaces and this directory's README.md
// for the manifest row, config, and what's a real working implementation
// versus a deliberate stub.
//
// Two things this example proves:
//   1. `render(panel)` is a pure text transform — no network, no credentials,
//      works standalone. It mirrors the same value/delta/payload conventions
//      the web client's own renderer registry uses
//      (src/workflows/renderers/index.tsx), just producing Discord-flavoured
//      markdown text instead of JSX.
//   2. `prompt(ask)` is present — proving a PLUGIN surface can ask a human a
//      question, which none of octomux's four core surfaces do today. The
//      actual Discord network calls are a clearly-marked stub (see
//      `postAndAwaitReply` below and README §Not implemented) rather than
//      untested "real" code claiming to work end-to-end.
//
// Zero new dependencies — `fetch` is a global, and this example never calls
// it (see the stub).

/**
 * Renderer-resolution mirrors `src/workflows/renderers/index.tsx`: the
 * declared `panel.value` key picks a field out of an object payload; a
 * scalar payload is used as-is.
 * @param {{ value?: string }} panel
 * @param {unknown} payload
 * @returns {unknown}
 */
function primaryValue(panel, payload) {
  if (panel.value && typeof payload === 'object' && payload !== null) {
    return /** @type {Record<string, unknown>} */ (payload)[panel.value];
  }
  return payload;
}

/** @param {unknown} v @returns {string} */
function formatScalar(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * `render(panel)` — the only function this surface needs to actually work.
 * `panel.renderer` is guaranteed by the host to be `'markdown'` or `'json'`
 * (the two names we declared in `renderers` below), so those are the only
 * two cases here — see the renderer-resolution table in
 * docs/plugins/api-reference.md §ctx.surfaces.
 *
 * Returns `undefined` when there is nothing to show — the panel is then
 * OMITTED by the caller, never rendered as an empty block.
 *
 * @param {{ renderer: string; title?: string; value?: string; records: Array<{ payload: unknown }> }} panel
 * @returns {string | undefined}
 */
export function render(panel) {
  if (panel.records.length === 0) return undefined;
  const latest = panel.records[panel.records.length - 1];
  const heading = panel.title ? `**${panel.title}**\n` : '';
  if (panel.renderer === 'markdown') {
    const value = primaryValue(panel, latest.payload);
    const text = typeof value === 'string' ? value : formatScalar(value);
    return `${heading}${text}`;
  }
  // renderer === 'json' (the fallback — anything this surface didn't
  // declare, e.g. 'stat' or 'table', resolves here per the renderer
  // contract).
  return `${heading}\`\`\`json\n${JSON.stringify(latest.payload, null, 2)}\n\`\`\``;
}

/**
 * Turns a `SurfacePrompt` into the text this surface would post — pure, no
 * network, real and tested (see the self-check at the bottom of this file).
 * @param {{ taskId?: string; question: string; choices?: string[] }} ask
 * @returns {string}
 */
export function formatQuestion(ask) {
  let text = ask.question;
  if (ask.choices && ask.choices.length > 0) {
    text += '\n' + ask.choices.map((c, i) => `${i + 1}. ${c}`).join('\n');
  }
  return ask.taskId ? `[task ${ask.taskId}] ${text}` : text;
}

/**
 * @param {Record<string, unknown>} config
 */
function requireDiscordConfig(config) {
  if (typeof config.botToken !== 'string' || typeof config.channelId !== 'string') {
    throw new Error(
      'discord-surface: prompt() requires botToken and channelId under ' +
        "settings.plugins.<row-id> — see this plugin's README §Configure it.",
    );
  }
}

/**
 * STUB. Posting to Discord and reading a human's reply back both need real
 * network calls against real credentials this example does not have:
 *
 * 1. POST `https://discord.com/api/v10/channels/{channelId}/messages`
 *    (`Authorization: Bot <botToken>`, `{ content: formatQuestion(ask) }`)
 *    to post the question.
 * 2. Poll `GET https://discord.com/api/v10/channels/{channelId}/messages
 *    ?after=<posted message id>` for a message from a non-bot author, until
 *    some timeout elapses — returning `undefined` (the `SurfacePrompt`
 *    return type already allows "no answer") if nothing arrives in time.
 *
 * Left unimplemented here rather than shipped as untested "real" code that
 * would silently no-op (or fail confusingly) against anyone's actual
 * workspace. Wire this up for real before using this surface in a manifest
 * row — see README §Not implemented.
 *
 * @param {Record<string, unknown>} _config
 * @param {string} _question
 * @returns {Promise<string | undefined>}
 */
async function postAndAwaitReply(_config, _question) {
  throw new Error(
    'discord-surface: prompt() is a reference stub — implement postAndAwaitReply() against ' +
      "the Discord bot REST API before using this surface for real. See this plugin's README " +
      '§Not implemented.',
  );
}

/** @param {import('@octomux/plugin-api').PluginContext} ctx */
export async function apply(ctx) {
  ctx.surfaces.register({
    // Local id — octomux qualifies this to `<manifest-row-id>:discord`, e.g.
    // `discord:discord` for the manifest row this README uses.
    kind: 'discord',
    // Discord messages are markdown; unsupported renderers (stat, table, …)
    // degrade to a json code block via `fallback` (default, so omitted here).
    renderers: ['markdown', 'json'],
    render,
    async prompt(ask) {
      const config = await ctx.settings.get();
      requireDiscordConfig(config);
      const question = formatQuestion(ask);
      ctx.logger.info({ taskId: ask.taskId }, 'discord-surface: prompt() called');
      return postAndAwaitReply(config, question);
    },
  });

  ctx.logger.info({ pluginId: ctx.id }, 'octomux-plugin-discord-surface: apply() done');
}

// --- self-check -------------------------------------------------------
// ponytail: non-trivial branching logic (render's markdown/json split,
// formatQuestion's choice numbering) gets one runnable check. `bun
// docs/plugins/examples/discord-surface/index.mjs` runs it directly; nothing
// here executes on import via apply().
if (import.meta.main) {
  const assert = await import('node:assert');

  // render(): empty records → undefined, never a blank block.
  assert.strictEqual(render({ renderer: 'markdown', records: [] }), undefined);

  // render(): markdown renderer, scalar payload via declared `value` key.
  assert.strictEqual(
    render({
      renderer: 'markdown',
      title: 'Coverage',
      value: 'summary',
      records: [{ payload: { summary: '87% covered' } }],
    }),
    '**Coverage**\n87% covered',
  );

  // render(): json fallback — pretty-printed payload in a fenced code block.
  assert.strictEqual(
    render({ renderer: 'json', records: [{ payload: { pct: 42 } }] }),
    '```json\n' + JSON.stringify({ pct: 42 }, null, 2) + '\n```',
  );

  // formatQuestion(): choices numbered, taskId prefixed.
  assert.strictEqual(
    formatQuestion({ taskId: 't1', question: 'Ship it?', choices: ['Yes', 'No'] }),
    '[task t1] Ship it?\n1. Yes\n2. No',
  );

  // postAndAwaitReply() is a deliberate stub — it must refuse, not silently
  // succeed, until someone wires it up.
  let threw = false;
  try {
    await postAndAwaitReply({}, 'q');
  } catch {
    threw = true;
  }
  assert.strictEqual(threw, true);

  console.log('discord-surface self-check: ok');
}
