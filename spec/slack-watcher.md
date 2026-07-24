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
  confirmation" is v2 — **now specified below, §v2: click-to-send reply buttons**).
- Multi-user / multi-workspace. One owner, one workspace — same as the gateway.
- Real-time event push. 30-minute polling is the design point; the gateway remains the
  real-time reactive surface.
- Gmail/Calendar/Jira context — that stays in `daily-plan`.

## Architecture

Two halves. Slack credentials are **workspace-scoped**, and the watched workspace (the
company workspace where the owner's inbox lives) differs from the workspace the gateway
bot lives in (the owner's personal workspace). Installing a reader app on the company
workspace is not currently possible (admin approval), so v1 reads through the
**claude.ai Slack MCP connector**, which is already authorized on the watched workspace;
the conductor bot app in the personal workspace handles posting and the gateway.

1. **Proactive (new):** workflow kind `slack-watcher`, modeled on `overnight-log-summary`
   (headless session vertical, `surfaces: ['artifact']`, cron trigger, config + output
   schemas). Skill prompt shipped at `plugin/skills/slack-watcher/SKILL.md`, seeded into the
   `schedule_skills` table on first read like every other cron kind.
2. **Reactive (exists):** the gateways. The digest destination is configurable per
   schedule (`digestTarget`): the owner's **Telegram** chat (gateway already live), a
   **Slack DM** with the conductor bot, or a **Slack channel** in the bot's workspace.
   Telegram and Slack-DM destinations land in a conversation a gateway routes to the
   conductor, so replying to the digest just works; a channel destination is
   broadcast-only unless the bot is subscribed to `message.channels` there.

### Slack access

| Credential                             | Workspace             | Used for                                                                                      |
| -------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| claude.ai Slack MCP connector (exists) | **watched** (company) | All inbox reads: `slack_search_public_and_private`, `slack_read_thread`, `slack_read_channel` |
| `xoxb-` bot token (conductor app)      | **digest** (personal) | Posting the digest DM (`chat.postMessage`), opening the DM (`conversations.open`)             |
| `xapp-` app token (conductor app)      | digest (personal)     | Socket Mode (gateway)                                                                         |

**Known risk:** the claude.ai connector is interactively authenticated; its availability
inside headless cron sessions on this host is unverified. The skill must check for the
Slack MCP tools first and submit `outcome: 'blocked'` (with which tools were missing)
when absent — a blocked run on the feed is the signal, never a silent no-digest.

**Hardening path (v1.1, when installable):** a minimal reader app on the watched
workspace with read-only user scopes (`search:read`, `im:history`, `mpim:history`,
`channels:history`, `groups:history`) minting an `xoxp-` token in
`OCTOMUX_SLACK_USER_TOKEN`; the skill then reads via `curl` instead of MCP. Nothing else
in the design changes.

No new env vars in v1. The watcher reuses the gateway tokens for posting —
`OCTOMUX_GATEWAY_SLACK_BOT_TOKEN` for Slack destinations, `OCTOMUX_GATEWAY_TELEGRAM_TOKEN`
for Telegram: the headless session inherits the octomux server's environment
(`runSessionVertical` does no env plumbing), so the tokens are visible to the skill,
which posts with `curl`. Missing token for the configured target or missing Slack MCP
tools → the run submits `outcome: 'blocked'` with a reason instead of failing silently.

## Components

### `server/workflows/slack-watcher/index.ts`

Registers the kind. Shape mirrors `overnight-log-summary/index.ts`: `surfaces:
['artifact']`, `config: SLACK_WATCHER_CONFIG_SCHEMA`, `output: SLACK_WATCHER_SCHEMA`,
`trigger: { kind: 'cron' }`, fire-and-forget `run` with error logging. Imported from
`server/workflows/index.ts`.

### `server/workflows/slack-watcher/schema.ts`

```
SLACK_WATCHER_CONFIG_SCHEMA (drives the /schedules form — every field below is
user-editable in the UI, like the prompt body is via schedule_skills):
  slackUserId      string  — owner's member id in the WATCHED workspace; whose inbox to
                             search (member ids differ per workspace)
  digestTarget     enum    — 'telegram' | 'slack'; where the digest goes. Default 'slack'
  telegramChatId   string  — Telegram numeric chat id (same id as the gateway allowlist);
                             required when digestTarget = 'telegram'
  digestUserId     string  — owner's member id in the DIGEST (bot's) workspace; whom the
                             bot DMs. Same value as slackUserId in single-workspace setups
  lookbackMinutes  number  — default 40 (cron interval + overlap so gaps can't drop messages)
  digestChannel    string  — optional; Slack channel id for the digest (bot must be in the
                             channel). Default '' = open a DM with digestUserId via
                             conversations.open

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
2. Interpolates `{{slackUserId}}`, `{{digestTarget}}`, `{{telegramChatId}}`,
   `{{digestUserId}}`, `{{lookbackMinutes}}`, `{{digestChannel}}`, and
   `{{previousItems}}` — the `items` JSON from the most recent `done` run of this kind
   (via `listRunsForWorkflow('slack-watcher')`), `'[]'` when none. This is the dedup
   memory: the skill must not re-digest a thread already covered unless there are new
   messages in it.
3. `runSessionVertical({ kind: 'slack-watcher', scheduleId, workspaceDir: repoPath,
input: prompt, outputSchema: SLACK_WATCHER_SCHEMA, trigger })`. The Slack tokens reach
   the skill via inherited server env (see §Slack app tokens).

### `plugin/skills/slack-watcher/SKILL.md`

Headless, unattended session; only side effects are Slack MCP reads and (at most) one
bot-token `chat.postMessage`. Steps:

1. **Collect** (Slack MCP, watched workspace): first verify the Slack MCP tools are
   available — if not, submit `outcome: 'blocked'` naming the missing tools and stop.
   Then `slack_search_public_and_private` for `@`-mentions of `{{slackUserId}}` and DMs
   within the last `{{lookbackMinutes}}` minutes; `slack_read_thread` /
   `slack_read_channel` for context on hits. Skip messages authored by the owner, bot
   noise, and joins/leaves.
2. **Filter against `{{previousItems}}`** — drop threads already digested with no new
   messages since.
3. **Compose** — for each remaining item: who, where, what it's about in plain language, why
   it needs the owner, urgency, and a suggested reply. Order by urgency. Hard cap: digest
   ≤ 10 items, each ≤ 3 lines + reply. Replies must read like the owner dashed them off,
   not like an assistant wrote them; the skill carries explicit style rules (mirror the
   thread's tone and the owner's own voice in it, 1–2 sentences, contractions, plain
   words, a concrete next step over vague reassurance, and a banned-phrase list of AI
   tells — greetings/sign-offs, "it's worth noting", "I hope this helps", "delve",
   "seamless", "not just X but Y", etc.).
4. **Send** — switch on `{{digestTarget}}`. `telegram`: one Bot API `sendMessage` to
   `{{telegramChatId}}` with `OCTOMUX_GATEWAY_TELEGRAM_TOKEN`. `slack`: resolve the
   channel (`{{digestChannel}}` or `conversations.open` with `{{digestUserId}}`), one
   `chat.postMessage` with `OCTOMUX_GATEWAY_SLACK_BOT_TOKEN`.
   **If no items survive filtering, send nothing.**
5. **`submit_result`** matching `SLACK_WATCHER_SCHEMA`. Blocked tokens/API errors →
   `outcome: 'blocked'` with the reason in `summary`.

### Registry / prompt-store touchpoints

- `server/workflows/index.ts`: import `./slack-watcher/index.js`.
- `server/schedule-prompt.ts`: add `'slack-watcher'` to `CRON_PROMPT_KINDS` (not
  task-backed).
- `server/gateway/README.md`: the two-workspace model (MCP reads on the watched
  workspace, conductor bot posts on the personal one), the v1.1 reader-app hardening
  path, and move "proactive nudges" out of "Not in v1". The conductor manifest is
  untouched.

## Security

- Nothing in the watcher can write as the owner: reads go through the claude.ai Slack
  connector, posting only through the bot token in the personal workspace — consistent
  with the gateway's "read-only by credential, not code gate" model. The skill is
  additionally instructed to never call the connector's send/draft tools.
- The digest is posted by the skill itself (curl), so the gateway's server-side
  `redactSecrets` (`server/gateway/redact.ts`) cannot intercept it. The skill instead
  carries an explicit instruction: the digest must never contain token values, keys,
  connection strings, or other secret shapes — quote around them, not through them.
- Tokens live in env / `.env`, never in DB rows, config JSON, or `submit_result` payloads.

## Live setup (this devbox, after merge)

1. Create the conductor app in the owner's **personal** workspace from
   `slack-app-manifest.yaml` per the gateway README → `xoxb-` + `xapp-` tokens (only the
   Telegram gateway is live today).
2. Env: `OCTOMUX_GATEWAY_SLACK_BOT_TOKEN`, `OCTOMUX_GATEWAY_SLACK_APP_TOKEN`,
   `OCTOMUX_GATEWAY_SLACK_ALLOW=<owner member id in the personal workspace>`.
3. Verify the claude.ai Slack connector (watched workspace) is reachable from a headless
   session on this host — the first manual run doubles as this check; a `blocked` result
   naming missing tools means it is not, and the v1.1 reader app becomes the unblocker.
4. Verify the no-op Stop hook in `~/.claude/settings.json` (known gateway requirement —
   without it gateway replies buffer forever).
5. Create the schedule: kind `slack-watcher`, repo path, cron `*/30 3-18 * * *` (UTC ≈
   08:30–23:30 IST), config `{ slackUserId: <watched-workspace id>, digestTarget:
'telegram', telegramChatId: <numeric id> }` — or `digestTarget: 'slack'` with
   `digestUserId`/`digestChannel` once the conductor app exists. With the Telegram
   target, steps 1–2 (the Slack conductor app) can be deferred entirely.
6. Smoke: `POST /api/schedules/:id/run`, confirm digest DM arrives, reply to it, confirm the
   gateway conductor answers.

## Testing

Follow the per-workflow layout (`overnight-log-summary` as the template):

- `schema.test.ts` — config defaults applied; output schema accepts a full and a minimal
  (`digestSent: false`) payload.
- `run.test.ts` — mocks `runSessionVertical`: prompt interpolation (all seven placeholders)
  and previous-run items threading.
- `index.test.ts` — kind registered, cron-triggerable (`listCronWorkflowKinds` includes it).
- `registry.test.ts` untouched; `schedule-prompt` seed test extended for the new kind.
- Slack Web API is never called in tests; the skill's behavior is prompt-side and the
  live smoke test (§Live setup) covers the integration.

## v2: copyable replies + self-DM digest (buttons dropped)

v2 was first designed as click-to-send Block Kit buttons (see git history of this
section). During preflight the owner dropped the buttons in favour of copy-paste:
suggested replies are the owner's to send, copying is one tap, and no attribution
badge appears on anything colleagues see. Ad-hoc agent sends remain possible by asking
any connector-equipped Claude session directly (those show "Sent using @Claude" —
acceptable when explicitly requested).

What v2 ships instead:

- **`digestTarget: 'self-dm'`** — the digest goes to the owner's own self-DM in the
  **watched** workspace via the connector's `slack_send_message` (`channel_id` =
  `slackUserId`). This is the one sanctioned exception to the skill's no-connector-send
  rule: a single digest message, to the owner themselves, only. Digest and the threads
  it references live in the same workspace — copy, jump via permalink, paste, send.
- **One-tap-copyable replies** — every suggested reply is rendered in code formatting:
  inline code on Slack, `<code>` + `parse_mode=HTML` on Telegram (tap-to-copy on both).
- **Item bookkeeping** — items carry optional `replyChannel`/`replyTs` (dedup context
  and future use).
- **Dormant send vertical** — `slack-watcher-reply` (`send-reply.ts`: verbatim-send via
  the connector, feed-only kind, never cron-schedulable) is built and tested but has no
  caller. It becomes the send path if one-click ever returns — ideally re-pointed at an
  Ostium user-token app (badge-free) when app installs are approved there.

Verified during preflight: headless sessions CAN send via the connector (test message
landed cross-workspace from a headless run), and Block Kit buttons render fine — the
drop was a product choice, not a technical one. The gateway interactive listener and
click handler were never built; the Interactivity toggle on the conductor app is on but
unused (harmless).
