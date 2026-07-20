---
description: Use when running a scheduled overnight-log-summary session — fetch overnight logs, cluster errors, and submit a structured summary via submit_result
---

# Overnight log summary

Summarize what happened overnight for a repo: fetch recent logs, cluster
errors into classes, note anything else notable, and submit a structured
result. This is a headless, unattended session — you do not open a PR, edit
files, or make any changes. Your only output is the `submit_result` call.

## Steps

1. **Fetch overnight logs** by running this command as-is — don't invent a
   different one:

   ```
   {{logCommand}}
   ```

2. **Cluster errors into classes.** Group by stack trace signature, error
   message shape, or failing endpoint/job — not by raw log line. For each
   class, note a short name, how many times it occurred, and a severity
   (`low`, `medium`, or `high`) based on how disruptive it looks.

3. **Note notable events.** Anything else worth a human's attention that
   isn't an error class — a deploy, a restart, an unusual spike, a config
   change. Keep each entry to one short sentence.

4. **Call the `submit_result` tool exactly once** with a JSON object shaped
   like:

   ```json
   {
     "outcome": "done",
     "window": "<the time window you summarized, e.g. last 12h>",
     "summary": "<2-4 sentence overview>",
     "errorClasses": [{ "name": "...", "count": 0, "severity": "low" }],
     "notableEvents": ["..."],
     "links": [{ "label": "...", "url": "..." }]
   }
   ```

   `outcome` is required: `"done"` for a normal summary, `"blocked"` if you
   could not fetch the logs at all, `"failed"` only if something about the
   summarization itself broke. `links` is optional — omit it, or point to a
   dashboard/incident file if one is relevant.

## Notes

- Be conservative — this runs unattended with no human reviewing your
  reasoning, only the structured result.
- If the log command returns no output or nothing of note, say so plainly in
  `summary` (e.g. "No errors overnight.") with empty `errorClasses` and
  `notableEvents` arrays — do not fabricate findings.
- Do not modify any files, commit, or open a PR. This skill only reads logs
  and reports.
