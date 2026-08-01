---
name: learnings-digest
description: Use when running a scheduled learnings-digest session — report what the agent_learnings store gained this week, what looks safe to prune, and whether seeding learnings is actually helping, then submit via submit_result
---

# Learnings digest

Weekly curation surface for the `agent_learnings` store (see the `learn`/`recall` skills for the
write/pull side). There is no per-add human gate on `octomux learn` — this digest is where a
human reviews what got saved, flags what to prune, and checks whether seeding learnings back into
prompts is measurably helping. This is a headless, unattended session — you do not edit files,
delete learnings, or open a PR. Your only output is the `submit_result` call.

## Steps

1. **Run the digest command** for this task's repo — don't invent a different one:

   ```bash
   octomux learnings-digest --repo <this task's repo path> --since 7
   ```

   `--since` is the lookback window in days (default 7 if omitted). If the command fails
   (missing `OCTOMUX_ACTION_BASE_URL`/`OCTOMUX_ACTION_TOKEN`, or a non-2xx response), stop and
   report `outcome: "blocked"` with the error text — do not fabricate a digest.

2. **Read the three sections** the command prints:
   - **Additions** — learnings written in the lookback window. Skim for anything vague,
     duplicated, or that reads like an instruction rather than an observed fact.
   - **Removal candidates** — two kinds, both flagged, neither deleted automatically:
     - learnings never used (`usage_count = 0`) since creation;
     - learnings an agent already soft-superseded via `octomux unlearn <id> --reason "..."` —
       these carry the agent's own stated reason it went stale, which is itself signal.
       A human reviews both lists and, if judged safe to remove, hard-deletes with
       `octomux learn-forget <id>` (or via the Settings panel). Superseded rows are already
       excluded from seeding/recall — hard-deleting them only reclaims storage, it does not
       change behavior.
   - **Benefit** — the verify-pass rate for loop iterations that had past learnings seeded into
     their prompt vs. ones that didn't, with the iteration counts (`seededN`/`unseededN`) behind
     each rate. Treat a rate computed from a small N as noise, not signal — call that out rather
     than overstating it.

3. **Call the `submit_result` tool exactly once** with a JSON object shaped like:

   ```json
   {
     "outcome": "done",
     "repo": "<repo path>",
     "sinceDays": 7,
     "summary": "<2-4 sentence overview>",
     "additionsCount": 0,
     "removalCandidates": ["<id> — <lesson>, unused since <created_at>"],
     "benefit": {
       "seededPassRate": 0.0,
       "unseededPassRate": 0.0,
       "seededN": 0,
       "unseededN": 0
     },
     "links": [{ "label": "...", "url": "..." }]
   }
   ```

   `outcome` is required: `"done"` for a normal digest, `"blocked"` if the command failed and you
   could not compute one. `links` is optional. `removalCandidates` mirrors the digest's
   "Removal candidates" section verbatim (or an empty array if there were none) — do not decide
   to delete anything yourself.

## Notes

- Be conservative — this runs unattended with no human reviewing your reasoning, only the
  structured result.
- If there were no additions and no removal candidates this period, say so plainly in `summary`
  — do not fabricate activity.
- A human reviews `removalCandidates` and deletes learnings by hand (via the Settings panel or
  direct API) after reading this digest — this skill only flags, never deletes.
- Do not modify any files, commit, or open a PR. This skill only reads the learnings store and
  reports.

## See also

- `learn` skill — the write path this digest curates.
- `recall` skill — the on-demand pull side.
