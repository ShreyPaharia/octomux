---
name: weekly-update
description: Use when running a scheduled weekly-update session — gather git commits and available Jira/Linear context for the past week, produce a themed status report, and submit it via submit_result
---

# Weekly Update

Generate a themed status report summarizing the past week's work for a repo:
pull git history, cross-reference tickets if available, group by theme, and
submit a structured result. This is a headless, unattended session — you do
not open a PR, edit files, or make any changes. Your only output is the
`submit_result` call.

## Steps

1. **Gather git commits for the past week** by running:

   ```bash
   git log --all --since="last monday" --until="tomorrow" --pretty=format:"%h %s (%ad)" --date=short
   ```

2. **Gather ticket context, if available.** If Jira or Linear tools are
   connected in this session, look up tickets referenced in commit messages
   (e.g. `IN-123`) or updated this week, and note their status. If no ticket
   tooling is available, skip this step — do not fabricate ticket data.

3. **Group commits by theme**, not by ticket or commit order — e.g.
   "Hedging Safety & Reliability", "Observability", "Infrastructure". Each
   theme gets a short title and a list of concise, bullet-point items (bold
   keyword, dash, short description, ticket id/status if known).

4. **Note highlights.** Anything that deserves top-line visibility beyond
   the themed breakdown — a release, a milestone, a notable metric. Keep
   each entry to one short sentence.

5. **Call the `submit_result` tool exactly once** with a JSON object shaped
   like:

   ```json
   {
     "outcome": "done",
     "summary": "<1-2 sentence overview of the week>",
     "period": "<the date range covered, e.g. Mon DD - DD>",
     "themes": [
       {
         "title": "Theme Name",
         "items": ["**Feature** — concise description (IN-123 — Done)"]
       }
     ],
     "highlights": ["..."],
     "links": [{ "label": "...", "url": "..." }]
   }
   ```

   `outcome` and `summary` are required: `outcome` is `"done"` for a normal
   report, `"blocked"` if you could not gather git history or ticket context
   at all. `links` is optional — omit it, or point to a published report if
   one exists.

## Notes

- Be conservative — this runs unattended with no human reviewing your
  reasoning, only the structured result.
- If there were no commits this week, say so plainly: an empty `themes`
  array and a `highlights` entry noting the quiet week. Do not fabricate
  activity.
- Do not modify any files, commit, or open a PR. This skill only reads git
  history and ticket context, then reports.
