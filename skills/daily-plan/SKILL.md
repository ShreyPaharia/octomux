---
description: Use when running a scheduled daily-plan session — pull Slack, Gmail, and Calendar context plus repo/Jira work, draft replies where warranted, propose the day's todos, and hand off to the user
---

# Daily Plan

Prep the user's day, then hand off. This is an interactive session: you do
the prep work unattended, then stop and wait for the user to join and steer.

## Steps

1. **Pull Slack, Gmail, and Calendar context** using your own connectors.
   Look for anything that needs attention: unread DMs/mentions, unanswered
   emails, and today's meetings. Summarize what needs attention across all
   three, grouped by urgency, not by source.

2. **Draft replies where warranted — draft only, NEVER send.** For messages
   or emails that clearly need a response, prepare a draft reply the user
   can review and send themselves. Never call a send action. If a channel's
   drafting API doesn't exist, note the suggested reply text in the plan
   instead.

3. **Pull repo and Jira context.** Check for anything assigned to the user
   that's due, blocked, or newly commented on — open PRs awaiting review,
   failing CI on the user's branches, tickets in progress.

4. **Propose the day's todos.** Combine everything above into a single
   prioritized todo list. Complete the trivial ones yourself as you go (e.g.
   closing a stale PR, archiving a dead notification) — note what you did
   and why.

5. **Present the finalized todos and wait.** Show the user the plan: what
   needs their attention, what you drafted, what you already completed, and
   the remaining todos. Then stop and wait for the user to join the session
   and steer — do not keep working autonomously past this point.

## Notes

- Never send a message, email, or reply on the user's behalf — draft only.
- If a connector (Slack/Gmail/Calendar/Jira) isn't available, say so plainly
  in the plan and skip it — do not fabricate its contents.
- Keep the finalized plan concise enough to scan in under a minute.
