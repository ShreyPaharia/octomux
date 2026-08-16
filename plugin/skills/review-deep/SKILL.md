---
name: review-deep
description: Drive the deep-review phase of an automated PR review. Consumes the walkthrough, runs the deterministic deep-review workflow (parallel lenses → adversarial validation → code-enforced threshold/caps), drafts the surviving findings, and completes the review run.
---

# Review Deep

You are the **deep-review agent** for an automated PR review running inside an octomux worktree. The walkthrough agent has already run and ingested a structured walkthrough. Your job is to use that walkthrough as orientation, run the deep-review findings engine (a workflow), draft the surviving inline comments, and complete the review run.

## Hard rules

- DO use `octomux review <subcommand>` for every piece of output (check-previous, draft-comment, complete).
- DO NOT call `gh api`, `gh pr review`, `gh pr comment`, `gh issue comment`, or any other GitHub-writing command.
- DO NOT post to chat. Everything you produce goes through the CLI.
- DO NOT edit files. Reviews are read-only.
- DO NOT re-derive the walkthrough — consume the one returned by `start`.

## Phase 1: Bootstrap

**Your task id:** every `octomux review` command below takes `--task <task_id>`. The
`<task_id>` is the **`Review task id:`** value printed at the top of your prompt — your
_own_ review task. Do NOT use any other id you see in the prompt (e.g. a "Source task
(context only)" id or a PR's source task); passing the wrong id writes the run and
comments under a task the dashboard never reads, so the review shows up empty.

Run `octomux review start --task <task_id>` first. It prints JSON containing:

- `review_run_id` — pass this to subsequent commands implicitly (the CLI infers from the running run; you don't need to repeat it).
- `pr_head_sha`, `base_sha`, `base_branch`, `pr_url`, `worktree`.
- `walkthrough` — the structured walkthrough the walkthrough agent already ingested. Do NOT re-derive it; use it directly as orientation.
- `playbook` — `{ index: <INDEX.md body>, files: [{ slug, body }] }`. Project-level review orientation. Pass it to the engine; skip any entry whose cited files/symbols no longer exist (a light stale guard).
- `learnings` — array of `{ id, why }` the human has told you in the past. Apply them ruthlessly: do NOT re-flag anything a learning says is intentional.
- `previous_review` — null on first review; otherwise the previously published review's head_sha, verdict, walkthrough, and `comments[]` (id, file_path, line, side, body, severity, bucket, kind).
- `carry_forward` — drafts/accepted comments from prior runs that survived auto-staleness; consider them while you draft (do not duplicate).

## Phase 2 (re-reviews only): Verify previous published comments

If `previous_review` is non-null, for each entry in `previous_review.comments`, decide whether it still applies at the new head:

- `resolved` — the author fixed it.
- `still_applies` — same issue is still present.
- `partial` — author addressed some of it but not all.
- `unclear` — you can't tell.

Run for each:

```
octomux review check-previous --comment <id> --status resolved|still_applies|partial|unclear [--reflag-body "<text>"]
```

For `still_applies`, ALWAYS pass `--reflag-body` with a fresh restatement — the next published review needs to surface it again so the author gets a notification. For `resolved` and `partial`, do not pass `--reflag-body`.

## Phase 3: Run the deep-review engine (workflow)

The findings engine is a **deterministic workflow** that fans out the review lenses in parallel, runs an adversarial skeptic on every candidate, and enforces the confidence threshold, caps, and composition guard **in code** (so the rules can't be skipped or forgotten). Run it via the **Workflow tool** — do NOT orchestrate the lenses by hand. Running it from inside this session is what makes its lens agents inherit **this worktree** as their cwd, so they review the right PR.

Invoke it with the values from `start` and the walkthrough:

```
Workflow({
  scriptPath: "<your $HOME>/.claude/workflows/review-deep.js",
  args: {
    worktree:        <start.worktree>,
    baseSha:         <start.base_sha>,
    baseBranch:      <start.base_branch>,           // lets the engine diff the true PR scope
    headSha:         <start.pr_head_sha>,
    risk:            <walkthrough.global.risk>,      // "low" | "medium" | "high"
    keyReviewPoints: <walkthrough.highlights mapped to their `title` strings>,
    groups:          <names from walkthrough.groups>,
    playbook:        <start.playbook as a single string: index + each file body>,
    learnings:       <start.learnings mapped to their `why` strings>,
  }
})
```

It returns:

```
{ threshold, risk, counts, findings: [ { file, line, severity, kind, category, lens, confidence, body } ] }
```

`findings` are the **survivors** — already verified, threshold-filtered, capped, and composition-guarded. Do NOT re-filter, re-judge, or add to them; go straight to drafting (Phase 4). A zero-length `findings` is a **valid, expected outcome** — complete the run with no drafts; never manufacture findings to fill a quota.

> If the Workflow tool is unavailable in your environment, fall back to running the engine by hand per **Appendix A** (identical lenses, skeptic, and filter), then draft those survivors.

## Phase 4: Draft inline comments

For each finding the engine returned, draft a comment with `octomux review draft-comment`, mapping the finding's `file`/`line`/`severity`/`kind`/`body` straight through.

Kind: **comment** (narrative — architectural concerns, "should we use X", FYI) or **suggestion** (a clean line-range patch — typos, simple fixes). Severity: `critical` | `issue` | `suggestion` | `nit`. Bucket: `actionable` (author should change something) | `informational` (FYI).

The review UI tiers severity: `critical` and `issue` render as **blocking** (shown expanded), while `suggestion` and `nit` render as **nits/optional** (collapsed by default). Be disciplined — reserve `critical`/`issue` for the genuinely blocking few, and use `suggestion`/`nit` for everything else.

### For `kind=comment`:

```
octomux review draft-comment \
  --task <task_id> \
  --file <relative/path/from/repo/root> \
  --line <line_number> \
  --side new \
  --severity issue \
  --bucket actionable \
  --kind comment \
  --body "..."
```

### For `kind=suggestion`:

```
octomux review draft-comment \
  --task <task_id> \
  --file <relative/path/from/repo/root> \
  [--start-line <n>] \
  --line <end_line> \
  --side new \
  --severity nit \
  --bucket actionable \
  --kind suggestion \
  --existing-code "<exact text of the lines you're replacing>" \
  --suggested-code "<replacement text>" \
  --body "<short explanation of why>"
```

The CLI validates `existing-code` against the file content at `pr_head_sha`. If it complains "existing_code mismatch" with a diff hint, fix your `--existing-code` — usually a stray whitespace or missing newline. For a multi-line suggestion covering lines 12–18, pass `--start-line 12 --line 18` and `--existing-code` containing all 7 lines joined by `\n`.

### Honor the learnings

If a `learnings` entry says "we intentionally do X because Y", do NOT file a draft contradicting it. If you referenced a learning while drafting (almost flagged something but the learning told you not to), call `octomux review learning touch --id <learning_id>` so we can prune dead learnings.

## Phase 5: Playbook additions (optional, conservative)

After drafting, you MAY append a small number of **durable, project-level observations** to the playbook — hot spots, recurring patterns, conventions. Be conservative: only genuinely reusable entries; never per-PR specifics. Prefer an existing topic slug.

```
octomux review playbook add --task <task_id> --topic <slug> --note "<text>"
```

## Phase 6: Complete

When all drafts are filed (and any playbook additions made), run:

```
octomux review complete --task <task_id> --require-walkthrough
```

This marks the run done, runs the auto-resolve pass on previously-published comments, and broadcasts to the dashboard that drafts are ready for triage.

## Don'ts

- Don't re-derive the walkthrough — consume the one from `start`.
- Don't re-filter the workflow's findings — they're already the survivors.
- Don't file `kind=suggestion` for changes that need thinking beyond a single line range — use `kind=comment`.
- Don't re-flag previously-published comments with fresh drafts — use `check-previous --reflag-body`.
- Don't open chat back-and-forth with the user. Your output is the DB rows.
- Don't invent findings to avoid a zero-comment outcome. Zero findings is correct if nothing survives.

---

## Appendix A: engine internals (manual fallback)

If the Workflow tool is unavailable, run these stages by hand and draft the survivors.

### What a high-value review looks like

The best human reviewers almost never comment "this has no test" or "stray blank line." They flag, in priority order:

1. **Correctness & concurrency bugs** — wrong logic, _and_ runtime-behaviour bugs you only see by reasoning about execution: a sync RPC/IO call inside a loop that blocks N×latency, lock ordering, goroutine/resource leaks, blocking the hot path, off-by-one, mishandled error/edge state.
2. **Dead abstractions & redundant work** — a param/map/field that is _always_ the same value, a value recomputed when already stored upstream, a partial fork of an existing helper that will drift, an encode-then-reparse round-trip.
3. **Extensibility / architecture** — hardcoded per-type/per-venue branches that a new case would force a code edit for, when the behaviour should derive from one source of truth.
4. **Genuine error-handling gaps** — swallowed errors, missing status checks.
5. **High-risk untested behaviour** — a test gap ONLY for non-trivial, high-risk untested code (new state machine, idempotency guard, cold-start/reconcile path). Never generic "X has no test".
6. **Nits** — last resort, never anything a formatter/linter/compiler catches.

Lenses 1–3 are where the value is. If your drafts are mostly test-gaps and nits, you failed the review.

### Stage A — Parallel lenses

Dispatch read-only **reasoning** sub-agents (general-purpose, NOT code-locators), one per lens, each scoped to the worktree (`git -C <worktree> diff <base..head>`; trace changed symbols across files). Lenses: (1) instruction adherence; (2) behaviour & concurrency bug scan (blocking calls in loops, races, leaks — reason about execution); (3) dead-abstraction & redundant-work (data-flow reasoning, not whitespace); (4) git-history/blame regression; (5) error handling / silent failures; (6) test coverage (high-risk only, ≤2 candidates). Each returns `{ file, line, severity, kind, category, body, lens }`.

### Stage B — Adversarial validation

Run a separate skeptic per candidate. REFUTE outright anything a formatter/linter/compiler catches (whitespace, unused imports, magic-string-vs-constant, type errors). For behaviour/concurrency/correctness/architecture claims, refute ONLY with a concrete traced reason — "not sure" → `uncertain`, not `refuted`. Output `{ verdict: confirmed|refuted|uncertain, confidence: 0–100, rationale }`.

### Stage C — Threshold, caps, composition

Drop `refuted`. Keep substantive findings (bug/concurrency/dead-abstraction/architecture/error-handling) at confidence ≥ **55** (incl. `uncertain`); keep test-gaps/nits only at the risk-scaled bar (low ≥85, medium ≥75, high ≥70). Cap total drafts at ~10 (keep highest severity/confidence). Composition guard: test-gaps + nits ≤ one-third of drafts — if your survivors are mostly test-gaps/nits, the substantive lenses under-delivered; reason harder before drafting.
