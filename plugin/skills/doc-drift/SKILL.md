---
name: doc-drift
description: Use when running a scheduled doc-drift task — compare the repo's docs against its code, fix drift, and open a doc-fix PR directly via `gh`
---

# Doc drift

Compare a repo's documentation against its actual code on a schedule: find
docs that describe things that no longer exist, and notable code behavior
that's undocumented, then fix the docs and open a PR. This skill has **no
octomux sink** — you open the PR yourself with `gh`; nothing reads a
structured `emit` from this task.

A task maps to a single PR: octomux's PR-detection poller matches on this
task's own branch, so every doc fix you make this run goes into **one** PR,
as separate commits, opened from the branch octomux already checked out for
you. Do not create a separate `fix/...` branch.

## Steps

1. **Survey the documented surface.** Read `README.md`, `CLAUDE.md`, and
   files under `docs/` (if present). Note every command, config option,
   file path, env var, and API surface they claim exists.

2. **Compare against the code.** For each documented claim, check it still
   holds: does the command still exist (`package.json` scripts, CLI
   subcommands), does the file/path still exist, does the config option
   still get read, does the described behavior still match what the code
   does. Also look for notable code behavior with no documentation at all
   (a new script, a new env var, a new top-level directory) — flag it as
   drift too, not just stale docs.

3. **Fix what you find.** Make small, targeted doc edits — update stale
   claims, remove references to deleted things, add a line for undocumented
   surface that's clearly worth documenting. Do not restructure or rewrite
   docs wholesale; this is drift correction, not a docs overhaul.

4. **Open one doc-fix PR from this task's current branch** directly with
   `gh` — do not use any octomux sink or emit command for this workflow, and
   do not `git checkout -b` a new branch:

   ```bash
   # for each fix:
   git add -A && git commit -m "docs(<scope>): <description>"

   # after all fixes are committed, open (or reuse) exactly one PR:
   branch="$(git rev-parse --abbrev-ref HEAD)"
   git push -u origin "$branch"
   existing="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number')"
   if [ -z "$existing" ]; then
     gh pr create --title "docs: fix doc drift $(date +%F)" \
       --body "<one line per drift item found + fix applied>"
   fi
   ```

   Checking for an existing open PR on this branch first makes the step
   idempotent — later loop iterations push more commits and refine the same
   PR instead of creating duplicates. The PR body should summarize every
   drift item found, whether fixed or skipped.

   If nothing drifted, do **not** open a PR — write a short note (e.g. to
   your final message) saying no drift was found, and end your turn.

5. **Verify contract:** this task runs inside octomux's retry-loop (see the
   scheduling service that launched you). Each iteration re-runs the repo's
   configured verify command against your changes — make sure the fix you
   commit passes it before ending your turn. The loop iterates automatically
   on verify failure; you don't need to invoke verify yourself.

## Notes

- This is a scheduled, unattended run — be conservative. Prefer small,
  reviewable doc fixes over broad rewrites.
- Only fix drift you're confident about. If something is ambiguous (docs vs
  code disagree but it's unclear which is right), skip it and note it rather
  than guessing.
- Do not fabricate findings — if you find no drift, say so plainly instead
  of inventing something to fix.
