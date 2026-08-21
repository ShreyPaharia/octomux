# octomux-plugin-hello

A minimal, complete octomux plugin. Two capabilities, no build step:

- `index.mjs` registers an integration provider (`notify`) via `ctx.integrations.register`.
- `kinds/hello.json` adds a schedulable "Hello Session" kind — a plain preset file, no code.

## Install

```bash
npm install octomux-plugin-hello
```

(This example isn't published — for local testing, use an absolute path instead
of a package name, see below.)

## Add the manifest row

Add a row to `~/.octomux/octomux.yml` (create the file if it doesn't exist):

```yaml
plugins:
  - id: hello
    name: octomux-plugin-hello
```

For local development, point `name` at **this directory** (not `index.mjs`
directly) — no npm install required:

```yaml
plugins:
  - id: hello
    name: /absolute/path/to/docs/plugins/examples/hello-plugin
```

The loader `import()`s `name` as-is when it's absolute
(`server/plugins/loader.ts::resolveViaAnchor`); it resolves to `index.mjs` via
this directory's `package.json` `main` field the same way a real npm install
would. This relies on Bun's ESM resolver, which (unlike Node's) accepts a
directory import when a `package.json` `main` is present — octomux only runs
under Bun, so this is safe here, but don't assume it works under plain
`node --experimental-vm-modules` tooling.

`id` is the plugin's local namespace. Everything this plugin registers is
qualified under it — the `notify` integration kind becomes `hello:notify`, and
the `hello` preset kind becomes `hello:hello`.

## Restart and confirm

```bash
octomux start
octomux doctor
```

`doctor` reads the last boot's `LoadReport` (`~/.octomux/plugin-load-report.json`)
without needing a running server:

```
Loaded (1)
  ✓ hello (octomux-plugin-hello@1.0.0) — 2.1ms

Failed (0)
  none
```

If it's in `Failed` instead, the report line names the phase (`resolve` /
`import` / `apply`) and carries the plugin's own error message.

## Configure it

`hello:notify` is an integration provider, not a plugin-settings blob — it's
configured the same way `jira`/`linear` are, through the integrations API
(`server/routes/integrations.ts`), keyed by the **qualified** kind:

```bash
curl -X POST localhost:7777/api/integrations \
  -H 'content-type: application/json' \
  -d '{"kind":"hello:notify","name":"hello webhook","config":{"webhookUrl":"https://example.com/hook"}}'
```

The route runs this plugin's own `validate(config)` before persisting it, and
`kind: "hello:notify"` also shows up at `GET /api/integrations/providers` once
the plugin has loaded.

This is separate from `ctx.settings` (general plugin config, stored under
`settings.plugins.hello`, reached via `PATCH /api/settings` — see
`docs/plugins/README.md` §Settings). This example doesn't use `ctx.settings`.

## What the catalog log line shows

`apply()` also logs `ctx.catalog.list().map((e) => e.id)` — with just this
plugin installed that's `["core"]`, not `["hello", "core"]`: the loader only
marks a plugin mounted (what `ctx.catalog` reads) AFTER its `apply()`
returns, so a plugin never sees itself in the catalog from inside its own
`apply()`, only siblings that mounted earlier plus core. It does see itself
from a route handler or anything else that runs after `apply()` finishes.
See `docs/plugins/README.md` §Reading what is installed.
