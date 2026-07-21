---
name: prod-log-triage
description: Use when running a scheduled prod-log-triage task — fetch production logs, group errors into classes, write an incident summary, and open a fix PR directly via `gh`
---

# Prod log triage

Triage production logs for a repo on a schedule: fetch recent logs, group
recurring errors into distinct classes, record an incident summary, and open
a fix PR. This skill has **no octomux sink** — you open the PR yourself with
`gh`; nothing reads a structured `emit` from this task.

A task maps to a single PR: octomux's PR-detection poller matches on this
task's own branch, so every error class you fix this run goes into **one**
PR, as separate commits, opened from the branch octomux already checked out
for you. Do not create a separate `fix/...` branch per error class.

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

4. **Open one fix PR from this task's current branch** directly with `gh` —
   do not use any octomux sink or emit command for this workflow, and do not
   `git checkout -b` a new branch. Commit each error class's fix separately
   on the branch you're already on, then open a single PR:

   ```bash
   # for each fixable error class:
   git add -A && git commit -m "fix(<scope>): <description>"

   # after all fixes are committed, open (or reuse) exactly one PR:
   branch="$(git rev-parse --abbrev-ref HEAD)"
   git push -u origin "$branch"
   existing="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number')"
   if [ -z "$existing" ]; then
     gh pr create --title "fix: prod log triage <date>" \
       --body "<one section per error class fixed + link to desk/incidents/<date>.md>"
   fi
   ```

   Checking for an existing open PR on this branch first makes the step
   idempotent — later loop iterations push more commits and refine the same
   PR instead of creating duplicates. The incident summary should list every
   error class handled in this run, whether fixed (with a note that the fix
   is in this PR) or skipped.

   If a class has no clear fix (needs human judgement), skip fixing it and
   note that in the incident summary instead of forcing a speculative
   change.

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
