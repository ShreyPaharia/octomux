---
name: add-plugin
description: Use when installing, disabling, enabling, or troubleshooting a third-party octomux plugin — the manifest row shape, octomux plugins list/disable/enable, reading octomux doctor output, and recovering a broken boot with --safe-mode.
---

# Install and manage an octomux plugin

Plugins are npm packages listed in a manifest file (`octomux.yml`), loaded
in-process at boot. This skill covers the install/manage lifecycle from the
outside — for authoring a plugin, see `create-plugin`.

## Security posture — read this before installing anything

**A plugin runs in-process with full Node privileges. There is no sandbox.**
It gets the same DB handle, the same credentials, and the same `process.env` as
octomux itself. One line in a malicious `apply()` can flip
`OCTOMUX_CAPABILITY_GATE_ENABLED` and disable every human-approval gate for every
task launched afterward. Installing a plugin is equivalent to running its code —
treat `npm install`-level trust decisions (who published it, do you trust the
maintainer, has the tarball hash changed) as seriously as you would for any
dependency with production DB access, because that's what it has.

There is no plan to add an in-process containment boundary. The controls that
exist today:

- The manifest row schema (`server/plugins/manifest.ts`) has `version` and
  `integrity` fields for exact-pinning, but today only their **shape** is
  validated (both must be strings) — the loader does not fetch/verify a tarball
  hash against `integrity` before `import()`ing. Treat both as documentation for
  now, not an enforced guarantee.
- `octomux start --safe-mode` as the kill switch (see below).

There is no attribution trail today distinguishing a plugin-driven change from a
core one (e.g. a task row a plugin's workflow mutated looks identical in the event
log to one core mutated) — don't assume you can audit your way out of a bad
install after the fact.

## Where packages live

```
<prefix>/node_modules/<pkg>
```

`<prefix>` is `OCTOMUX_PLUGIN_PREFIX` if set, else `octomuxRoot()` (`~/.octomux`
in production, `./data` in dev). The manifest itself lives at
`OCTOMUX_PLUGIN_MANIFEST` if set, else `<prefix>/octomux.yml` — note these two are
independently overridable, so a plugin prefix and a manifest path don't have to
be siblings unless you leave both at their defaults.

## The manifest row shape

`octomux.yml`:

```yaml
plugins:
  - id: demo # bare, matches ^[a-z0-9][a-z0-9-]*$ — this is what your kinds/harnesses qualify under
    name: octomux-plugin-demo # npm package name, OR an absolute local path
    version: 1.0.0 # exact, not a range
    integrity: sha512-... # optional — shape-validated only; not yet enforced against the tarball (see below)
    config: {} # optional, opaque, passed through — not read by the loader itself
    disabled: false # optional — omit or false = enabled
    grants: [policy.intercept, facts.put] # optional — omit or [] = the plugin gets nothing
```

Only those seven keys are allowed on a row, and only `plugins` at the top level —
anything else fails to parse rather than being silently ignored. `name` must
resolve safely: an npm package name or an absolute path, never a relative path, a
URL scheme, or anything containing a NUL byte (`import()` natively resolves
`data:`/`http(s):`/`file:` URLs, so this is a real security boundary, not just a
shape check). YAML anchors/aliases (`&`/`*`) are rejected outright — a manifest
has no legitimate use for them and they're a known expansion-bomb vector.

## Reading `grants:` before you trust it

`grants` is the plugin author's claim about which `ctx` methods their code
calls — `workflows.register`, `integrations.register`, `harnesses.register`,
`http.route`, `facts.define`, `facts.put`, `ui.panel`, `policy.intercept`. It's
enforced (an undeclared call throws and the plugin fails to load), so the list
is accurate about what the plugin's `ctx` calls can do. It says nothing about
what the plugin's _other_ code can do — see "Security posture" above: no
grant list confines a plugin, because it runs in-process with full privileges
regardless of what it declares.

**`policy.intercept` is the one worth reading twice.** Every other grant is
additive — a plugin adds a workflow, a route, a fact. A plugin with
`policy.intercept` can register a hook on `task.launch`, `harness.resume`,
`review.publish`, or `integration.send` that denies the action outright or
silently rewrites data on its way through (patching `model`, `verdict`, or
`payload`). Read what the plugin's own docs say its hook does before granting
it — a deny you didn't expect looks like a hung or rejected task, not an
obvious plugin problem, and the fail-open contract means a _broken_ hook is
invisible (see `create-plugin` for the guarantees a hook author is held to).

A manifest row's grants only take effect after you've acknowledged them once
(see "Acknowledging grants" below) — adding `policy.intercept` to an existing
row's `grants:` list is not, by itself, enough to activate it.

