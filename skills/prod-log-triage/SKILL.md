---
name: prod-log-triage
description: Use when running a scheduled prod-log-triage task — fetch production logs, group errors into classes, write an incident summary, and open one fix PR per error class directly via `gh`
---

# Prod log triage

Triage production logs for a repo on a schedule: fetch recent logs, group
recurring errors into distinct classes, record an incident summary, and open
one fix PR per error class. This skill has **no octomux sink** — you open PRs
yourself with `gh`; nothing reads a structured `emit` from this task.

## Steps

1. **Fetch recent prod logs** using the log command given in your prompt
   (e.g. `flyctl logs -a my-app`, `kubectl logs -l app=my-app --since=1h`,
   `gh run view --log`). Run it as-is — don't invent a different command.

2. **Group errors into distinct classes.** Cluster by stack trace signature,
   error message shape, or failing endpoint/job — not by raw log line. Ignore
   noise (expected 4xx, health-check timeouts) unless the prompt says
   otherwise.

3. **Write an incident summary** to `desk/incidents/<date>.md` (create the
   `desk/incidents/` directory if it doesn't exist), one section per error
   class:

   ```markdown
   # Incident triage — <date>

   ## <error class 1>

   - First seen / frequency
   - Representative log lines
   - Root-cause hypothesis
   - Fix: <one-line description> — see PR #<n>
   ```

4. **Open one fix PR per error class** directly with `gh` — do not use any
   octomux sink or emit command for this workflow:

   ```bash
   git checkout -b fix/<short-error-class>-<date>
   # make the fix
   git add -A && git commit -m "fix(<scope>): <description>"
   git push -u origin fix/<short-error-class>-<date>
   gh pr create --title "fix(<scope>): <description>" --body "<why + link to desk/incidents/<date>.md>"
   ```

   If a class has no clear fix (needs human judgement), skip the PR and note
   that in the incident summary instead of forcing a speculative change.

5. **Verify contract:** this task runs inside octomux's retry-loop (see the
   scheduling service that launched you). Each iteration re-runs the repo's
   configured verify command (tests/lint/typecheck) against your changes —
   make sure the fix you commit passes it before ending your turn. The loop
   iterates automatically on verify failure; you don't need to invoke verify
   yourself.

## Notes

- This is a scheduled, unattended run — be conservative. Prefer small,
  reviewable fixes over broad refactors.
- If no actionable errors are found, still write the incident summary (even
  if it just says "no new error classes since last run") and end your turn.
- Do not fabricate log data — if the log command fails or returns nothing,
  say so in the incident summary rather than inventing findings.
