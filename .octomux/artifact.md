## What shipped

A named secret store. Encrypted at rest, **never returned by any read API**, referenced
by name from config, resolved only at egress, scrubbed from logs and run results.

| Piece               | Where                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Table + repository  | `server/db/schema.ts` (`secrets`), `server/repositories/secrets.ts`                                     |
| AES-256-GCM at rest | `server/secrets/crypto.ts` — key at `<octomuxRoot()>/secret.key` (0600), `OCTOMUX_SECRET_KEY` overrides |
| Store / resolution  | `server/secrets/store.ts` — `${secret:NAME}` walk, mirrors `${env:VAR}`                                 |
| Redaction           | `server/secrets/redact.ts` (zero imports, so `logger.ts` can use it)                                    |
| HTTP                | `server/routes/secrets.ts` — `GET /api/secrets` (metadata), `PUT`/`DELETE /api/secrets/:name`           |
| CLI                 | `octomux secrets list\|set\|rm` (`set --stdin`)                                                         |
| Plugin API          | `ctx.secrets.list()` ungated, `ctx.secrets.resolve()` gated on `secrets.read`                           |
| Form picker         | `secretRef: true` on a config schema property → `SchemaConfigForm.tsx` renders a picker                 |

## The invariants, and where they're enforced

1. **No value ever leaves over HTTP.** There is no `GET /api/secrets/:name`.
   `listSecretRows()` doesn't even `SELECT value_enc`, so the metadata path cannot leak
   a ciphertext through a careless spread. `getSecretValue()` is the single decrypt
   path — not on a route, not on `ctx`.
2. **Reference by name, resolve at the call that uses it.** `${secret:NAME}` is a
   literal in config. An unknown name **throws** (where `${env:}` degrades to `''`):
   sending an empty credential is a 401 three layers away.
3. **Two core egress points only** — `hook-dispatcher.ts` (integration config) and
   `compute/config.ts` (the `secrets` sub-object; `config` stays env-only because
   `config` is the half that can reach the agent).
4. **Deliberately NOT `prompt-interpolate.ts` / `resolveWorkflowConfig`.** Schedule
   config feeds the agent's prompt via `{{configKey}}`. Resolving there hands the
   credential to the agent — the exact failure this ticket exists to prevent.
5. **Redaction at one choke point per egress.** `logger.ts` wraps its destination
   streams with `withRedaction()`, so every `logger.*` line in the codebase is scrubbed
   without call sites knowing; `finishRun()` does the same for `result_json`.

## Judgement calls worth challenging

- **Encryption at rest with a local key file.** Out-of-scope said no KMS/envelope. A
  32-byte key next to the DB is ~40 lines of stdlib `crypto` and stops a copied
  `tasks.db` or a backup from being a credential dump. An attacker with the filesystem
  has both. Called that a fair trade for the ticket's title; disagree and it's one file
  to delete.
- **`${secret:NAME}` string wrapper over a schema-driven bare name.** Uniform
  substitution works at every use site with no schema in hand. Cost: the placeholder
  can reach a prompt as a literal (harmless — it's a name).
- **`hook-dispatcher` now fails closed.** The agent's first pass fell back to the
  unresolved config on a resolution error, i.e. posted the literal `${secret:X}` as a
  credential. Changed to log + skip the send. That is a behaviour change to the
  pre-existing catch, which previously also swallowed `${env:}` resolution failures.
- **`REDACT_MIN_LENGTH = 8`.** Below that, scrubbing every occurrence would wreck the
  logs. A 4-char secret that leaks was already a bad secret.

## Left out on purpose

- **No Settings UI for creating a secret** — the picker is populated by whatever the
  CLI or API wrote. CLI + picker was the tight scope; a Settings card is the obvious
  next increment.
- **No repository test for `server/repositories/secrets.ts`** — every one of its
  functions is exercised through `server/secrets/store.test.ts`. A second suite would
  restate the same assertions one layer down.
- Per-user scoping, rotation automation, an audit log of resolutions, and a broker so a
  plugin integration handler stops receiving cleartext (the pre-existing WAVE-3 gap).

## Verification

`bun run typecheck`, `bun run format:check`, `bun run lint` all clean.
`bun run test` — 3809 + 1308 + 231 pass, 0 fail.

## Summary

_Updated 2026-08-21 18:30:46_

Bash: cat > .octomux/artifact.md <<'MD' # SHR-277 — secrets: a store that is not a plaintext config…
