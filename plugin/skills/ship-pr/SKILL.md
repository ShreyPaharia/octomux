---
name: ship-pr
description: Use to ship a change end-to-end from an octomux task — write a walkthrough, gate on a code review, open the PR, then monitor CI/comments and push fixes, finally refreshing the walkthrough. Heavier than create-pr; use when you want the full review→ship→watch loop, not just opening a PR.
---

# Ship a PR end-to-end (review-gated, self-monitoring)

Runs the whole path from a task branch to a green, monitored PR: walkthrough →
review gate → PR → monitor & fix → refresh walkthrough.

Use `create-pr` instead when you just want to open a PR with no review gate or
monitoring. This skill is the autonomous version.

## Steps

1. **Get the task context.** `octomux get-task <task-id>` → `branch`,
   `repo_path`, `base_branch` (default `main`), and the worktree path. The
   branch must already have commits.

2. **Write the walkthrough (its own step, NOT the PR body).**
   Produce a reviewer-facing walkthrough of the change and write it to
   `<worktree>/.octomux/pr-walkthrough.md`. Keep it structured:
   - **Intent** — what this change accomplishes and why.
   - **Change tour** — the meaningful files/areas grouped by theme, one line
     each on what changed and why (skip trivial/mechanical files).
   - **Risk & blast radius** — what could break, what to watch.
   - **Testing** — what was run / added and the evidence it passes.

   This artifact is deliberately separate from the PR description. Surfacing it
   in the dashboard PR **info tab** is a follow-up octomux code task; for now it
   just lives as this file so the review and monitoring steps can lean on it.

3. **Review gate — do NOT open the PR until this is green.**
   Attach a reviewer agent to the SAME task (see the `add-agent` skill) and have
   it run `/code-review` over the branch diff (working tree / `base_branch..HEAD`).
   Also make sure the repo's own checks pass locally first (tests / lint / build
   per `repo_configs`). Then:
   - Address every actionable finding with fixes committed to the branch.
   - Re-run the review until it comes back clean.
   - Only proceed once review is clean AND local checks are green.

4. **Open the PR.** Follow the `create-pr` skill exactly (walkthrough of What /
   Why / Testing in the PR body, user confirmation, `gh pr create`). The PR body
   is the normal create-pr body — the `.octomux/pr-walkthrough.md` artifact stays
   separate.

5. **Monitor and fix — you own this, no separate poller.** You implemented the
   change, so you monitor the PR yourself. You're a long-running agent; stay on
   it until the PR settles:
   - `gh pr checks <number> --watch` — wait for CI; if anything goes red, read
     the failing logs, fix on the branch, push, and re-watch.
   - `gh pr view <number> --comments` — read review/bot comments; push fixes for
     the actionable ones (don't argue with bots in the skill — just fix or note).
   - Repeat until checks are green and there are no unresolved actionable comments.

   If your turn ends and octomux later nudges you about a fresh failure or
   comment, resume and fix it — the PR is yours until it's merged. No poller or
   Ralph loop is needed; the implementing agent is the watcher.

6. **Refresh the walkthrough.** Once the PR is green, update
   `<worktree>/.octomux/pr-walkthrough.md` so it reflects the final state
   (fixes applied during review/monitoring, final testing evidence). Commit it.

7. **Report** — PR URL, review verdict, CI status, and the walkthrough path.
