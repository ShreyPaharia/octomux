---
name: learn
description: Use when you notice something durable and evidenced while working an octomux loop/scheduled task — a fix, a gotcha, a convention you had to discover the hard way — and want to save it via `octomux learn` for future runs.
---

# Record a learning

Save a durable, evidenced lesson for future runs on this repo/task via the `octomux learn` CLI.
There is no per-add human gate — what you write here goes straight into the pool that gets
seeded into future prompts, so the bar is on you.

## When to use

- You just fixed something that wasn't obvious from the code alone (a flaky mock, a required
  env var, a gotcha in a build step, a convention you only found by trial and error).
- You're about to end your turn and you have context (your _reasoning_, not just the outcome)
  that the transcript will not carry forward — the next fresh-context iteration only sees the
  prompt, not your chain of thought.

## The schema

```bash
octomux learn --trigger "<when this applies>" --lesson "<the durable fact or action>" \
  --evidence "<file / command / error that proves it>" [--private]
```

- `--trigger` — the situation this applies to (so a future run knows when to recall it).
- `--lesson` — the durable fact or action itself. State it as something actionable, not a vague
  reminder.
- `--evidence` — the file path, command, or error text that backs it up. **No evidence, no
  save** — if you can't point at something concrete, it isn't a learning yet, it's a guess.
- `--private` — use for a quirk specific to _this job_ (a one-off env, a task-specific
  workaround). Omit it (shared, repo-general) for anything a different task in this repo would
  also benefit from.

## The bar: save the _why_, not just the _what_

The transcript is gone once your context resets. The lesson is your only chance to hand your
reasoning forward — write it like you're leaving a note for an agent with none of your context.

**Good** (durable, evidenced, actionable):

- "When `bun test` hangs on `launch.test.ts`, the fs mock needs `default: mocked` — server/task-engine/setup"
- "The hedging retry lives in server/retry.ts; jitter was missing and caused thundering-herd retries under load — server/retry.ts:42"

**Bad** (vague, no evidence, not a lesson):

- "remember to run tests"
- "fixed a bug"

If your lesson could apply to any repo, or has no file/command/error backing it, don't save it.

## Shared vs private

- **Shared (default)** — repo-general facts any task in this repo benefits from: conventions,
  recurring gotchas, how a shared test helper works.
- **`--private`** — job-specific quirks that only matter to this particular scheduled job or
  loop (e.g. "this task's fixture data assumes UTC").

## When a prior learning is now false: `unlearn`, don't pile up

`learn` is add-only — it never edits or removes an existing row. If a seeded note (you'll see it
prefixed `[<id>]` in your prompt, or in `recall` output) turns out to be wrong or stale, retire it
instead of leaving a contradicting note sitting next to it:

```bash
octomux unlearn <id> --reason "<why it's no longer true>"
```

This is a soft, reversible supersede (the row stays, just filtered out of future reads/seeding) —
not a delete. "Updating" a learning is `unlearn` the old one + `learn` the new one, never an
in-place edit. Hard deletion (`octomux learn-forget <id>`) stays a human/digest-side action.

## See also

- `recall` skill — pull past learnings before assuming you're the first to hit something.