## `octomux plugins list|disable|enable`

These edit `octomux.yml` directly and never contact a running server — the same
property `doctor` has, deliberately, since a plugin that broke boot is exactly the
case these need to keep working in.

```bash
octomux plugins list
octomux plugins disable demo
octomux plugins enable demo
```

`list` prints a table in a TTY; piped or scripted (non-TTY stdout), every octomux
CLI command auto-switches to JSON — so `octomux plugins list | cat` gives you
`{"manifestPath": "...", "plugins": [...]}` with no `--json` flag needed. `disable`
sets `disabled: true` on the row; `enable` removes the key entirely (not `false`).
Both round-trip the write through the same parser before committing it to disk —
if re-serializing would produce something the manifest reader can't parse back
(a real edge case with multi-line `config` values containing `&`/`*`), the write
is refused with the offending row named, rather than corrupting the manifest.

Both fail loudly (`No plugin with id "<id>" in <manifest path>`, exit 1) if the id
doesn't exist — check `octomux plugins list` first if you're not sure of the id.

## Reading `octomux doctor`

```bash
octomux doctor
```

Reads the load report persisted by the last boot
(`<octomuxRoot()>/plugin-load-report.json`) — again, no running server required.
Non-TTY output is JSON; in a terminal you get:

```
Manifest             /path/to/octomux.yml
Safe mode            off
Report file          /path/to/plugin-load-report.json
Report generated      unknown (older report)
Report file last modified  2026-08-16T...

Loaded (1)
  ✓ demo (octomux-plugin-demo@1.0.0) — 8.9ms
      grants: policy.intercept, facts.put
      ⚠ withheld (not acknowledged): ui.panel — run: octomux plugins approve demo

Failed (0)
  none
```

`grants` under each loaded row is the effective set that plugin got _this
boot_ — after the acknowledgement ledger, not just what `octomux.yml` says.
The `withheld` line lists anything the row newly declared that's still
pending acknowledgement; no line means nothing's waiting on you. A capability
missing from both is one the row never declared — check `octomux.yml`, not
`doctor`, for that. `octomux doctor --json` carries the same data as
`report.grants[id]` / `report.pendingGrants[id]`.

A row printed with `grants: none` declared nothing and can use no gated `ctx`
method; a report written by an older build omits the line entirely rather than
printing a misleading `none`.

A `Failed` row names the phase — `resolve` (couldn't find/require the package),
`import` (module loaded but threw or had no `apply()` export), or `apply` (threw
or timed out inside `apply()` itself) — plus the plugin's own error message,
verbatim. Trust that error message; it's the actual thrown text from the plugin's
code.

If `doctor` reports "No plugin load report … yet", octomux has never started
against that data dir — start it once first.

## Acknowledging widened grants

Editing `grants:` in `octomux.yml` to add a capability to an already-installed
plugin does not hand it over at the next boot. The set your ledger has already
acknowledged lives in `plugin-grants.json` next to the manifest; anything a
row declares beyond that is pending, and the registrar call it gates throws
(load-report `phase: 'apply'` failure) until you approve it:

```bash
octomux plugins approve demo
```

This is the one moment a widened grant — especially `policy.intercept` — is a
human decision rather than a config edit taking silent effect. A first-time
install skips this: the first time a row appears in the ledger, whatever it
declares is acknowledged automatically (you just added the row yourself).
Narrowing `grants:` (removing a capability) also takes effect immediately, no
approval needed — only widening is gated.

## Recovery when a plugin breaks boot

```bash
octomux start --safe-mode
```

Sets `OCTOMUX_SAFE_MODE=1` for that run. Every manifest plugin row is skipped —
no `resolve`/`import`/`apply` attempted for any of them — while core harnesses
(`claude-code`, `cursor`) and core integration providers still register, since
those are unconditional side effects of importing `harnesses/index.js` /
`integrations/index.js`, not manifest-driven. Boot comes up clean, you get a
working dashboard, and `octomux doctor` afterward will show `Safe mode: ON —
plugin rows skipped` with empty `Loaded`/`Failed` lists (nothing ran, so there's
nothing to report failing).

From there: `octomux plugins disable <id>` the plugin you suspect, then restart
without `--safe-mode` to confirm the rest load cleanly, or fix the plugin package
itself and retry.

## Notes

- A plugin id can never redefine a core harness id (`claude-code`, `cursor`) or an
  already-registered id from an earlier-loading plugin — the registry keeps the
  first registration and logs a warning rather than let a later plugin silently
  take over.
- See `configure-harness` for tuning a harness once it's loaded, and
  `create-plugin` for what a plugin author needs to get right before you ever
  install their package.
