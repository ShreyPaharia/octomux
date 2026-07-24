---
name: slack-watcher
description: Use when running a scheduled slack-watcher session — scan the owner's Slack inbox for new messages that need them, DM a concise digest with suggested replies via the bot, and submit a structured result via submit_result
---

# Slack watcher

Scan the owner's Slack inbox for the last {{lookbackMinutes}} minutes and, only if
something needs them, send one concise digest to the configured destination. This is a
headless, unattended session — you do not edit files, commit, or open PRs. Your only
side effects are Slack MCP reads, at most one outbound digest message, and one
`submit_result` call.

The owner's member id in the **watched** workspace is `{{slackUserId}}` (use it for all
inbox searches). Their member id in the **bot's** workspace is `{{digestUserId}}` (use
it only to open the digest DM) — the two workspaces may differ, so never mix the ids up.
The digest destination is `{{digestTarget}}`.

## Slack access

Reads and writes use **different credentials in different workspaces** — never mix them:

- **Inbox reads (watched workspace):** your Slack MCP connector tools —
  `slack_search_public_and_private`, `slack_read_thread`, `slack_read_channel`,
  `slack_search_users`. The connector's send/draft/canvas tools are off-limits, with
  exactly one exception: when `{{digestTarget}}` is `self-dm`, you send the single
  digest message to the owner's own self-DM with `slack_send_message`.
