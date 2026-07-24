# Gateway — setup & smoke test

The gateway lets you talk to octomux's conductor (the assistant brain) over a chat DM —
**Telegram** or **Slack**: recall past decisions, ask about running work, and dispatch/monitor
octomux tasks. It is **reactive** (message → reply) and **opt-in per channel** — each one only
starts when its own tokens are configured. You can enable either, both, or neither.

> Design: [`spec/agent-gateway.md`](../../spec/agent-gateway.md). Plan: [`plans/2026-07-23-phase2-gateway.md`](../../plans/2026-07-23-phase2-gateway.md).

## Security model (read before enabling)

- **Owner allowlist — default deny.** An empty/missing allowlist denies everyone, on every
  channel. Only the Telegram/Slack user ids you list can talk to the bot. This is the one control
  that cannot be skipped: the gateway runs inside octomux's loopback-trusted server, so an inbound
  message would otherwise inherit full internal trust.
- **Outward tools are read-only by credential, not by a code gate.** The assistant's only write
  capability is octomux's own coordination tools (create/dispatch tasks). If you attach outward MCP
  servers (GitHub, Linear, …), attach them with **read-scoped tokens** — see
  [Read-only outward MCP servers](#optional-read-only-outward-mcp-servers). Actual PRs are
  produced by the worker agents the assistant dispatches, not by the assistant itself.
- **Outbound redaction.** Replies are scrubbed for secret shapes (tokens, keys, connection strings)
  before they leave the process — neither Telegram bot DMs nor Slack DMs are E2E, and both persist
  on the provider's servers.

## Telegram

### 1. Create a Telegram bot

1. DM [@BotFather](https://t.me/botfather) → `/newbot` → follow the prompts.
2. Copy the token it gives you (looks like `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxx`).

### 2. Find your numeric Telegram user id

DM [@userinfobot](https://t.me/userinfobot) (or similar) — it replies with your numeric id
(e.g. `555123456`). This is the id the allowlist checks (`message.from.id`), **not** your @handle.

### 3. Configure env and start

Put these in a `.env` in the directory you launch octomux from (it's auto-loaded at boot), or
export them into the environment:

```bash
OCTOMUX_GATEWAY_TELEGRAM_TOKEN=123456789:AAE...your-bot-token
OCTOMUX_GATEWAY_TELEGRAM_ALLOW=555123456   # CSV of allowed numeric ids
OCTOMUX_GATEWAY_CWD=/path/to/your/repo     # optional: conductor's working repo (defaults to cwd)
```

Then `octomux start`. On boot you'll see `gateway: Telegram gateway started` in the logs. No token →
the gateway stays off and octomux runs normally. (Real exported env vars win over `.env`.)

The allowlist can also live in `~/.octomux/gateway-allowlist.json`:

```json
{ "telegram": ["555123456"], "slack": [] }
```

### 4. Smoke test (manual — needs the real token)

1. `octomux start` with the env from step 3.
2. From your **allowlisted** Telegram account, DM the bot: _"what tasks are running?"_ → you should
   get a reply within a few seconds (a typing indicator first).
3. Ask it to **recall**: _"what did we decide about X?"_ → it should call `search_learnings`.
4. Ask it to **dispatch**: _"start a task to do Y"_ → it should create an octomux task (watch the
   dashboard at http://localhost:7777).
5. From a **different, non-allowlisted** account, DM the bot → it must be **silently ignored** (no
   reply; the log shows `sender not on allowlist — denied`).

Record the result here once run:

| Date | Reply on allowed DM? | Non-allowlisted DM ignored? | Notes |
| ---- | -------------------- | --------------------------- | ----- |
|      |                      |                             |       |

## Slack

Transport is **Slack Socket Mode** — an outbound websocket the bot opens to Slack. That means:

- **No public webhook URL, no ngrok, no Events API request URL to configure.**
- **No signing secret.** Signing-secret verification only applies to Slack's HTTP Events API,
  which this gateway does not use — you won't find (and don't need) that field here, even though
  Slack's own docs point you at it for other integration types.
- **No typing indicator.** Unlike Telegram, Slack has no reliable bot typing indicator via the Web
  API, so you won't see one while the conductor is working — just wait for the reply.

Replies land in the same DM/channel the message came from (not threaded under the original
message).

### 1. Create a Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App**. Fastest path: **From an
app manifest** → pick your workspace → paste [`slack-app-manifest.yaml`](./slack-app-manifest.yaml)
(it pre-fills Socket Mode, bot scopes, and the message events, so you can skip steps 2–3's clicking).
Otherwise pick **From scratch** and do steps 2–3 by hand.

> No workspace admin? App creation and the `xapp-` token need none, but **installing** the bot
> (step 4, which mints the `xoxb-` token) can require admin approval on a corporate workspace. A free
> [developer sandbox](https://api.slack.com/developer-program) or your own free workspace makes you
> admin — create/install the app there and DM the bot from that workspace.

### 2. Enable Socket Mode and create the app-level token

**Settings → Socket Mode** → toggle it on. This prompts you to create an app-level token —
give it the **`connections:write`** scope. Copy the token (starts with `xapp-`).

### 3. Add bot scopes and subscribe to events

**Features → OAuth & Permissions → Scopes → Bot Token Scopes**, add:

- `chat:write` (required — posting replies)
- `im:history` (required — reading DMs)
- `channels:history` (optional — reading messages in channels the bot is in)

**Features → Event Subscriptions → Subscribe to bot events**, add:

- `message.im` (required — DMs)
- `message.channels` (optional — channel messages)

### 4. Install the app to your workspace

**Settings → Install App** → Install to Workspace → authorize. Copy the **Bot User OAuth Token**
(starts with `xoxb-`) from the same page.

Also enable DMs: **Features → App Home → Show Tabs → Messages Tab** on, and check **"Allow users to
send Slash commands and messages from the messages tab."** Without this, Slack does not deliver
`message.im` events even with the right scopes.

### 5. Find your Slack member id

Slack profile → **⋯** → **Copy member ID**. It looks like `U01ABCDEF` — this is the id the
allowlist checks, **not** your @handle or display name.

### 6. Configure env and start

```bash
OCTOMUX_GATEWAY_SLACK_BOT_TOKEN=xoxb-your-bot-token
OCTOMUX_GATEWAY_SLACK_APP_TOKEN=xapp-your-app-level-token
OCTOMUX_GATEWAY_SLACK_ALLOW=U01ABCDEF        # CSV of allowed Slack user ids
OCTOMUX_GATEWAY_CWD=/path/to/your/repo       # optional: conductor's working repo (defaults to cwd)
```

Then `octomux start`. On boot you'll see `gateway: Slack gateway started` in the logs. No tokens →
the gateway stays off and octomux runs normally. (Real exported env vars win over `.env`.)

The allowlist can also live in `~/.octomux/gateway-allowlist.json`:

```json
{ "telegram": [], "slack": ["U01ABCDEF"] }
```

### 7. DM the bot / smoke test (manual — needs real tokens)

1. `octomux start` with the env from step 6.
2. In Slack, open a DM with the bot (invite it if needed) from your **allowlisted** account:
   _"what tasks are running?"_ → you should get a reply within a few seconds (no typing indicator —
   see above).
3. Ask it to **recall**: _"what did we decide about X?"_ → it should call `search_learnings`.
4. Ask it to **dispatch**: _"start a task to do Y"_ → it should create an octomux task (watch the
   dashboard at http://localhost:7777).
5. From a **different, non-allowlisted** Slack account, DM the bot → it must be **silently
   ignored** (no reply; the log shows `not on allowlist — denied`).

Record the result here once run:

| Date | Reply on allowed DM? | Non-allowlisted DM ignored? | Notes |
| ---- | -------------------- | --------------------------- | ----- |
|      |                      |                             |       |

## Slack watcher (proactive digest)

The `slack-watcher` scheduled workflow (spec: [`spec/slack-watcher.md`](../../spec/slack-watcher.md))
scans the **owner's** inbox on a cron and has this same bot DM a concise digest with
suggested replies. Reads and writes are split across workspaces:

- **Inbox reads** happen in the _watched_ workspace through the claude.ai Slack MCP
  connector the headless session inherits — no app install in that workspace. If the
  connector is unavailable in headless runs, watcher runs land as `blocked` on the
  /runs feed naming the missing tools.
- **Digest posting** goes to the destination picked in the schedule config
  (`digestTarget`): the owner's **Telegram** chat via `OCTOMUX_GATEWAY_TELEGRAM_TOKEN`,
  or a **Slack DM/channel** in the bot's own workspace via
  `OCTOMUX_GATEWAY_SLACK_BOT_TOKEN` — no extra env vars either way. Telegram and
  Slack-DM digests land in a gateway conversation, so replying to the digest reaches
  the conductor.

Create the schedule at `/schedules` (kind **Slack Watcher**, cron e.g.
`*/30 3-18 * * *` — cron is UTC). All knobs are in the schedule form: `slackUserId`
(watched workspace — whose inbox), `digestTarget` + `telegramChatId` or
`digestUserId`/`digestChannel` (where the digest goes). The prompt itself is editable
per kind in the UI (schedule skills — the shipped SKILL.md is only the seed).

Hardening (v1.1, once the watched workspace allows an app install): a minimal
user-scopes-only reader app (`search:read`, `im:history`, `mpim:history`,
`channels:history`, `groups:history`) minting a read-only `xoxp-` token in
`OCTOMUX_SLACK_USER_TOKEN` replaces the MCP dependency.

## (Optional) Read-only outward MCP servers

To let the assistant **read** GitHub / Linear / etc., attach those MCP servers with **read-scoped
credentials**. The security guarantee is the credential, not a code gate — a read-only token
simply cannot write. This applies regardless of which channel(s) you enable.

- **GitHub:** create a **fine-grained PAT** with **read-only** repo permissions (Contents: Read,
  Pull requests: Read, Issues: Read — no write). Run the GitHub MCP server with `--read-only` over
  stdio, passing that PAT. Attach it to the conductor via its `--mcp-config` (the same mechanism
  `writeOrchestratorMcpConfig` uses for the octomux server).
- **Linear / Notion / Slack / Jira:** attach the already-configured MCP servers with read-scoped
  API keys.

Keep write-capable tokens out of the gateway conductor's environment entirely.

## Not in v1

The per-action approval button (v2) · full streaming/rich rendering (v1.1). Proactive
nudges shipped as the `slack-watcher` scheduled workflow — see above.
