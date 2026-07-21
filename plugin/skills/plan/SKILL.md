---
name: plan
description: Deep planning for a specific Jira ticket — codebase deep-dive, interview on ambiguous points, update ticket with detailed approach. Use before implementing large or unclear tickets. Usage - /plan IN-XXX
---

# Deep Planning

Do a codebase deep-dive for a specific Jira ticket, interview the user on key decisions, then update the ticket with a detailed implementation plan.

**Announce at start:** "Running deep planning for <ticket key>."

## Checklist

1. **Fetch ticket** — get Jira ticket details
2. **Codebase deep-dive** — read relevant packages, trace data flow, understand interfaces
3. **Interview** — surface ambiguities, propose approaches, get decisions
4. **Write plan** — detailed implementation plan saved locally
5. **Update ticket** — update Jira description with finalized approach
6. **Report** — summary with next steps

## Jira Authentication

Before any Jira call, test connectivity by calling `getAccessibleAtlassianResources()`. If it fails or returns an auth error, stop and prompt the user:

> "Jira is not authenticated. Please run `/plugin` and authenticate the Atlassian plugin, then try again."

Do not proceed with Jira operations until auth is confirmed.

## Phase 1: Fetch Ticket

Extract the ticket key from the argument (e.g., `IN-945` from `/plan IN-945` or from a URL).

```
getAccessibleAtlassianResources() -> cloudId  (also serves as auth check — if this fails, follow Jira Authentication section)
getJiraIssue(cloudId, issueKey, fields=["summary","description","priority","labels","status","parent","components"], responseContentFormat="markdown")
```

Parse the ticket summary, description, and any existing acceptance criteria.

## Phase 2: Codebase Deep-Dive

Based on the ticket, explore the relevant parts of the codebase. This is where the real value is — planning with actual code context.

**Always read first:**

- `CLAUDE.md` and any service-specific CLAUDE.md (e.g., `internal/hedging/CLAUDE.md`)
- `.claude/rules/learnings.md` for known gotchas

**Then explore based on the ticket:**

- Use Grep/Glob to find relevant files, types, interfaces
- Read the key files that will be modified
- Trace the data flow end-to-end for the feature/fix
- Check existing tests for patterns to follow
- Look at recent related PRs/commits for context

**Build a mental model:**

- What components are involved?
- What interfaces need to change?
- What are the dependencies between changes?
- Where are the risks (concurrency, precision, backwards compatibility)?

Use the Agent tool with `subagent_type: "Explore"` for broad searches, direct Grep/Read for targeted lookups.

## Phase 3: Interview

Present what you found and surface the key decisions. This is a collaborative conversation, not a monologue.

**Start with a summary:**

> "I've read through the relevant code. Here's what I understand and the decisions we need to make:"
>
> **Current state:** <2-3 sentences on how things work now>
>
> **What needs to change:** <2-3 sentences on the scope>
>
> **Key decisions:**
>
> 1. <Decision 1> — I'd recommend X because Y. Thoughts?

**Ask one decision at a time.** For each:

- Explain the trade-offs you found in the code
- Give your recommendation with reasoning
- Reference specific files/lines when relevant

**Common decisions to surface:**

- Where to put new logic (which package, which file)
- Interface design (what the API looks like)
- Data model changes (new fields, new types)
- Error handling strategy (how failures propagate)
- Testing approach (unit vs integration, what to mock)
- Migration/rollout concerns (feature flags, backwards compatibility)

**Stop interviewing when** all ambiguous points are resolved. For well-understood tickets, this might be 1-2 questions. For complex ones, 4-6.

## Phase 4: Write Plan

Save a detailed implementation plan locally. Follow the superpowers writing-plans format:

**Save to:** `docs/plans/<ticket-key>-<short-name>.md`

```markdown
# <Ticket Key>: <Title> Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** <one sentence>

**Architecture:** <2-3 sentences on approach>

**Key Decisions:**

- <Decision 1>: <what was decided and why>
- <Decision 2>: <what was decided and why>

**Resolves:** https://ostium.atlassian.net/browse/<ticket-key>

---

### Task 1: <Component Name>

**Files:**

- Create: `exact/path/to/file.go`
- Modify: `exact/path/to/existing.go`
- Test: `exact/path/to/file_test.go`

- [ ] **Step 1:** <specific action with code if applicable>
- [ ] **Step 2:** <specific action>
- [ ] **Step 3:** Run `make lint && make test`
- [ ] **Step 4:** Commit

### Task 2: ...
```

**Plan quality rules (from superpowers:writing-plans):**

- Exact file paths always
- Complete code in steps that change code
- No placeholders (TBD, TODO, "add appropriate handling")
- DRY, YAGNI, TDD where applicable
- Each task produces a working, committable state

## Phase 5: Update Jira Ticket

Update the ticket description with the finalized approach. Use `editJiraIssue`:

```
editJiraIssue(
  cloudId: <cloudId>,
  issueIdOrKey: <ticket key>,
  contentFormat: "markdown",
  fields: {
    "description": <updated description>
  }
)
```

**Updated description format:**

```markdown
## What

<1-2 sentences describing the change>

## Why

<1-2 sentences on motivation>

## Approach

<Detailed approach — 5-10 bullets covering:>

- Key files to modify with specific changes
- Interface/type changes
- Data flow changes
- Testing strategy

## Key Decisions

- <Decision 1>: <what was decided>
- <Decision 2>: <what was decided>

## Acceptance Criteria

- [ ] <criterion 1>
- [ ] <criterion 2>
- [ ] <criterion 3>

## Implementation Plan

Local plan: `docs/plans/<ticket-key>-<short-name>.md`
```

## Phase 6: Report

```
Planning complete for <ticket key>: <title>

Plan saved: docs/plans/<ticket-key>-<short-name>.md
Jira updated: <ticket URL>

Key decisions:
1. <decision summary>
2. <decision summary>

Next steps:
- `/implement <ticket-key>` to start coding
- Or dispatch via octomux: `/create-task <ticket-key>`
```

## Notes

- Don't add a "Context" section to Jira tickets (user preference)
- If the ticket already has a good description, preserve the What/Why and only update Approach + Key Decisions
- If the codebase exploration reveals the ticket scope is wrong (too big, wrong approach), say so during the interview rather than planning the wrong thing
- For truly massive tickets, suggest breaking into sub-tickets during the interview
- The local plan file is the source of truth for implementation — the Jira description is a summary
