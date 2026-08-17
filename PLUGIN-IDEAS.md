# Plugin ideas

A curated list of plugins someone could build against octomux's plugin API today. Every idea
here is grounded in what `packages/plugin-api/src/index.ts` and the three registrars
(`ctx.workflows`, `ctx.integrations`, `ctx.harnesses`) can actually do right now — not a
wishlist for API surface that doesn't exist. See `docs/plugins/README.md` for the authoring
guide and `docs/plugins/api-reference.md` for the full `PluginContext` shape before starting
any of these.

Ordered easiest to hardest. Difficulty assumes you've read the authoring guide once.

## Good first plugins — kinds only, no `apply()` at all

A "kind" is a JSON preset for octomux's existing scheduled-session engine — a cron trigger, a
prompt, and a config form. Ship `kinds/<name>.json` (same shape as the built-in files in
`<repo>/kinds/`) in a package named `octomux-kind-<name>`, list it in `octomux.yml`, and it
shows up in the UI. No `apply()` export, no `@octomux/plugin-api` import, no server code —
`server/workflows/presets.ts` scans `<pkg>/kinds/` for any package the manifest names.

1. **`octomux-kind-changelog`** — nightly job that diffs commits since the last run and drafts
   a changelog entry, opened as a small PR. This is the worked example the plugin plan itself
   names as the flagship demand test — genuinely useful and about as small as a plugin gets.
   **Registrar:** kinds tier (no registrar). **Effort:** an afternoon — mostly writing the
   prompt. **Good first issue.**

2. **`octomux-kind-dependency-audit`** — weekly `npm outdated` / `bun outdated` (config-selected)
   run that opens an issue or PR summarizing what's behind and what's a breaking major bump.
   **Registrar:** kinds tier. **Effort:** an afternoon. **Good first issue.**

3. **`octomux-kind-stale-branch-report`** — weekly report of branches with no commits in N days
   (config field), posted as a task summary. Useful on any repo with more than a couple of
   active contributors. **Registrar:** kinds tier. **Effort:** an afternoon. **Good first
   issue.**

## Integrations — react to task lifecycle events

`ctx.integrations.register()` needs `kind`, `displayName`, `configSchema`, `events` (which of
`workflow_status_changed | summary_updated | note_added | ref_added | ref_removed |
task_created | runtime_state_changed` it reacts to), `validate(config)`, and
`handler(envelope, config)`. This direction is **outbound only** — octomux tells the external
system something happened; there's no inbound poller seam for pulling status back in, so don't
pitch an idea that needs octomux to watch an external system for changes.

4. **`octomux-plugin-webhook`** — generic outbound webhook: POST the hook envelope to a
   configured URL with an optional HMAC signature header. This is the integration every other
   chat/notification tool can be built from without a real dependency — Zapier, n8n, a Google
   Chat space, anything that accepts a webhook. **Registrar:** integrations. **Effort:** a day.
   **Good first issue.**

5. **`octomux-plugin-discord`** — Discord webhook notifications on `task_created` and
   `workflow_status_changed`, formatted as embeds. Same shape as the built-in Slack gateway but
   for Discord, which a lot of smaller teams and OSS projects actually run on. **Registrar:**
   integrations. **Effort:** a day. **Good first issue.**

6. **`octomux-plugin-teams`** — Microsoft Teams incoming-webhook notifications, same events as
   above. Valuable for the enterprise slice of the audience the built-in Slack/Telegram gateways
   don't reach. **Registrar:** integrations. **Effort:** a day.

7. **`octomux-plugin-pagerduty`** — fires a PagerDuty Events API v2 alert on
   `runtime_state_changed` transitions into `error`, so an unattended loop or schedule that dies
   overnight pages someone instead of sitting quietly in the board. **Registrar:** integrations.
   **Effort:** a day.

