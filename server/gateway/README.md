# Telegram gateway — setup & smoke test

The gateway lets you talk to octomux's conductor (the assistant brain) over a Telegram DM:
recall past decisions, ask about running work, and dispatch/monitor octomux tasks. It is
**reactive** (message → reply) and **opt-in** — it only starts when a bot token is configured.

> Design: [`spec/agent-gateway.md`](../../spec/agent-gateway.md). Plan: [`plans/2026-07-23-phase2-gateway.md`](../../plans/2026-07-23-phase2-gateway.md).

## Security model (read before enabling)

- **Owner allowlist — default deny.** An empty/missing allowlist denies everyone. Only the
  Telegram user ids you list can talk to the bot. This is the one control that cannot be skipped:
  the gateway runs inside octomux's loopback-trusted server, so an inbound message would otherwise
  inherit full internal trust.
- **Outward tools are read-only by credential, not by a code gate.** The assistant's only write
  capability is octomux's own coordination tools (create/dispatch tasks). If you attach outward MCP
  servers (GitHub, Linear, …), attach them with **read-scoped tokens** — see step 4. Actual PRs are
  produced by the worker agents the assistant dispatches, not by the assistant itself.
- **Outbound redaction.** Replies are scrubbed for secret shapes (tokens, keys, connection strings)
  before they leave the process — Telegram bot DMs are not E2E and persist on Telegram's servers.

## 1. Create a Telegram bot

1. DM [@BotFather](https://t.me/botfather) → `/newbot` → follow the prompts.
2. Copy the token it gives you (looks like `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxx`).

## 2. Find your numeric Telegram user id

DM [@userinfobot](https://t.me/userinfobot) (or similar) — it replies with your numeric id
(e.g. `555123456`). This is the id the allowlist checks (`message.from.id`), **not** your @handle.

## 3. Configure env and start

```bash
export OCTOMUX_GATEWAY_TELEGRAM_TOKEN="123456789:AAE...your-bot-token"
export OCTOMUX_GATEWAY_TELEGRAM_ALLOW="555123456"   # CSV of allowed numeric ids
# Optional: the repo the assistant's conductor operates from (defaults to cwd)
export OCTOMUX_GATEWAY_CWD="/path/to/your/repo"

octomux start
```

On boot you'll see `gateway: Telegram gateway started` in the logs. No token → the gateway stays
off and octomux runs normally.

The allowlist can also live in `~/.octomux/gateway-allowlist.json`:

```json
{ "telegram": ["555123456"], "slack": [] }
```

## 4. (Optional) Read-only outward MCP servers

To let the assistant **read** GitHub / Linear / etc., attach those MCP servers with **read-scoped
credentials**. The security guarantee is the credential, not a code gate — a read-only token
simply cannot write.

- **GitHub:** create a **fine-grained PAT** with **read-only** repo permissions (Contents: Read,
  Pull requests: Read, Issues: Read — no write). Run the GitHub MCP server with `--read-only` over
  stdio, passing that PAT. Attach it to the conductor via its `--mcp-config` (the same mechanism
  `writeOrchestratorMcpConfig` uses for the octomux server).
- **Linear / Notion / Slack / Jira:** attach the already-configured MCP servers with read-scoped
  API keys.

Keep write-capable tokens out of the gateway conductor's environment entirely.

## 5. Smoke test (manual — needs the real token)

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

## Not in v1

Slack (same `ChannelAdapter`, later) · the per-action approval button (v2) · proactive nudges
(fast-follow) · full streaming/rich rendering (v1.1).
