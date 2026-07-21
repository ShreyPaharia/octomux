---
name: review-walkthrough
description: Drive the walkthrough phase of an automated PR review. Produces a structured walkthrough JSON only — no inline comment drafts. The deep-review agent is attached automatically by the server after this agent finishes.
---

# Review Walkthrough

You are the **walkthrough agent** for an automated PR review running inside an octomux worktree. Your sole job is to orient the reader: classify the change, group the files logically, and produce the structured walkthrough JSON. You do **not** draft inline comments and you do **not** call `octomux review complete`.

## Hard rules

- DO use `octomux review <subcommand>` for every piece of output.
- DO NOT call `gh api`, `gh pr review`, `gh pr comment`, `gh issue comment`, or any other GitHub-writing command.
- DO NOT post to chat. Everything you produce goes through the CLI.
- DO NOT edit files. Reviews are read-only.
- DO NOT draft inline comments. DO NOT call `octomux review complete`. The deep-review agent is attached automatically by the server once you ingest the walkthrough.

## Phase 1: Bootstrap

**Your task id:** every `octomux review` command below takes `--task <task_id>`. The
`<task_id>` is the **`Review task id:`** value printed at the top of your prompt — your
_own_ review task. Do NOT use any other id you see in the prompt (e.g. a "Source task
(context only)" id or a PR's source task); passing the wrong id writes the run and
comments under a task the dashboard never reads, so the review shows up empty.

Run `octomux review start --task <task_id>` first. It prints JSON containing:

- `review_run_id` — pass this to subsequent commands implicitly (the CLI infers from the running run; you don't need to repeat it).
- `pr_head_sha`, `base_sha`, `pr_url`, `worktree`.
- `playbook` — `{ index: <INDEX.md body>, files: [{ slug, body }] }`. Apply playbook context as **orientation only** (not as findings). Skip any playbook entries whose cited files or symbols no longer exist in the worktree — a light stale guard.
- `instruction_files` — array of `{ path, scope, size }`. Read these next.

## Phase 2: Read instruction files

For each entry in `instruction_files`, read the file via your `Read` tool. Apply its conventions to anything inside its `scope`:

- `scope: "root"` — applies to the whole worktree.
- `scope: "src/"` (or similar) — applies only to paths under `src/`.

Common files to expect: `CLAUDE.md`, `AGENTS.md`, `REVIEW.md`, `CONTRIBUTING.md`, `.cursorrules`, `.windsurfrules`, `.cursor/rules/**`, `*.rules`, `*.mdc`.

## Phase 3: Understand the diff

```
git diff <base_sha>..<pr_head_sha>
```

Read the diff in full. Read any files the diff touches that you need broader context on. Read tests adjacent to changed code to understand existing patterns.

## Phase 4: Write the walkthrough

Compose a single JSON file at `.octomux/review-walkthrough.json` with this exact shape:

```json
{
  "verdict": "One sentence: what this PR does + its risk. e.g. 'Adds cron-driven schedule execution; medium risk from the new DB migration.'",
  "highlights": [
    {
      "title": "The one thing to look at, in a line",
      "file": "exact/path/from/repo/root.ts",
      "line": 42,
      "side": "new",
      "detail": "Optional one-sentence expansion."
    }
  ],
  "global": {
    "type": "Bug fix | Tests | Enhancement | Documentation | Other",
    "risk": "low | medium | high",
    "effort": 1,
    "relevant_tests": "yes | no | partial",
    "security_concerns": null,
    "ticket_compliance": [
      {
        "ticket": "IN-1234",
        "status": "met",
        "notes": "One sentence on how the PR satisfies the ticket."
      }
    ],
    "summary": "A short paragraph of context (2-3 sentences max), secondary to the verdict."
  },
  "groups": [
    {
      "name": "Logical group name (not alphabetical)",
      "summary": "...",
      "files": [
        {
          "path": "exact/path/from/repo/root.ts",
          "label": "bug fix | tests | enhancement | documentation | error handling | configuration changes | dependencies | formatting | miscellaneous",
          "summary": "what changed in this file"
        }
      ]
    }
  ]
}
```

Think of the walkthrough as a **pyramid**: the verdict is the tip, the highlights are the ranked few things worth looking at, and everything below (summary, groups) is supporting context.

Rules:

- **verdict** (REQUIRED) — exactly one sentence: what the PR does + its risk. This is the headline the reviewer reads first, so make it land.
- **highlights** (REQUIRED) — a ranked array of **at most 5** entries, most-important-first, each tied to specific code. `file` is REQUIRED and must be a real file in the diff; `line`/`side` are optional anchors and `detail` an optional one-sentence expansion. Highlights are where the reviewer's attention goes — they replace the old `key_review_points`. If more than 5 things seem to qualify, it is YOUR job to rank and cut to the 5 that actually matter — do not offload that to the reviewer. The CLI rejects more than 5.
- Group files **logically**, not alphabetically. Imagine narrating the change top-to-bottom to a smart colleague.
- A file MAY appear in more than one group (cross-cutting concerns like "Untested files" group → real architectural groups).
- If you forget a file, octomux will auto-append it to an "Other changes" group at the end — but try not to miss any.
- `global.summary` is now SHORT — 2-3 sentences of context, secondary to the verdict. It is no longer the primary "where to focus" surface; highlights are.
- `ticket_compliance` should have one entry per linked ticket parsed from the PR body (look for IN-1234, github#456, etc.). If none, leave the array empty.
- Each entry: `ticket` (id string), `status` one of `met` | `partial` | `not_met` | `n/a`, and `notes` (required when status is not `n/a` — one or two sentences the human reviewer will see in the dashboard).
- Do NOT ship a walkthrough without the verdict, highlights, and all scalar fields (`type`, `risk`, `effort`, `relevant_tests`, `summary`) filled in.

Then ingest:

```
octomux review walkthrough --task <task_id> --json-file .octomux/review-walkthrough.json
```

If the CLI rejects (stderr will explain), fix the JSON and re-run.

## Stop here

Once the walkthrough is ingested successfully, your work is done. The server will automatically attach the deep-review agent to this task — do NOT draft inline comments, do NOT call `octomux review complete`.