8. **`octomux-plugin-github-issues`** — mirrors `workflow_status_changed` onto a linked GitHub
   Issue (comment + label update) the way the built-in Jira/Linear providers mirror it onto
   their own trackers. Good template to point at for "how do I add tracker #3" since it can
   copy `server/integrations/linear/index.ts`'s shape closely. One-directional like every
   integration here — it posts to GitHub, it doesn't read GitHub back. **Registrar:**
   integrations. **Effort:** two or three days (status-map config UX is the fiddly part).

9. **`octomux-plugin-shortcut`** (or Height, or Asana — pick one) — a fourth issue-tracker
   provider for teams that aren't on Jira or Linear. Same shape as #8, different API client.
   **Registrar:** integrations. **Effort:** two or three days.

## Workflows — custom `run()` logic, not just a prompt

`ctx.workflows.register()` takes a full `WorkflowType`: `kind`, `displayName`, `surfaces`,
optional `config`/`output` JSON Schema, and a `run(ctx: RunContext)` you write yourself. Reach
for this instead of a kind when the job needs real code — API calls, parsing, git plumbing — not
just an agent following a prompt.

10. **`octomux-plugin-cost-report`** — weekly `run()` that queries the task/worker tables for
    token spend (already tracked for loops) and posts a per-repo cost summary. Nobody currently
    aggregates loop token spend across time; this is a real gap. **Registrar:** workflows.
    **Effort:** two or three days.

11. **`octomux-plugin-pr-size-report`** — `run()` that shells out to `gh pr list` weekly and
    flags PRs that have sat open past a size/age threshold, as a nudge report rather than an
    agent action. **Registrar:** workflows. **Effort:** a couple of days.

12. **`octomux-plugin-dependency-upgrade-bot`** — `run()` that does real git plumbing (branch,
    bump, install, run the test command, commit, open a PR) rather than delegating the whole
    thing to an agent prompt — closer to Dependabot/Renovate behavior than a `doc-drift`-style
    kind. **Registrar:** workflows. **Effort:** three to five days.

13. **`octomux-plugin-security-scan`** — scheduled `run()` wrapping `npm audit` /
    `osv-scanner` / `gh code-scanning-alert list`, parsing structured output (not just handing
    a shell command to an LLM) and filing findings as review comments or a summary. **Registrar:**
    workflows. **Effort:** three to five days.

## Harnesses — hardest, and the least finished corner of the API today

`ctx.harnesses.register()` requires all of `newSessionId`, `buildLaunchCommand`,
`buildResumeCommand`, `buildContinueCommand`, `installHooks`, `uninstallHooks`, `resolveFlags`,
`validateSettings`. Two things to know before starting: command builders return a **shell
command string** today, not an argv array, so you own escaping and injection-safety yourself;
and `supportsClaudePlugins` / `buildPromptDelivery` / `attachMcp` / `sendMessage` /
`detectActivity` exist on the `Harness` type but nothing calls them yet — implement the eight
required members, treat the rest as reserved. `server/harnesses/claude-code.ts` and `cursor.ts`
are the reference implementations; read both before starting.

14. **`octomux-harness-aider`** — [Aider](https://aider.chat) backend. Aider's own session
    resumption model (chat history files) maps reasonably onto `sessionIdMode:
'harness-issued'`. **Registrar:** harnesses. **Effort:** a week+.

15. **`octomux-harness-codex`** — OpenAI's Codex CLI backend. Same shape of work as #14 with a
    different session model to reverse-engineer. **Registrar:** harnesses. **Effort:** a week+.

16. **`octomux-harness-gemini-cli`** — Google's Gemini CLI backend. **Registrar:** harnesses.
    **Effort:** a week+.

17. **`octomux-harness-openhands`** — [OpenHands](https://github.com/All-Hands-AI/OpenHands)
    backend; likely the most different session/sandbox model of the four, so the most work to
    map onto octomux's worktree-per-task assumption. **Registrar:** harnesses. **Effort:**
    a week+, probably the hardest entry on this list.

## Built

Nothing published yet — be the first. Open a PR against this file adding a row here (package
name, one line describing it, npm/GitHub link) once your plugin is published. See
`CONTRIBUTING.md`'s "Contributing a plugin" section for the review bar.
