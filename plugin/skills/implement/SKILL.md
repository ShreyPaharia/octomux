---
name: implement
description: Implement a Jira ticket — fetches ticket, checks for existing plan, creates worktree branch, runs implementation with verification. Usage - /implement IN-XXX
---

# Implement a Jira Ticket

Fetch a Jira ticket, check for an existing plan, set up a branch, and implement with lint+test verification before committing.

**Announce at start:** "Implementing <ticket key>: <title>"

## Checklist

1. **Fetch ticket** — get Jira ticket details and any existing plan
2. **Assess readiness** — is this ready to implement, or does it need `/plan` first?
3. **Set up branch** — create worktree or branch
4. **Read project conventions** — CLAUDE.md, learnings, relevant package docs
5. **Implement** — follow the plan or work from the ticket description
6. **Verify** — `make lint && make test` (or project equivalent)
7. **Commit** — conventional commit referencing the ticket
8. **Report** — summary with next steps (PR creation)

## Jira Authentication

Before any Jira call, test connectivity by calling `getAccessibleAtlassianResources()`. If it fails or returns an auth error, stop and prompt the user:

> "Jira is not authenticated. Please run `/plugin` and authenticate the Atlassian plugin, then try again."

Do not proceed with Jira operations until auth is confirmed.

## Phase 1: Fetch Ticket

Extract the ticket key from the argument (e.g., `IN-945` from `/implement IN-945` or from a URL).

**1a. Get Jira details (also serves as auth check):**

```
getAccessibleAtlassianResources() -> cloudId  (if this fails, follow Jira Authentication section)
getJiraIssue(cloudId, issueKey, fields=["summary","description","priority","labels","status","parent"], responseContentFormat="markdown")
```

**1b. Check for existing local plan (parallel):**

```bash
ls docs/plans/<ticket-key>-*.md 2>/dev/null
```

If a plan file exists, read it — this is the primary implementation guide.

If no plan file exists, use the ticket description's Approach section as the guide.

## Phase 2: Assess Readiness

Check if the ticket has enough detail to implement:

- **Ready:** Has clear What/Why/Approach or an existing plan file -> proceed
- **Needs planning:** Description is vague, scope is unclear, or estimate was XL -> recommend `/plan <ticket-key>` first

If unclear, ask the user:

> "This ticket doesn't have a detailed approach. Should I:
>
> 1. Run `/plan <ticket-key>` first for a deep-dive
> 2. Proceed with my best understanding (I'll ask questions as I go)"

## Phase 3: Set Up Branch

**Branch naming:** `<type>/<ticket-key>-<short-description>`

```bash
# Check if branch already exists
git branch --list "*<ticket-key>*"
```

If branch exists, switch to it. If not, create from the appropriate base:

```bash
git fetch origin
git checkout -b <branch-name> origin/<base-branch>
```

**Base branch detection:**

- Default: `master` (nucleus convention)
- If ticket mentions a dependency on another branch, use that
- If user specifies a base, use that

## Phase 4: Read Project Conventions

Before writing any code, read:

```
CLAUDE.md                          # Project conventions
internal/hedging/CLAUDE.md         # Service-specific (if hedging work)
.claude/rules/learnings.md         # Known gotchas
```

Also read the specific files that will be modified to understand existing patterns.

## Phase 5: Implement

If a plan file exists, follow it task-by-task. For each task:

1. Read the task steps
2. Implement the changes
3. Run `make lint && make test` after each logical chunk
4. Commit after each task with a conventional commit message

If no plan file exists, implement from the ticket description:

1. Start by understanding the current code (read relevant files)
2. Make changes incrementally — one concern at a time
3. Write tests alongside implementation (follow existing test patterns)
4. Run `make lint && make test` after each logical chunk
5. Commit after each logical chunk

**Implementation principles:**

- Follow existing code patterns in the package
- Use `decimal.Decimal` for all monetary/quantity math (never float64)
- Use `google/go-cmp` for test assertions (no testify in hedging)
- Keep changes minimal and focused on the ticket scope
- Don't refactor surrounding code unless the ticket calls for it

## Phase 6: Verify

Before considering the work done, run full verification:

```bash
make lint && make test
```

If either fails, fix the issues and re-run until clean.

For hedging-specific work, also check:

```bash
go vet ./internal/hedging/...
```

## Phase 7: Commit

Use conventional commits referencing the ticket:

```bash
git add <specific files>
git commit -m "<type>(<scope>): <description>

Resolves https://ostium.atlassian.net/browse/<ticket-key>"
```

**Commit conventions (from CLAUDE.md):**

- Format: `<type>(<scope>): <description>` (description min 10 chars)
- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
- Scopes: `automation`, `hedging`, `domain`, `config`, `ingestion`, `contracts`, `formulae`, `observability`, `cmd`, `infra`
- Do NOT include Co-Authored-By lines (user preference)

Multiple commits are fine — one per logical chunk is better than one giant commit.

## Phase 8: Report

```
Implementation complete for <ticket-key>: <title>

Changes:
- <N> files changed across <M> commits
- <commit 1 summary>
- <commit 2 summary>

Verification:
- make lint: PASS
- make test: PASS

Next steps:
- `/create-pr` to open a pull request
- Or review the diff: `git diff origin/<base>...HEAD`
```

## Dispatch Mode

If the user says `/implement IN-XXX --dispatch` or asks to dispatch it as a task, use the `/create-task` skill instead of implementing inline. This sends the ticket to an octomux agent for autonomous implementation.

## Notes

- Always verify with `make lint && make test` before reporting done
- If you discover the ticket scope is wrong mid-implementation, stop and tell the user
- If you hit a blocker (missing dependency, unclear requirement), ask rather than guessing
- Don't create documentation files unless the ticket asks for it
- The plan file (if it exists) is the source of truth — follow it unless it contradicts what you find in the code
