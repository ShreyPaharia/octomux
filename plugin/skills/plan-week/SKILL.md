---
name: plan-week
description: Weekly planning session — AI interviews you about goals, breaks them into Jira tickets with lightweight plans, creates them after approval. Use when starting the week or planning a batch of work.
---

# Weekly Planning

Interview the user about what they want to accomplish, break it into well-scoped Jira tickets, get approval, then create them in Jira.

## Checklist

1. **Fetch context** — current sprint, open tickets, recent work
2. **Interview** — understand goals, one question at a time
3. **Propose ticket list** — table with title, type, estimate, epic
4. **Single approval gate** — user approves, drops, or adjusts
5. **Create tickets in Jira** — with description, acceptance criteria, epic, sprint, assignee
6. **Report** — links to all created tickets

## Jira Authentication

Before any Jira call, test connectivity by calling `getAccessibleAtlassianResources()`. If it fails or returns an auth error, stop and prompt the user:

> "Jira is not authenticated. Please run `/plugin` and authenticate the Atlassian plugin, then try again."

Do not proceed with Jira operations until auth is confirmed.

## Phase 1: Fetch Context

Before the interview, silently gather context so you can ask informed questions.

**1a. Get Jira cloud ID (also serves as auth check):**

```
getAccessibleAtlassianResources() -> extract cloudId for ostium-defi.atlassian.net
```

If this fails, follow the Jira Authentication section above.

**1b. Get current sprint and open tickets (parallel):**

```
searchJiraIssuesUsingJql(cloudId, "project = "IN" AND assignee = currentUser() AND status != Done ORDER BY priority DESC", fields=["summary","status","priority","issuetype","sprint","parent"])
```

**1c. Get user's Jira account ID:**

```
atlassianUserInfo() -> extract accountId
```

**1d. Check recent git work:**

```bash
git log --all --oneline --since="1 week ago" --author="Shrey" | head -20
```

Keep this context in mind but don't dump it on the user. Use it to ask better questions and avoid duplicating existing tickets.

## Phase 2: Interview

Start with a single open question:

> "What do you want to accomplish this week? List the big things — features, bugs, chores, anything."

Then follow up **one question at a time** to clarify:

- Scope and boundaries ("Is this just the API, or does it include the dashboard?")
- Dependencies ("Does this need the config migration to land first?")
- Priority ("Which of these is blocking something else?")
- Unknowns ("You mentioned the reconciler — do you know the root cause yet, or does that need investigation first?")

**Stop interviewing when** you have enough to propose tickets. Don't over-interview — 3-5 questions is usually enough.

## Phase 3: Propose Ticket List

Present a table:

```
| # | Type  | Title                                        | Epic        | Estimate | Notes                  |
|---|-------|----------------------------------------------|-------------|----------|------------------------|
| 1 | feat  | Add margin utilization gate to SOR validator  | Hedging     | M        | Depends on #3          |
| 2 | fix   | Fix orphaned LP orders on SOR timeout         | Hedging     | S        | High priority          |
| 3 | chore | Migrate pair config from YAML to PostgreSQL   | Hedging     | L        | Needed by #1           |
| 4 | feat  | Add collateral monitoring cron                | Hedging     | M        |                        |
```

Estimates: S (< half day), M (half day - 1 day), L (1-2 days), XL (needs `/plan` before implementing)

For **XL tickets**, flag them:

> "Ticket #3 is large and ambiguous — I'd recommend running `/plan IN-XXX` on it before implementing to nail down the approach."

## Phase 4: Approval Gate

> "Here's what I'd create. You can:
>
> - `approve all`
> - `drop 3` — remove ticket #3
> - `split 2` — break ticket #2 into smaller pieces
> - `edit 4` — change title, type, estimate, or scope
> - `add` — describe another ticket to add
>
> What looks right?"

**One round.** Handle all adjustments, then move to creation. Don't re-present the table unless major changes were made.

## Phase 5: Create Tickets in Jira

For each approved ticket, create a Jira issue:

```
createJiraIssue(
  cloudId: <cloudId>,
  projectKey: "IN",
  issueTypeName: <"Task" | "Bug" | "Story">,
  summary: <title>,
  description: <see format below>,
  contentFormat: "markdown",
  assignee_account_id: <user's accountId>,
  additional_fields: {
    "priority": {"name": <"High" | "Medium" | "Low">},
    "parent": {"key": <epic key if known>},
    "labels": [<relevant labels>]
  }
)
```

**Type mapping:**

- `feat` -> "Story"
- `fix` -> "Bug"
- `chore`, `refactor`, `test`, `perf`, `docs` -> "Task"

**Description format (markdown):**

```markdown
## What

<1-2 sentences describing the change>

## Why

<1-2 sentences on motivation>

## Approach

- <bullet 1: key file/package to modify>
- <bullet 2: main logic change>
- <bullet 3: test strategy>
- <bullet 4: risks or unknowns, if any>

## Acceptance Criteria

- [ ] <criterion 1>
- [ ] <criterion 2>
- [ ] <criterion 3>
```

The Approach section is the **lightweight plan** — 3-5 bullets covering what to change, not how. Enough to catch wrong directions early without deep planning.

## Phase 6: Report

After all tickets are created, present:

```
Created N tickets:

| Key    | Title                                       | Type  | Link |
|--------|---------------------------------------------|-------|------|
| IN-980 | Add margin utilization gate to SOR validator | Story | URL  |
| IN-981 | Fix orphaned LP orders on SOR timeout        | Bug   | URL  |

XL tickets needing deep planning:
- IN-982 — Run `/plan IN-982` before implementing

Ready to implement:
- `/implement IN-980` to start coding
- Or dispatch via octomux: `/create-task IN-980`
```

## Notes

- Don't add a "Context" section to Jira tickets (user preference)
- Epic linking uses the `parent` field — epics must already exist in Jira
- If you don't know the epic key, ask the user or search for it via JQL
- Sprint assignment requires knowing the sprint ID — if needed, search for the active sprint
- Keep ticket descriptions concise — the deep planning happens in `/plan` or at implementation time
