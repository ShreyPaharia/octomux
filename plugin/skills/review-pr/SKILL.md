---
name: review-pr
description: Use when reviewing a pull request, posting PR review comments, or when user says /review-pr. Reviews code with parallel agents and posts a pending GitHub review with inline comments.
---

# PR Review & Post

Review a PR using parallel specialized agents, present findings to user, then post as a pending GitHub review with inline comments.

## Inputs

- **PR URL or number** — from user args or current branch
- **Base branch** — from PR metadata or user override
- **Review focus** — optional, e.g. "focus on correctness and test coverage"

## Steps

### 1. Gather PR Context

```bash
gh pr view <number>              # title, description, base branch
gh pr diff <number>              # full diff
gh pr diff <number> --name-only  # changed files
gh pr view <number> --json headRefOid -q '.headRefOid'  # commit SHA for review API
```

Also read `CLAUDE.md` and any service-specific CLAUDE.md files (e.g. `internal/hedging/CLAUDE.md`) to understand project conventions.

### 2. Launch Review Agents in Parallel

Launch **all agents in a single message** using the Agent tool. Each agent gets the full diff and changed file list. Agents should read CLAUDE.md for project conventions.

**Agents:**

| Agent                       | Focus                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------- |
| Code Reviewer               | Up to 5 ranked improvements (impact vs effort). Watch for project-specific conventions. |
| Security & Financial Safety | Input validation, decimal precision, race conditions, secrets, data leakage.            |
| Quality & Style             | Complexity, dead code, duplication, naming, logging, constructor patterns.              |
| Test Quality                | Coverage gaps, test patterns, anti-patterns, assertion quality.                         |
| Performance & Concurrency   | N+1 queries, goroutine leaks, race conditions, channel misuse, lock contention.         |
| Dependency & Deployment     | Breaking changes, config safety, migration safety, rollback safety.                     |
| Simplification              | Over-abstraction, unnecessary complexity, change atomicity.                             |

Each agent returns a concise report (under 300 words) with file:line references.

### 3. Synthesize Findings

Collect all agent results and:

1. Deduplicate — multiple agents may flag same issue
2. Rank by severity — Critical > High > Medium > Low
3. Cross-reference — if multiple agents flag it, elevate
4. Categorize into: Critical (must fix), Issues (should fix), Suggestions (nice to have)

### 4. Present Comments to User

Show the user the proposed comments **before posting**. Format each as:

```
**N. Title** (on `file:path`, line X)
> Comment text here
```

Wait for user confirmation or edits. The user may:

- Adjust wording
- Drop comments
- Add comments
- Ask to change tone

### 5. Post Pending Review

Use the GitHub API to post a single pending review with inline comments:

```bash
gh api repos/{owner}/{repo}/pulls/{number}/reviews \
  --method POST \
  --input - <<'JSONEOF'
{
  "commit_id": "<head_sha>",
  "event": "COMMENT",
  "body": "<overall review comment>",
  "comments": [
    {
      "path": "file/path.go",
      "line": 42,
      "side": "RIGHT",
      "body": "Comment text here"
    }
  ]
}
JSONEOF
```

**Notes on posting:**

- `line` is the line number in the **new file** (RIGHT side of diff)
- Binary files cannot have inline comments — put in review body instead
- `subject_type: "file"` is NOT supported by the GraphQL-backed endpoint — avoid it
- If a comment targets a deleted line, use `side: "LEFT"` with the old file line number
- `event: "COMMENT"` posts as a neutral review (not approve/request changes)

### 6. Check PR Format

Verify PR description against project conventions (from CLAUDE.md):

- `## What` section
- `## Why` section
- `## Testing` section
- Jira link if required

Include format checklist in overall review comment if issues found.

## Comment Style

Write comments like the repo owner — direct, short, no fluff:

- **Imperative tone.** "Remove this", "Revert this", "Move this to X"
- **One to two sentences max.** No paragraphs.
- **No markdown headers or bullet lists** inside comments.
- **Name the fix, not the problem.** "Validate non-nil in `NewServer` instead" not "This could cause a nil pointer dereference in production when..."
- **Use backticks** for code references: function names, file names, config keys.
- **"Nit:"** prefix for non-blocking suggestions.
- **No praise or filler.** No "Great work but...", no "Consider...", no "It might be worth..."

### Examples

```
# Good
Remove this, compiled binary should not be in the repo. Add it to `.gitignore`.

# Good
This looks like a debug leftover, `mock_lp.enabled` should stay `false` in the committed config. Use `local.yaml` for local overrides.

# Good
We always pass a non-nil priceCache from main, so this nil check is dead code. Validate non-nil in `NewServer` instead and remove this guard.

# Good
Nit: `message.NewPrinter(language.English)` from `golang.org/x/text/message` does this — `p.Sprintf("$%.2f", d.InexactFloat64())` handles comma formatting automatically. Already an indirect dep.

# Good
Move this to `templateFuncs` to follow the existing convention.

# Bad (too long, too soft)
This is a really nice function, but I think it might be worth considering whether we could simplify this by using the standard library's text/message package, which provides locale-aware number formatting out of the box. This would reduce the maintenance burden of this custom implementation.

# Bad (describes problem instead of fix)
There's a potential issue here where if priceCache is nil, this could cause unexpected behavior in production. The nil check in the handler suggests that this might not always be initialized.
```

## Verdict Guidelines

Include a one-line verdict at the end of the overall review comment:

- **Ready to Merge** — No critical/high issues, suggestions are optional
- **Needs Attention** — Has medium issues worth addressing
- **Needs Work** — Has critical/high issues that must be fixed
