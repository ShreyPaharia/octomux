# octomux-plugin-discord-surface

A reference `ctx.surfaces` provider: it registers a `discord` surface that
renders every `ctx.ui` panel already on a task as Discord-flavoured markdown,
and implements `prompt` — proving a plugin surface can ask a human a
question, which none of octomux's four core surfaces (`web`, `cli`, `slack`,
`telegram`) do yet.

It exists to be the reference every future surface (a real Slack/Telegram
replacement, a terminal UI, a phone push notifier) gets copied from, and to
be the honest first answer to "can a surface actually not be read-only?" —
see **Not implemented** below before you point this at a real workspace.

## What it does

- `render(panel)` — a pure text transform, **no network, no credentials**.
  Declares `renderers: ['markdown', 'json']`, so the host only ever calls it
  with `panel.renderer` equal to one of those two (anything this surface
  didn't declare — `stat`, `table`, `timeline`, `badge`, `diff`, `log` —
  resolves to the `json` fallback before `render` ever sees it; see the
  renderer-resolution table in
  [`api-reference.md` §`ctx.surfaces`](../../api-reference.md#ctxsurfaces)).
  Mirrors the same `value`/payload conventions the web client's own renderer
  registry uses (`src/workflows/renderers/index.tsx`) — same data, markdown
  text instead of JSX. Empty facts → `undefined`, so the caller omits the
  panel instead of showing a blank block.
- `formatQuestion(ask)` — turns a `SurfacePrompt` into the text this surface
  would post: the question, a numbered list of `choices` if present, and a
  `[task <id>]` prefix when the prompt is about a specific task. Pure, real,
  covered by the self-check.
- `prompt(ask)` — present (not omitted), so `ctx.surfaces.register` accepts
  this surface as **not read-only**. It reads `botToken`/`channelId` out of
  `ctx.settings`, builds the question via `formatQuestion`, and calls
  `postAndAwaitReply()` — which is a **deliberate stub** (see below), not
  tested or working code.

Zero new dependencies. `fetch` is a global; this example never calls it.

## Not implemented

`postAndAwaitReply()` in `index.mjs` **throws** instead of talking to
Discord. Actually closing the loop needs two real network calls this example
does not make:

1. `POST https://discord.com/api/v10/channels/{channelId}/messages`
   (`Authorization: Bot <botToken>`, body `{ content: formatQuestion(ask) }`)
   to post the question.
2. Poll `GET https://discord.com/api/v10/channels/{channelId}/messages
?after=<posted message id>` for a message from a non-bot author, until some
   timeout elapses — returning `undefined` on timeout, which
   `prompt`'s `Promise<string | undefined>` return type already allows for
   ("no answer").

That second step is also the part that needs the most real-world setup: a
Discord bot application, an invite with `View Channel` + `Read Message
History` (and the privileged `MESSAGE CONTENT` intent) on the target
channel, and a channel a human is actually watching. None of that is
something a docs example can fake convincingly, so this ships the stub
rather than untested "real" code that would silently no-op — or fail in a
confusing way — against your actual Discord server. **Do not point this
surface's `prompt` at a live manifest row until you've implemented
`postAndAwaitReply()` yourself.**

`render` has no such gap — it's pure and works exactly as shipped.

## Install

```bash
npm install octomux-plugin-discord-surface
```

(Not published — for local testing, point the manifest row's `name` at this
directory's **absolute path** instead, same as `hello-plugin`; see
[`../hello-plugin/README.md`](../hello-plugin/README.md) for why a directory
import works under Bun's ESM resolver.)

## Manifest row

```yaml
# ~/.octomux/octomux.yml
plugins:
  - id: discord
    name: /absolute/path/to/docs/plugins/examples/discord-surface
    grants: [surfaces.register]
```

`ctx.surfaces.register` requires the `surfaces.register` capability grant —
omit it and registration throws at boot, and the row lands in the load
report as an `apply`-phase failure naming this plugin and the capability
(`server/plugins/context.ts`, `server/plugins/grants.ts`).

This plugin registers `ctx.surfaces.register({ kind: 'discord', ... })` — a
**local** id. octomux qualifies it under the manifest row's own `id` before
it reaches the real surface registry (`qualify()`,
`server/plugins/qualify.ts`), so with the row above the surface is actually
registered as **`discord:discord`**. Core's four surfaces (`web`, `cli`,
`slack`, `telegram`) are frozen before any plugin loads and cannot be
redefined — that colon is what structurally prevents a plugin from squatting
one of them.

## Configure it

Settings live under `settings.plugins.discord` (scoped to this manifest
row's `id`, via `ctx.settings` — see
[`api-reference.md` §`ctx.settings`](../../api-reference.md) — not a
surface-specific config path, since `SurfaceDefinition` has no `configSchema`
field):

```json
// PATCH /api/settings body
{
  "plugins": {
    "discord": {
      "botToken": "${env:DISCORD_BOT_TOKEN}",
      "channelId": "123456789012345678"
    }
  }
}
```

`ctx.settings` does **not** do the `${env:VAR}` expansion `ctx.compute`'s
`secrets` sub-object gets (`computeConfigFor()`, `server/settings.ts`) — that
convention is specific to compute/integration secrets today. Until
`prompt()` is actually implemented, treat this config shape as illustrative:
it's what `requireDiscordConfig()` checks for, not a wired secrets path.

| Field       | Required for `prompt()` | Meaning                                          |
| ----------- | ----------------------- | ------------------------------------------------ |
| `botToken`  | yes                     | Discord bot token, `Authorization: Bot <token>`  |
| `channelId` | yes                     | channel id `postAndAwaitReply()` would post/poll |

`render` needs no config at all.

## Verified / not verified

**Verified** — the self-check at the bottom of `index.mjs`
(`bun docs/plugins/examples/discord-surface/index.mjs`):

- `render()` returns `undefined` for a panel with no records.
- `render()` with `renderer: 'markdown'` reads the declared `value` key and
  prefixes a `title` as a bold heading.
- `render()` with `renderer: 'json'` pretty-prints the latest record's payload
  in a fenced code block.
- `formatQuestion()` numbers `choices` and prefixes `[task <id>]`.
- `postAndAwaitReply()` throws — it is a stub, not silently a no-op.

**Not verified — this example does not and cannot exercise it:**

- That the documented Discord REST calls in **Not implemented** above are
  correct against a live Discord API (endpoint shape, auth header, rate
  limits, pagination on the message-poll).
- That `ctx.surfaces.register`'s host-side renderer resolution actually
  calls `render` with only `'markdown'`/`'json'` as documented — that's
  asserted by the host's own test suite (`server/surfaces/`), not by
  anything here.
- Real Discord bot setup: intents, channel permissions, rate limits, what
  happens with multiple simultaneous prompts on one channel.

## Trust model

Same as every other plugin — restated from the root `docs/plugins/README.md`
§Limits because it's easy to assume a "surface" plugin is somehow more
contained than a compute or integration one: it isn't. `apply()` and
`prompt()` run **in-process** on the octomux server, with the DB handle,
every other credential, and `process.env` all reachable from the same
process. The `surfaces.register` grant records that this plugin claims to
use `ctx.surfaces` and makes that claim reviewable (`octomux doctor`) — it
does not sandbox anything this plugin's code does, including a `botToken`
you configure for it.
