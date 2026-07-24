# Slack Watcher — proactive inbox digest over the gateway

A cron-scheduled, headless workflow that reads the owner's Slack inbox (DMs, mentions,
active threads), and — only when something needs them — has the gateway bot DM a concise,
natural-language digest with ready-to-paste suggested replies. The digest lands in the same
bot DM the Slack gateway (`server/gateway/`) already listens on, so the owner can reply
conversationally ("expand #2", "draft a longer reply to Priya") and the conductor acts.

This is the "proactive nudges" fast-follow named in `server/gateway/README.md` §"Not in v1",
built as a standard workflow kind rather than gateway-internal code.

## Goals

- Every ~30 minutes during waking hours, surface new Slack messages that need the owner:
  direct DMs, @-mentions, and replies in threads the owner participates in.
- Digest is concise natural human language — what it's about, why it matters, and a
  suggested reply the owner can paste as-is. No digest when nothing needs attention.
- Suggested replies are text in the digest. The agent **never sends as the owner**
  (same draft-only rule as `daily-plan`).
- Reuse: schedules/cron poller, `runSessionVertical`, the workflow registry, the gateway
  bot + DM channel, the schedule-skills DB prompt store.

## Non-goals (v1)

- Sending replies as the owner (no user-scoped `chat:write`; "reply-as-me with gateway
  confirmation" is v2).
- Multi-user / multi-workspace. One owner, one workspace — same as the gateway.
- Real-time event push. 30-minute polling is the design point; the gateway remains the
  real-time reactive surface.
- Gmail/Calendar/Jira context — that stays in `daily-plan`.

## Architecture

Two halves sharing one Slack app:

1. **Proactive (new):** workflow kind `slack-watcher`, modeled on `overnight-log-summary`
   (headless session vertical, `surfaces: ['artifact']`, cron trigger, config + output
   schemas). Skill prompt shipped at `plugin/skills/slack-watcher/SKILL.md`, seeded into the
   `schedule_skills` table on first read like every other cron kind.
2. **Reactive (exists):** the Slack gateway (Socket Mode). The digest is posted into the
   owner's DM with the bot, which is exactly the conversation the gateway routes to the
   conductor.

### Slack app tokens

| Token | Holder | Used for |
| ----- | ------ | -------- |
| `xoxb-` bot token (exists) | gateway + watcher | Posting the digest DM (`chat.postMessage`), opening the DM (`conversations.open`) |
| `xapp-` app token (exists) | gateway | Socket Mode |
| `xoxp-` user token (**new**) | watcher only | Reading the owner's inbox |

New **user** scopes added to `server/gateway/slack-app-manifest.yaml` under
`oauth_config.scopes.user`: `search:read`, `im:history`, `mpim:history`,
`channels:history`, `groups:history`. All read-only — the user token cannot post.
Reinstalling the app mints the `xoxp-` token.

New env vars (loaded like the gateway's, documented in `server/gateway/README.md`):

```bash
OCTOMUX_SLACK_USER_TOKEN=xoxp-...   # read-only user token; watcher inbox reads
```

The watcher reuses `OCTOMUX_GATEWAY_SLACK_BOT_TOKEN` for posting. The headless session
inherits the octomux server's environment (`runSessionVertical` does no env plumbing), so
both tokens are visible to the skill, which calls the Slack Web API with `curl`. If either
token is missing, the run submits `outcome: 'blocked'` with a reason instead of failing
silently.

## Components

### `server/workflows/slack-watcher/index.ts`

Registers the kind. Shape mirrors `overnight-log-summary/index.ts`: `surfaces:
['artifact']`, `config: SLACK_WATCHER_CONFIG_SCHEMA`, `output: SLACK_WATCHER_SCHEMA`,
`trigger: { kind: 'cron' }`, fire-and-forget `run` with error logging. Imported from
`server/workflows/index.ts`.

### `server/workflows/slack-watcher/schema.ts`

```
SLACK_WATCHER_CONFIG_SCHEMA (drives the /schedules form):
  slackUserId      string  — owner's member id (e.g. U0A798PTVD1); whose inbox to watch
  lookbackMinutes  number  — default 40 (cron interval + overlap so gaps can't drop messages)
  digestChannel    string  — optional; channel id for the digest. Default '' = open a DM
                             with slackUserId via conversations.open

SLACK_WATCHER_SCHEMA (submit_result payload; envelope per spec/workflow-consolidation.md §5):
  outcome     'done' | 'blocked' | 'failed'
  window      string  — human description of the window scanned
  summary     string  — one-line: "3 items need you" / "nothing needs attention"
  digestSent  boolean — false when there was nothing to send
  items[]     { channel, from, about, urgency: 'low'|'medium'|'high',
                suggestedReply?, permalink? }
  links[]     { label, url }
```

### `server/workflows/slack-watcher/run.ts`

Mirrors `overnight-log-summary/run.ts`:

1. `resolveSchedulePrompt({ scheduleId, kind: 'slack-watcher' })` → DB skill body.
2. Interpolates `{{slackUserId}}`, `{{lookbackMinutes}}`, `{{digestChannel}}`, and
   `{{previousItems}}` — the `items` JSON from the most recent `done` run of this kind
   (via `listRunsForWorkflow('slack-watcher')`), `'[]'` when none. This is the dedup
   memory: the skill must not re-digest a thread already covered unless there are new
   messages in it.
3. `runSessionVertical({ kind: 'slack-watcher', scheduleId, workspaceDir: repoPath,
   input: prompt, outputSchema: SLACK_WATCHER_SCHEMA, trigger })`. The Slack tokens reach
   the skill via inherited server env (see §Slack app tokens).

### `plugin/skills/slack-watcher/SKILL.md`

Headless, unattended session; only side effects are Slack Web API reads and (at most) one
`chat.postMessage`. Steps:

1. **Collect** (user token): `search.messages` for `to:@{{slackUserId}}`-style DM search and
   `@`-mention search within the last `{{lookbackMinutes}}` minutes; `conversations.history`
   / `conversations.replies` for context on hits. Skip messages authored by the owner, bot
   noise, and joins/leaves.
2. **Filter against `{{previousItems}}`** — drop threads already digested with no new
   messages since.
3. **Compose** — for each remaining item: who, where, what it's about in plain language, why
   it needs the owner, urgency, and a suggested reply written in the owner's voice: short,
   direct, no corporate filler. Order by urgency. Hard cap: digest ≤ 10 items, each ≤ 3
   lines + reply.
4. **Send** (bot token): resolve the digest channel (`{{digestChannel}}` or
   `conversations.open` with `{{slackUserId}}`), one `chat.postMessage` with the digest.
   **If no items survive filtering, send nothing.**
5. **`submit_result`** matching `SLACK_WATCHER_SCHEMA`. Blocked tokens/API errors →
   `outcome: 'blocked'` with the reason in `summary`.

### Registry / prompt-store touchpoints

- `server/workflows/index.ts`: import `./slack-watcher/index.js`.
- `server/schedule-prompt.ts`: add `'slack-watcher'` to `CRON_PROMPT_KINDS` (not
  task-backed).
- `server/gateway/slack-app-manifest.yaml`: user scopes block.
- `server/gateway/README.md`: user-token setup + `OCTOMUX_SLACK_USER_TOKEN`, and move
  "proactive nudges" out of "Not in v1".

## Security

- User token is **read-only by scope** — consistent with the gateway's "read-only by
  credential, not code gate" model. No user-scoped `chat:write` anywhere.
- The digest is posted by the skill itself (curl), so the gateway's server-side
  `redactSecrets` (`server/gateway/redact.ts`) cannot intercept it. The skill instead
  carries an explicit instruction: the digest must never contain token values, keys,
  connection strings, or other secret shapes — quote around them, not through them.
- Tokens live in env / `.env`, never in DB rows, config JSON, or `submit_result` payloads.

## Live setup (this devbox, after merge)

1. Update the Slack app from the amended manifest; reinstall → mints `xoxp-`, keeps
   `xoxb-`/`xapp-`.
2. Env: existing gateway vars + `OCTOMUX_GATEWAY_SLACK_ALLOW=<owner member id>` +
   `OCTOMUX_SLACK_USER_TOKEN`.
3. Verify the no-op Stop hook in `~/.claude/settings.json` (known gateway requirement —
   without it gateway replies buffer forever).
4. Create the schedule: kind `slack-watcher`, repo path, cron `*/30 3-18 * * *` (UTC ≈
   08:30–23:30 IST), config `{ slackUserId: <owner id> }`.
5. Smoke: `POST /api/schedules/:id/run`, confirm digest DM arrives, reply to it, confirm the
   gateway conductor answers.

## Testing

Follow the per-workflow layout (`overnight-log-summary` as the template):

- `schema.test.ts` — config defaults applied; output schema accepts a full and a minimal
  (`digestSent: false`) payload.
- `run.test.ts` — mocks `runSessionVertical`: prompt interpolation (all four placeholders),
  previous-run items threading, token env injection, blocked path when tokens missing.
- `index.test.ts` — kind registered, cron-triggerable (`listCronWorkflowKinds` includes it).
- `registry.test.ts` untouched; `schedule-prompt` seed test extended for the new kind.
- Slack Web API is never called in tests; the skill's behavior is prompt-side and the
  live smoke test (§Live setup) covers the integration.