- **Posting the digest** (`slack` / `telegram` targets): via `curl`, using the env
  token — `OCTOMUX_GATEWAY_SLACK_BOT_TOKEN` (xoxb-, bot's workspace) for `slack`,
  `OCTOMUX_GATEWAY_TELEGRAM_TOKEN` for `telegram`.

Whatever the target, the digest is the only message you ever send. Before anything
else, confirm the Slack MCP tools are available. If they are not, or the token/tool for
`{{digestTarget}}` is missing, or an API call fails with an auth error: do not retry
endlessly — call `submit_result` with `outcome: "blocked"`, name exactly what was
missing or the exact error string in `summary`, and stop.

## Steps

1. **Compute the window.** `SINCE=$(date -d "-{{lookbackMinutes}} minutes" +%s)`
   (GNU date — on a macOS host use `date -v -{{lookbackMinutes}}M +%s` instead) —
   only messages with `ts >= $SINCE` count.

2. **Collect candidates** with the Slack MCP tools (watched workspace):
   - Mentions: `slack_search_public_and_private` with a query for `<@{{slackUserId}}>`,
     newest first.
   - DMs to the owner: the same search tool with an `is:dm` query (and `is:mpim` for
     group DMs).
   - Keep only hits inside the window, then pull thread context with
     `slack_read_thread` (or nearby channel history with `slack_read_channel`) so you
     understand what is actually being asked. Use `slack_search_users` to resolve
     display names when a hit only gives you a user id.
   - For every candidate you keep, record where a reply would go: the watched-workspace
     channel id and the thread ts (the root message's ts for a thread, the message's own
     ts otherwise). These become the item's `replyChannel` / `replyTs`.

3. **Filter ruthlessly.** Drop: messages authored by `{{slackUserId}}`; bot and app
   messages; joins/leaves and other channel noise; FYI-only chatter with no question
   or request directed at the owner; and anything already covered by a previous
   digest — the items below were already reported, so skip their threads unless a
   **new** message arrived after the window they were reported in:

   ```json
   {{previousItems}}
   ```

4. **Compose the digest** — natural, human, concise. For each item (max 10, ordered
   by urgency): who and where, what it's about in plain language, and a suggested
   reply the owner can copy with one tap — so the reply always goes in **code
   formatting** (inline code on Slack, `<code>` on Telegram), never quotation marks.
   Format (Slack mrkdwn shown):

   ```
   *Slack digest — <n> things need you*

   1. *Priya · #deploys* — blocked on the staging deploy config, asking if she
      should wait for your chart fix.
      ↳ `use the staging override for now, I'll land the chart fix tomorrow morning`
   ```

   **Suggested replies must sound like the owner dashed them off, not like an
   assistant wrote them.** Rules:
   - Before writing a reply, look at the owner's own messages in that thread or
     channel (they're in the context you already fetched) and mirror how they write
     there: formality, capitalization, emoji or none, greeting or none.
   - 1–2 sentences. Contractions. Plain words. Answer the actual question; when
     relevant, give a concrete next step or time ("I'll look after standup") instead
     of vague reassurance.
   - Banned: greetings and sign-offs the thread doesn't use, "I hope this helps",
     "it's worth noting", "thanks for reaching out", "absolutely!", "great question",
     "delve", "seamless", "robust", "leverage", "furthermore", and "it's not just X,
     it's Y" constructions. If a reply reads like a support ticket response, rewrite
     it shorter.
   - Vary the shape between replies — identical sentence patterns across items is an
     assistant tell.

   Never include token values, API keys, connection strings, or other secret shapes
   in the digest — refer to them ("the staging token") without quoting them.

5. **Send it** — only if at least one item survived filtering, and only to the
   `{{digestTarget}}` destination:
   - `self-dm`: one `slack_send_message` connector call with
     `channel_id: {{slackUserId}}` (a member id as channel = that user's self-DM).
     Use standard markdown; keep each suggested reply in inline code so it is
     one-tap copyable. Include each item's `permalink` so the owner can jump
     straight to the thread they're replying to.
   - `telegram`: one
     `curl -s -X POST "https://api.telegram.org/bot$OCTOMUX_GATEWAY_TELEGRAM_TOKEN/sendMessage" -d "chat_id={{telegramChatId}}" -d "parse_mode=HTML" --data-urlencode "text=<digest>"`
     — HTML-escape the digest (`&`, `<`, `>`), bold with `<b>…</b>`, and wrap each
     suggested reply in `<code>…</code>` (tap-to-copy on Telegram).
   - `slack`: resolve the digest channel — `{{digestChannel}}` if non-empty, otherwise
     `curl -s -X POST https://slack.com/api/conversations.open -H "Authorization: Bearer $OCTOMUX_GATEWAY_SLACK_BOT_TOKEN" -d "users={{digestUserId}}"`
     and take `.channel.id` — then one
     `curl -s -X POST https://slack.com/api/chat.postMessage -H "Authorization: Bearer $OCTOMUX_GATEWAY_SLACK_BOT_TOKEN" -d "channel=<channel id>" --data-urlencode "text=<digest>"`
     (mrkdwn as composed — replies stay in inline code).

   **Zero items → send nothing.** Silence is the correct output for a quiet window.

6. **Call `submit_result` exactly once** with:

   ```json
   {
     "outcome": "done",
     "window": "<e.g. last 40 minutes>",
     "summary": "<one line: '3 items need attention' or 'nothing needs attention'>",
     "digestSent": true,
     "items": [
       {
         "channel": "#deploys",
         "from": "Priya",
         "about": "Blocked on the staging deploy config",
         "urgency": "high",
         "suggestedReply": "Use the staging override for now — I'll land the chart fix tomorrow morning.",
         "permalink": "https://…",
         "replyChannel": "D0ASZE1MVJS",
         "replyTs": "1784893312.104219"
       }
     ]
   }
   ```

   `items` must list everything you digested this run (it becomes the next run's
   dedup memory), and be `[]` with `digestSent: false` on a quiet window.
   `outcome`: `"done"` normally, `"blocked"` for token/auth problems, `"failed"`
   only if composing/sending itself broke.

## Notes

- Be conservative — this runs unattended. When unsure whether something needs the
  owner, prefer including it at `low` urgency over silently dropping it.
- Never send any message other than the single digest, and never reply into anyone
  else's thread or DM — the one permitted connector send is the `self-dm` digest to
  the owner themselves. Do not look for workarounds.
- Suggested replies are suggestions. The owner copies and sends them; you never do.
  (`replyChannel` / `replyTs` in items are bookkeeping for dedup and future use.)
