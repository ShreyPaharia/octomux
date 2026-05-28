# Review Orchestrator — Step 3: UI + publish flow

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the human-facing review experience on top of the backend orchestrator delivered in Step 2. By the end of Step 3 the user can: open `/reviews` to see open review requests; click in to a dedicated detail page showing the structured walkthrough plus inline draft comments on the PR diff; accept / reject / edit / re-classify drafts; pick a verdict; publish to GitHub as a single PR review. Rejecting a draft optionally captures a "why" string as a `review_learnings` row. The detail page live-updates as the agent re-reviews (incremental SSE events).

**Architecture:** Backend gains five new endpoints (`POST /api/tasks/:id/publish-review`, `PATCH /api/tasks/:id/review-runs/:rid/walkthrough`, an extended `PATCH /api/tasks/:id/comments/:cid`, `POST /api/tasks/:id/review-runs`, `GET /api/reviews` + `GET /api/reviews/:id`) plus a small learnings CRUD pair. The frontend adds two new routes (`/reviews`, `/reviews/:id`), a settings panel for learnings, and a few new React components. The existing `/tasks` list filters out `source='auto_review'` rows and `/tasks/:id` redirects them to `/reviews/:id` so reviews never bleed into the regular task UX.

**Tech Stack:** React 19 + React Router 7 + Vite + Tailwind CSS 4 + shadcn/ui (`@base-ui/react`). Express 5 + better-sqlite3 + Octokit for the GitHub publish call. SSE/WS via the existing `events.ts` broadcast channel. Vitest for unit + component tests; Playwright for E2E.

**Spec reference:** `docs/superpowers/specs/2026-05-27-review-orchestrator-design.md`, sections 4 (Publish flow + UI) and 5 (failure modes — GitHub-side handling).

**Working assumptions about the codebase** (verify with the current source, do not rely on memory):

- The Express app is composed in `server/app.ts`'s `createApp()` and routes register in `server/api.ts`. The existing PATCH `/api/tasks/:id/comments/:cid` is around line 1504.
- `server/diff.ts` exposes diff helpers; the existing diff page uses the inline-comments viewer in `src/components/`. Inspect with grep before designing the new viewer; reuse the existing pieces.
- `src/components/ui/` holds the shadcn primitives. Forms typically use `Form` + `Field` + `Control` from `@base-ui/react`.
- React Router uses the routes block in `src/App.tsx`.
- The dashboard sidebar is in `src/components/layout/`. Grep for the current `Tasks`/`Workspaces` nav items and add `Reviews` alongside.
- The existing test pattern is `*.test.tsx` co-located with the component; React Testing Library + `renderWithRouter` from `src/test-helpers.tsx`.
- Backend tests for API endpoints use supertest against `createApp()`.
- E2E tests use Playwright in `e2e/`. Helpers in `e2e/helpers.ts` cover task creation; this plan adds a new `createReviewFixture` helper for seeding a review task with a known walkthrough + draft comments without driving a real agent (E2E should not depend on the agent).
- GitHub access uses the existing gh auth path (`server/github-login.ts`). For posting reviews use the same `gh api` invocation style or import `@octokit/rest` if the project already includes it; check the lockfile.
- Conventional Commits, kebab-case scopes, 100-char header. Never add `Co-Authored-By:` trailers.

---

## File structure

### New files

| Path                                               | Responsibility                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `server/publish-review.ts`                         | `publishReview(taskId, verdict, body)` — load drafts, validate stale, call GitHub, persist. |
| `server/publish-review.test.ts`                    |                                                                                             |
| `server/reviews-inbox.ts`                          | `listReviewsInbox()` + `getReviewDetail(taskId)` — aggregated read endpoints' guts.         |
| `server/reviews-inbox.test.ts`                     |                                                                                             |
| `src/pages/ReviewsPage.tsx`                        | `/reviews` inbox.                                                                           |
| `src/pages/ReviewsPage.test.tsx`                   |                                                                                             |
| `src/pages/ReviewDetailPage.tsx`                   | `/reviews/:id` detail.                                                                      |
| `src/pages/ReviewDetailPage.test.tsx`              |                                                                                             |
| `src/components/review/WalkthroughTree.tsx`        | Scalar pill bar + collapsible groups + edit affordance per section.                         |
| `src/components/review/WalkthroughTree.test.tsx`   |                                                                                             |
| `src/components/review/InlineCommentCard.tsx`      | Renders a draft/published comment with kind=comment OR kind=suggestion treatment.           |
| `src/components/review/InlineCommentCard.test.tsx` |                                                                                             |
| `src/components/review/ReviewFilters.tsx`          | Filter pills (severity, bucket, kind, show resolved).                                       |
| `src/components/review/ReviewFilters.test.tsx`     |                                                                                             |
| `src/components/review/PublishBar.tsx`             | Sticky bar with counts + verdict dropdown + Publish button.                                 |
| `src/components/review/PublishBar.test.tsx`        |                                                                                             |
| `src/components/review/RejectDialog.tsx`           | "Reject only" vs "Reject + remember this" with optional why.                                |
| `src/components/review/RejectDialog.test.tsx`      |                                                                                             |
| `src/components/review/HeadAdvancedBanner.tsx`     | Live banner when SSE reports `review:head-advanced`.                                        |
| `src/components/settings/LearningsPanel.tsx`       | Per-repo learnings list in `/settings`.                                                     |
| `src/components/settings/LearningsPanel.test.tsx`  |                                                                                             |
| `e2e/review-orchestrator.spec.ts`                  | Playwright happy-path E2E (seed → triage → publish-to-mock-gh).                             |
| `e2e/helpers-review.ts`                            | `createReviewFixture(...)` helper for tests.                                                |

### Modified files

| Path                              | Change                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `server/api.ts`                   | Register new routes; extend `PATCH /api/tasks/:id/comments/:cid` to accept the new fields and capture rejection learnings. |
| `server/api.review.test.ts`       | Tests for all new routes.                                                                                                  |
| `server/events.ts`                | Add new event types (`review:published`, `review:head-advanced`) to the union if a strict type exists.                     |
| `src/App.tsx`                     | Add `/reviews` and `/reviews/:id` routes.                                                                                  |
| `src/pages/TasksPage.tsx`         | Filter out `source='auto_review'` rows from the list.                                                                      |
| `src/pages/TaskDetail.tsx`        | If the loaded task has `source='auto_review'`, redirect to `/reviews/:id`.                                                 |
| `src/components/layout/<Sidebar>` | Add the "Reviews" entry with a needs-you badge.                                                                            |
| `src/lib/api.ts`                  | Add typed client functions for the new endpoints.                                                                          |
| `src/pages/SettingsPage.tsx`      | Mount the `LearningsPanel` under a new "Reviews" section.                                                                  |

---

## Phase A — Backend endpoints

## Task A1: Aggregated read endpoints — `GET /api/reviews` + `GET /api/reviews/:id`

**Files:**

- Create: `server/reviews-inbox.ts`
- Create: `server/reviews-inbox.test.ts`
- Modify: `server/api.ts`

The two read endpoints power the UI. Putting the aggregation logic behind a function makes it unit-testable independent of supertest.

- [ ] **Step 1: Write the failing test**

Create `server/reviews-inbox.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers.js';
import { listReviewsInbox, getReviewDetail } from './reviews-inbox.js';

function seedRepo(): void {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, mode, status)
     VALUES ('wt1', '/wt', '/repos/foo', 'review/x', 'main', 'new', 'available')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks
       (id, title, runtime_state, workflow_status, source, worktree_id, worktree, pr_url, pr_number, pr_head_sha, base_sha)
     VALUES
       ('t1', 'PR review', 'running', 'backlog', 'auto_review', 'wt1', '/wt',
        'https://github.com/o/r/pull/1', 1, 'sha-h', 'sha-b')`,
  ).run();
  db.prepare(
    `INSERT INTO review_runs (id, task_id, pr_head_sha, walkthrough, status, completed_at)
     VALUES ('r1', 't1', 'sha-h', '{"global":{}}', 'completed', datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO inline_comments
       (id, task_id, file_path, line, side, original_commit_sha, body, status, kind, review_run_id, severity, bucket)
     VALUES
       ('c1', 't1', 'a.ts', 1, 'new', 'sha-h', 'b', 'draft', 'comment', 'r1', 'issue', 'actionable'),
       ('c2', 't1', 'a.ts', 2, 'new', 'sha-h', 'b', 'accepted', 'comment', 'r1', 'nit', 'actionable'),
       ('c3', 't1', 'a.ts', 3, 'new', 'sha-h', 'b', 'rejected', 'comment', 'r1', 'nit', 'actionable')`,
  ).run();
}

describe('reviews-inbox', () => {
  beforeEach(seedRepo);

  it('listReviewsInbox returns one row per auto_review task with counts', () => {
    const list = listReviewsInbox();
    expect(list).toHaveLength(1);
    const row = list[0];
    expect(row.task_id).toBe('t1');
    expect(row.pr_number).toBe(1);
    expect(row.draft_count).toBe(1);
    expect(row.accepted_count).toBe(1);
    expect(row.rejected_count).toBe(1);
    expect(row.status).toBe('drafts-ready'); // accepted > 0 OR drafts > 0 AND latest run completed
  });

  it('getReviewDetail returns task + latest run + comments + published history', () => {
    const detail = getReviewDetail('t1');
    expect(detail).not.toBeNull();
    expect(detail!.task.id).toBe('t1');
    expect(detail!.latest_run?.id).toBe('r1');
    expect(detail!.comments.map((c) => c.id).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(detail!.published_history).toEqual([]);
  });

  it('getReviewDetail returns null for unknown task', () => {
    expect(getReviewDetail('nope')).toBeNull();
  });

  it('getReviewDetail returns null for a non-auto_review task', () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO tasks (id, title, runtime_state, workflow_status, source)
       VALUES ('t2', 'regular', 'idle', 'backlog', NULL)`,
    ).run();
    expect(getReviewDetail('t2')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test server/reviews-inbox.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

Create `server/reviews-inbox.ts`:

```ts
import { getDb } from './db.js';
import type { InlineComment, PublishedReview, ReviewRun, Task } from './types.js';

export type ReviewInboxStatus =
  | 'reviewing' // a review_run is currently running
  | 'drafts-ready' // latest run completed, drafts await user action
  | 'head-advanced' // PR head SHA differs from latest review_run's SHA
  | 'published' // a published_review exists for the current head SHA and no drafts left
  | 'failed'; // latest run failed

export interface ReviewInboxRow {
  task_id: string;
  pr_number: number;
  pr_url: string;
  pr_title: string;
  pr_head_sha: string;
  author_login: string | null;
  repo_path: string;
  status: ReviewInboxStatus;
  draft_count: number;
  accepted_count: number;
  rejected_count: number;
  stale_count: number;
  last_activity_at: string;
}

export function listReviewsInbox(): ReviewInboxRow[] {
  const db = getDb();
  const tasks = db
    .prepare(
      `SELECT t.*, w.repo_path AS repo_path
         FROM tasks t
         LEFT JOIN worktrees w ON t.worktree_id = w.id
        WHERE t.source = 'auto_review'
          AND t.runtime_state != 'error'
        ORDER BY t.updated_at DESC`,
    )
    .all() as Array<Task & { repo_path: string | null }>;

  const rows: ReviewInboxRow[] = [];
  for (const t of tasks) {
    const counts = db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM inline_comments WHERE task_id = ? GROUP BY status`,
      )
      .all(t.id) as Array<{ status: string; n: number }>;
    const get = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
    const latestRun = db
      .prepare(`SELECT * FROM review_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`)
      .get(t.id) as ReviewRun | undefined;

    let status: ReviewInboxStatus = 'reviewing';
    if (!latestRun) status = 'reviewing';
    else if (latestRun.status === 'failed') status = 'failed';
    else if (latestRun.status === 'running') status = 'reviewing';
    else if (latestRun.pr_head_sha !== t.pr_head_sha) status = 'head-advanced';
    else if (get('draft') === 0 && get('accepted') === 0) {
      const hasPublishedAtHead = db
        .prepare(`SELECT 1 FROM published_reviews WHERE task_id = ? AND head_sha = ? LIMIT 1`)
        .get(t.id, t.pr_head_sha);
      status = hasPublishedAtHead ? 'published' : 'drafts-ready';
    } else status = 'drafts-ready';

    rows.push({
      task_id: t.id,
      pr_number: t.pr_number ?? 0,
      pr_url: t.pr_url ?? '',
      pr_title: t.title,
      pr_head_sha: t.pr_head_sha ?? '',
      author_login: null, // populated from PR metadata in a follow-up; not in DB today
      repo_path: t.repo_path ?? '',
      status,
      draft_count: get('draft'),
      accepted_count: get('accepted'),
      rejected_count: get('rejected'),
      stale_count: get('stale'),
      last_activity_at: t.updated_at,
    });
  }
  return rows;
}

export interface ReviewDetail {
  task: Task;
  latest_run: ReviewRun | null;
  all_runs: ReviewRun[];
  comments: InlineComment[];
  published_history: PublishedReview[];
}

export function getReviewDetail(taskId: string): ReviewDetail | null {
  const db = getDb();
  const task = db
    .prepare(
      `SELECT t.*, w.repo_path AS repo_path
         FROM tasks t LEFT JOIN worktrees w ON t.worktree_id = w.id
        WHERE t.id = ? AND t.source = 'auto_review'`,
    )
    .get(taskId) as Task | undefined;
  if (!task) return null;
  const all_runs = db
    .prepare(`SELECT * FROM review_runs WHERE task_id = ? ORDER BY started_at DESC`)
    .all(taskId) as ReviewRun[];
  const latest_run = all_runs[0] ?? null;
  const comments = db
    .prepare(`SELECT * FROM inline_comments WHERE task_id = ? ORDER BY file_path, line, created_at`)
    .all(taskId) as InlineComment[];
  const published_history = db
    .prepare(`SELECT * FROM published_reviews WHERE task_id = ? ORDER BY published_at DESC`)
    .all(taskId) as PublishedReview[];

  return { task, latest_run, all_runs, comments, published_history };
}
```

- [ ] **Step 4: Wire up routes in `server/api.ts`**

Add (near the existing comment-related routes):

```ts
import { listReviewsInbox, getReviewDetail } from './reviews-inbox.js';

app.get('/api/reviews', (_req, res) => {
  res.json(listReviewsInbox());
});

app.get('/api/reviews/:id', (req, res) => {
  const detail = getReviewDetail(req.params.id);
  if (!detail) {
    res.status(404).json({ error: 'review not found' });
    return;
  }
  res.json(detail);
});
```

- [ ] **Step 5: Run to verify pass**

Run: `bun run test server/reviews-inbox.test.ts`
Expected: PASS.

Add a supertest test to `server/api.review.test.ts`:

```ts
it('GET /api/reviews returns the inbox', async () => {
  // seed an auto_review task
  const app = createApp();
  const res = await request(app).get('/api/reviews');
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
});

it('GET /api/reviews/:id returns detail', async () => {
  // seed
  const app = createApp();
  const res = await request(app).get('/api/reviews/t1');
  expect(res.status).toBe(200);
  expect(res.body.task.id).toBe('t1');
});
```

Run: `bun run test server/api.review.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/reviews-inbox.ts server/reviews-inbox.test.ts server/api.ts server/api.review.test.ts
git commit -m "feat(api): GET /api/reviews and /api/reviews/:id for the inbox + detail"
```

---

## Task A2: Extended `PATCH /api/tasks/:id/comments/:cid` (status, bucket, kind, rejection learning)

**Files:**

- Modify: `server/api.ts`
- Modify: `server/api.comments.test.ts` (or wherever the PATCH test lives)

- [ ] **Step 1: Write the failing test**

Append to `server/api.comments.test.ts`:

```ts
it('PATCH a draft to accepted', async () => {
  // seed a draft
  const app = createApp();
  const res = await request(app).patch('/api/tasks/t1/comments/c1').send({ status: 'accepted' });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('accepted');
});

it('PATCH to rejected without rejection_why does NOT insert a learning', async () => {
  // seed draft + worktree
  const app = createApp();
  await request(app).patch('/api/tasks/t1/comments/c1').send({ status: 'rejected' });
  const learnings = getDb().prepare('SELECT * FROM review_learnings').all();
  expect(learnings).toHaveLength(0);
});

it('PATCH to rejected WITH rejection_why inserts a learning', async () => {
  // seed
  const app = createApp();
  await request(app)
    .patch('/api/tasks/t1/comments/c1')
    .send({ status: 'rejected', rejection_why: 'we intentionally do this' });
  const learnings = getDb()
    .prepare(`SELECT why, created_from_comment_id, repo_path FROM review_learnings`)
    .all() as Array<{ why: string; created_from_comment_id: string; repo_path: string }>;
  expect(learnings).toHaveLength(1);
  expect(learnings[0].why).toBe('we intentionally do this');
  expect(learnings[0].created_from_comment_id).toBe('c1');
  expect(learnings[0].repo_path).toBe('/repos/foo');
});

it('rejects PATCH on a published comment', async () => {
  // seed published comment
  const app = createApp();
  const res = await request(app).patch('/api/tasks/t1/comments/cpub').send({ body: 'edit' });
  expect(res.status).toBe(409);
});

it('PATCH can change kind=comment to kind=suggestion when codes provided', async () => {
  // seed draft kind=comment on a valid line
  const app = createApp();
  const res = await request(app).patch('/api/tasks/t1/comments/c1').send({
    kind: 'suggestion',
    existing_code: 'line at that file/line',
    suggested_code: 'improved',
  });
  expect(res.status).toBe(200);
  expect(res.body.kind).toBe('suggestion');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test server/api.comments.test.ts`
Expected: FAIL — the existing PATCH doesn't accept these new fields.

- [ ] **Step 3: Extend the PATCH handler in `server/api.ts`**

Replace the existing `app.patch('/api/tasks/:id/comments/:cid', ...)` with:

```ts
import { addLearning } from './review-learnings.js';

app.patch('/api/tasks/:id/comments/:cid', (req, res) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const comment = getDb()
    .prepare(`SELECT * FROM inline_comments WHERE id = ? AND task_id = ?`)
    .get(req.params.cid, req.params.id) as InlineComment | undefined;
  if (!comment) {
    res.status(404).json({ error: 'comment not found' });
    return;
  }
  if (comment.status === 'published') {
    res.status(409).json({ error: 'cannot edit a published comment; edit on GitHub instead' });
    return;
  }

  const { body, severity, bucket, status, kind, existing_code, suggested_code, rejection_why } =
    req.body as {
      body?: string;
      severity?: 'nit' | 'suggestion' | 'issue' | 'critical';
      bucket?: 'actionable' | 'informational';
      status?: 'draft' | 'accepted' | 'rejected';
      kind?: 'comment' | 'suggestion';
      existing_code?: string;
      suggested_code?: string;
      rejection_why?: string;
    };

  const allowed = ['draft', 'accepted', 'rejected'] as const;
  if (status !== undefined && !(allowed as readonly string[]).includes(status)) {
    res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
    return;
  }

  const fields: string[] = [];
  const vals: unknown[] = [];
  if (body !== undefined) {
    fields.push('body = ?');
    vals.push(body);
  }
  if (severity !== undefined) {
    fields.push('severity = ?');
    vals.push(severity);
  }
  if (bucket !== undefined) {
    fields.push('bucket = ?');
    vals.push(bucket);
  }
  if (status !== undefined) {
    fields.push('status = ?');
    vals.push(status);
  }
  if (kind !== undefined) {
    fields.push('kind = ?');
    vals.push(kind);
  }
  if (existing_code !== undefined) {
    fields.push('existing_code = ?');
    vals.push(existing_code);
  }
  if (suggested_code !== undefined) {
    fields.push('suggested_code = ?');
    vals.push(suggested_code);
  }
  if (fields.length === 0) {
    res.status(400).json({ error: 'no fields to update' });
    return;
  }

  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE inline_comments SET ${fields.join(', ')} WHERE id = ?`).run(
      ...vals,
      req.params.cid,
    );

    if (status === 'rejected' && typeof rejection_why === 'string' && rejection_why.trim()) {
      const repoPath = (
        db
          .prepare(
            `SELECT w.repo_path FROM worktrees w JOIN tasks t ON t.worktree_id = w.id WHERE t.id = ?`,
          )
          .get(task.id) as { repo_path: string } | undefined
      )?.repo_path;
      if (repoPath) {
        addLearning({
          repo_path: repoPath,
          why: rejection_why.trim(),
          created_from_comment_id: comment.id,
        });
      }
    }
  });
  tx();

  const updated = db
    .prepare(`SELECT * FROM inline_comments WHERE id = ?`)
    .get(req.params.cid) as InlineComment;
  res.json(updated);
});
```

- [ ] **Step 4: Run to verify pass**

Run: `bun run test server/api.comments.test.ts`
Expected: PASS (existing + 5 new tests).

- [ ] **Step 5: Commit**

```bash
git add server/api.ts server/api.comments.test.ts
git commit -m "feat(api): extend PATCH comments for status, bucket, kind, suggestion code, rejection learning"
```

---

## Task A3: Walkthrough edit endpoint — `PATCH /api/tasks/:id/review-runs/:rid/walkthrough`

**Files:**

- Modify: `server/api.ts`
- Modify: `server/api.review.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('PATCH walkthrough deep-merges into the latest run', async () => {
  // seed task + review_run with walkthrough '{"global":{"summary":"old"}, "groups":[]}'
  const app = createApp();
  const res = await request(app)
    .patch('/api/tasks/t1/review-runs/r1/walkthrough')
    .send({ global: { summary: 'new summary' } });
  expect(res.status).toBe(200);
  const wt = JSON.parse(res.body.walkthrough);
  expect(wt.global.summary).toBe('new summary');
});

it('refuses to edit a run that has a published_review snapshot', async () => {
  // seed
  const app = createApp();
  const res = await request(app)
    .patch('/api/tasks/t1/review-runs/r1/walkthrough')
    .send({ global: { summary: 'x' } });
  expect(res.status).toBe(409);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test server/api.review.test.ts -t "walkthrough"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `server/api.ts`:

```ts
app.patch('/api/tasks/:id/review-runs/:rid/walkthrough', (req, res) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const run = getDb()
    .prepare(`SELECT * FROM review_runs WHERE id = ? AND task_id = ?`)
    .get(req.params.rid, req.params.id) as ReviewRun | undefined;
  if (!run) {
    res.status(404).json({ error: 'run not found' });
    return;
  }
  // Refuse if a published_review for this run's head SHA already exists.
  const published = getDb()
    .prepare(`SELECT 1 FROM published_reviews WHERE task_id = ? AND head_sha = ? LIMIT 1`)
    .get(task.id, run.pr_head_sha);
  if (published) {
    res.status(409).json({ error: 'walkthrough is frozen after publish' });
    return;
  }
  const current = run.walkthrough ? (JSON.parse(run.walkthrough) as Record<string, unknown>) : {};
  const merged = deepMerge(current, req.body);
  getDb()
    .prepare(`UPDATE review_runs SET walkthrough = ? WHERE id = ?`)
    .run(JSON.stringify(merged), run.id);
  const updated = getDb()
    .prepare(`SELECT * FROM review_runs WHERE id = ?`)
    .get(run.id) as ReviewRun;
  res.json(updated);
});

function deepMerge(a: any, b: any): any {
  if (a === null || typeof a !== 'object') return b;
  if (b === null || typeof b !== 'object') return b;
  if (Array.isArray(b)) return b; // arrays are replaced, not merged
  const out: any = { ...a };
  for (const k of Object.keys(b)) {
    out[k] = k in a ? deepMerge(a[k], b[k]) : b[k];
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun run test server/api.review.test.ts -t "walkthrough"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/api.ts server/api.review.test.ts
git commit -m "feat(api): PATCH walkthrough deep-merge into latest review_run"
```

---

## Task A4: Manual re-run endpoint — `POST /api/tasks/:id/review-runs`

**Files:**

- Modify: `server/api.ts`
- Modify: `server/api.review.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('POST /api/tasks/:id/review-runs starts a new run on an idle task', async () => {
  // seed idle auto_review task at pr_head_sha='sha-h'
  const app = createApp();
  const res = await request(app).post('/api/tasks/t1/review-runs');
  expect(res.status).toBe(202);
  // startTask should have been called (mock it)
});

it('nudges the running agent when task is already running', async () => {
  // seed running task
  const app = createApp();
  const res = await request(app).post('/api/tasks/t1/review-runs');
  expect(res.status).toBe(202);
  // sendMessageToAgent should have been called
});

it('returns 409 if a run is already running for the current head', async () => {
  // seed running review_run on sha-h
  const app = createApp();
  const res = await request(app).post('/api/tasks/t1/review-runs');
  expect(res.status).toBe(409);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test server/api.review.test.ts -t "review-runs"`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { sendMessageToAgent } from './tmux-input.js';
import { startTask } from './task-runner.js';

app.post('/api/tasks/:id/review-runs', async (req, res) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  if (task.source !== 'auto_review') {
    res.status(400).json({ error: 'not an auto_review task' });
    return;
  }
  if (!task.pr_head_sha) {
    res.status(400).json({ error: 'task has no pr_head_sha' });
    return;
  }
  const existing = getDb()
    .prepare(
      `SELECT * FROM review_runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
    )
    .get(task.id) as ReviewRun | undefined;
  if (existing) {
    res.status(409).json({ error: 'a review_run is already running' });
    return;
  }

  if (task.runtime_state === 'running' && task.tmux_session) {
    const agent = getDb()
      .prepare(
        `SELECT id, window_index FROM agents WHERE task_id = ? AND status != 'stopped' ORDER BY window_index ASC LIMIT 1`,
      )
      .get(task.id) as { id: string; window_index: number } | undefined;
    if (!agent) {
      res.status(409).json({ error: 'no active agent in tmux session' });
      return;
    }
    await sendMessageToAgent(task.tmux_session, agent.window_index, manualReRunNudge());
  } else {
    await startTask(task.id);
  }
  res.status(202).json({ ok: true });
});

function manualReRunNudge(): string {
  return 'Manual re-review requested. Please open a new review_run via the review-orchestrator skill.';
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun run test server/api.review.test.ts -t "review-runs"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/api.ts server/api.review.test.ts
git commit -m "feat(api): POST /api/tasks/:id/review-runs for manual re-review"
```

---

## Task A5: Publish endpoint — `POST /api/tasks/:id/publish-review`

**Files:**

- Create: `server/publish-review.ts`
- Create: `server/publish-review.test.ts`
- Modify: `server/api.ts`

This is the biggest single backend addition. The handler:

1. Loads all `inline_comments` with `status='accepted'` for the task.
2. Validates each accepted comment's anchor line still exists at the current head; stale ones flip to `status='stale'`.
3. Loads the latest run's walkthrough as a snapshot (not posted to GitHub; just for our `published_reviews.body` audit field — and a courtesy summary if the user supplied a body string in the request).
4. Builds the GitHub payload. For `kind='suggestion'` rows, wraps the suggested_code in a ` ```suggestion ` block inside the body.
5. POSTs to `/repos/{owner}/{repo}/pulls/{n}/reviews` via the existing gh client.
6. On success: inserts a `published_reviews` row, flips accepted → published, populates `published_review_id` + `github_comment_id` from the response.
7. Broadcasts `review:published`.

- [ ] **Step 1: Write the failing test**

Create `server/publish-review.test.ts`:

````ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from './test-helpers.js';

vi.mock('./inline-comments-outdated.js', () => ({
  isAnchorOutdated: vi.fn(async () => false),
}));

const ghPostReview = vi.fn();
vi.mock('./github-client.js', () => ({
  postPullRequestReview: ghPostReview,
}));

import { publishReview } from './publish-review.js';
import { getDb } from './db.js';

function seedAcceptedDrafts(): void {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, mode, status)
     VALUES ('wt1', '/wt', '/repos/foo', 'review/x', 'main', 'new', 'available')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks (id, title, runtime_state, workflow_status, source, worktree_id, worktree, pr_url, pr_number, pr_head_sha)
     VALUES ('t1', 'PR', 'running', 'backlog', 'auto_review', 'wt1', '/wt', 'https://github.com/o/r/pull/1', 1, 'sha-h')`,
  ).run();
  db.prepare(
    `INSERT INTO review_runs (id, task_id, pr_head_sha, walkthrough, status, completed_at)
     VALUES ('r1', 't1', 'sha-h', '{"global":{}}', 'completed', datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO inline_comments
       (id, task_id, file_path, line, side, original_commit_sha, body, status, kind, severity, bucket, review_run_id)
     VALUES
       ('c1', 't1', 'a.ts', 5, 'new', 'sha-h', 'memoize this', 'accepted', 'comment', 'suggestion', 'actionable', 'r1'),
       ('c2', 't1', 'b.ts', 10, 'new', 'sha-h', 'use fromEntries', 'accepted', 'suggestion', 'nit', 'actionable', 'r1')`,
  ).run();
  db.prepare(
    `UPDATE inline_comments SET existing_code = 'old', suggested_code = 'new' WHERE id = 'c2'`,
  ).run();
}

describe('publishReview', () => {
  beforeEach(() => {
    ghPostReview.mockReset();
    seedAcceptedDrafts();
  });

  it('posts one GitHub review with all accepted drafts, wraps suggestions in ```suggestion blocks', async () => {
    ghPostReview.mockResolvedValueOnce({
      id: 123,
      html_url: 'https://github.com/o/r/pull/1#pullrequestreview-123',
      comments: [
        { id: 555, path: 'a.ts', line: 5 },
        { id: 556, path: 'b.ts', line: 10 },
      ],
    });

    const result = await publishReview({ taskId: 't1', verdict: 'COMMENT', body: 'summary' });

    expect(ghPostReview).toHaveBeenCalledTimes(1);
    const payload = ghPostReview.mock.calls[0][0];
    expect(payload.commit_id).toBe('sha-h');
    expect(payload.event).toBe('COMMENT');
    expect(payload.body).toBe('summary');
    expect(payload.comments).toHaveLength(2);
    const suggestionComment = payload.comments.find((c: any) => c.path === 'b.ts');
    expect(suggestionComment.body).toMatch(/```suggestion\nnew\n```/);

    expect(result.publishedReviewId).toBeTruthy();
    expect(result.commentCount).toBe(2);

    const rows = getDb()
      .prepare(
        `SELECT id, status, github_comment_id, published_review_id FROM inline_comments WHERE task_id = 't1'`,
      )
      .all() as any[];
    expect(rows.find((r) => r.id === 'c1').status).toBe('published');
    expect(rows.find((r) => r.id === 'c1').github_comment_id).toBe(555);
    expect(rows.find((r) => r.id === 'c2').status).toBe('published');
    expect(rows.find((r) => r.id === 'c2').github_comment_id).toBe(556);
  });

  it('flips stale lines to status=stale and excludes them from payload', async () => {
    const { isAnchorOutdated } = await import('./inline-comments-outdated.js');
    vi.mocked(isAnchorOutdated).mockImplementation(async ({ file }) => file === 'a.ts');
    ghPostReview.mockResolvedValueOnce({
      id: 123,
      html_url: 'x',
      comments: [{ id: 1, path: 'b.ts', line: 10 }],
    });

    const result = await publishReview({ taskId: 't1', verdict: 'COMMENT' });
    expect(result.staleCount).toBe(1);
    expect(result.commentCount).toBe(1);
    const c1 = getDb().prepare(`SELECT status FROM inline_comments WHERE id = 'c1'`).get() as any;
    expect(c1.status).toBe('stale');
  });

  it('returns 400 if no accepted drafts after staleness check', async () => {
    const { isAnchorOutdated } = await import('./inline-comments-outdated.js');
    vi.mocked(isAnchorOutdated).mockResolvedValue(true);
    await expect(publishReview({ taskId: 't1', verdict: 'COMMENT' })).rejects.toThrow(
      /no comments/,
    );
    expect(ghPostReview).not.toHaveBeenCalled();
  });

  it('does not persist on GitHub failure', async () => {
    ghPostReview.mockRejectedValueOnce(new Error('rate limit'));
    await expect(publishReview({ taskId: 't1', verdict: 'COMMENT' })).rejects.toThrow(/rate limit/);
    const published = getDb().prepare(`SELECT * FROM published_reviews`).all();
    expect(published).toHaveLength(0);
    const c1 = getDb().prepare(`SELECT status FROM inline_comments WHERE id = 'c1'`).get() as any;
    expect(c1.status).toBe('accepted');
  });
});
````

- [ ] **Step 2: Run to verify failure**

Run: `bun run test server/publish-review.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the GitHub client wrapper**

Create `server/github-client.ts` (or extend an existing module if there's one — `grep` for `gh api` to find any existing wrapper):

```ts
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

export interface PostReviewInput {
  owner: string;
  repo: string;
  pullNumber: number;
  commit_id: string;
  event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
  body: string;
  comments: Array<{
    path: string;
    line: number;
    side: 'RIGHT' | 'LEFT';
    start_line?: number;
    start_side?: 'RIGHT' | 'LEFT';
    body: string;
  }>;
}

export interface PostReviewResult {
  id: number;
  html_url: string;
  comments: Array<{ id: number; path: string; line: number }>;
}

export async function postPullRequestReview(input: PostReviewInput): Promise<PostReviewResult> {
  const args = [
    'api',
    '--method',
    'POST',
    `/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}/reviews`,
    '-f',
    `commit_id=${input.commit_id}`,
    '-f',
    `event=${input.event}`,
    '-f',
    `body=${input.body}`,
  ];
  // Comments via --raw-field is simpler for nested JSON
  args.push('--input', '-');

  // gh api accepts JSON via stdin with --input -
  const { stdout } = await execFile(
    'gh',
    [
      'api',
      '--method',
      'POST',
      `/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}/reviews`,
      '--input',
      '-',
    ],
    {
      input: JSON.stringify({
        commit_id: input.commit_id,
        event: input.event,
        body: input.body,
        comments: input.comments,
      }),
    } as any,
  );
  return JSON.parse(stdout) as PostReviewResult;
}
```

Verify the actual gh CLI syntax with `gh api --help` in your shell and align if needed. The intent is one `POST /repos/.../reviews` call with the JSON body above.

- [ ] **Step 4: Implement `publish-review.ts`**

Create `server/publish-review.ts`:

```ts
import { getDb } from './db.js';
import { childLogger } from './logger.js';
import { isAnchorOutdated } from './inline-comments-outdated.js';
import { recordPublishedReview } from './published-reviews.js';
import { postPullRequestReview } from './github-client.js';
import { broadcast } from './events.js';
import type { InlineComment, PublishedReviewVerdict, Task } from './types.js';

const logger = childLogger('publish-review');

export interface PublishReviewInput {
  taskId: string;
  verdict: PublishedReviewVerdict;
  body?: string;
}

export interface PublishReviewResult {
  publishedReviewId: string;
  github_review_url: string;
  commentCount: number;
  staleCount: number;
}

interface OwnerRepo {
  owner: string;
  repo: string;
}

function parseOwnerRepo(prUrl: string): OwnerRepo | null {
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export async function publishReview(input: PublishReviewInput): Promise<PublishReviewResult> {
  const db = getDb();
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(input.taskId) as Task | undefined;
  if (!task) throw new Error(`task not found: ${input.taskId}`);
  if (!task.pr_url || !task.pr_number || !task.pr_head_sha || !task.worktree) {
    throw new Error('task is missing PR metadata');
  }
  const orepo = parseOwnerRepo(task.pr_url);
  if (!orepo) throw new Error(`could not parse owner/repo from PR url ${task.pr_url}`);

  const accepted = db
    .prepare(`SELECT * FROM inline_comments WHERE task_id = ? AND status = 'accepted'`)
    .all(task.id) as InlineComment[];
  if (accepted.length === 0) throw new Error('no accepted drafts to publish');

  // Staleness check
  let staleCount = 0;
  const fresh: InlineComment[] = [];
  for (const c of accepted) {
    let outdated = false;
    try {
      outdated = await isAnchorOutdated({
        worktree: task.worktree,
        oldSha: c.original_commit_sha,
        newSha: task.pr_head_sha,
        file: c.file_path,
        line: c.line,
        side: c.side,
      });
    } catch (err) {
      logger.warn(
        { task_id: task.id, comment_id: c.id, err: (err as Error).message },
        'staleness check failed; treating as outdated',
      );
      outdated = true;
    }
    if (outdated) {
      db.prepare(`UPDATE inline_comments SET status = 'stale' WHERE id = ?`).run(c.id);
      staleCount++;
    } else {
      fresh.push(c);
    }
  }
  if (fresh.length === 0)
    throw new Error('no comments survived staleness check; nothing to publish');

  // Build payload
  const ghComments = fresh.map((c) => ({
    path: c.file_path,
    line: c.line,
    side: c.side === 'new' ? 'RIGHT' : ('LEFT' as 'LEFT'),
    body:
      c.kind === 'suggestion' && c.suggested_code !== null
        ? `${c.body}\n\n\`\`\`suggestion\n${c.suggested_code}\n\`\`\``
        : c.body,
  }));

  const result = await postPullRequestReview({
    owner: orepo.owner,
    repo: orepo.repo,
    pullNumber: task.pr_number,
    commit_id: task.pr_head_sha,
    event: input.verdict,
    body: input.body ?? '',
    comments: ghComments,
  });

  const persistTx = db.transaction(() => {
    const pubRow = recordPublishedReview({
      task_id: task.id,
      github_review_id: result.id,
      github_review_url: result.html_url ?? null,
      head_sha: task.pr_head_sha!,
      verdict: input.verdict,
      comment_count: fresh.length,
    });
    // Match GitHub response comments back to our drafts by (path, line). GitHub
    // returns them in order but path+line is the safer key.
    for (const c of fresh) {
      const gh = result.comments.find((g) => g.path === c.file_path && g.line === c.line);
      db.prepare(
        `UPDATE inline_comments
            SET status = 'published',
                published_review_id = ?,
                github_comment_id = ?
          WHERE id = ?`,
      ).run(pubRow.id, gh?.id ?? null, c.id);
    }
    return pubRow.id;
  });
  const publishedReviewId = persistTx();

  broadcast({
    type: 'review:published',
    payload: { taskId: task.id, github_review_url: result.html_url ?? null },
  });
  logger.info(
    { task_id: task.id, published_review_id: publishedReviewId, github_review_id: result.id },
    'review published',
  );

  return {
    publishedReviewId,
    github_review_url: result.html_url ?? '',
    commentCount: fresh.length,
    staleCount,
  };
}
```

- [ ] **Step 5: Register the route in `server/api.ts`**

```ts
import { publishReview } from './publish-review.js';

app.post('/api/tasks/:id/publish-review', async (req, res) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const { verdict, body } = req.body as { verdict?: string; body?: string };
  if (!verdict || !['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(verdict)) {
    res.status(400).json({ error: 'verdict must be COMMENT, APPROVE, or REQUEST_CHANGES' });
    return;
  }
  try {
    const result = await publishReview({
      taskId: req.params.id,
      verdict: verdict as 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES',
      body,
    });
    res.json(result);
  } catch (err) {
    const msg = (err as Error).message;
    const status = /no .*(?:drafts|comments)/.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});
```

- [ ] **Step 6: Run to verify pass**

Run: `bun run test server/publish-review.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add server/publish-review.ts server/publish-review.test.ts server/github-client.ts server/api.ts
git commit -m "feat(api): POST /api/tasks/:id/publish-review with suggestion-block wrapping"
```

---

## Task A6: Learnings CRUD endpoints

**Files:**

- Modify: `server/api.ts`
- Modify: `server/api.review.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('GET /api/repos/:repoPath/learnings returns learnings', async () => {
  // seed two learnings under repoPath
  const app = createApp();
  const res = await request(app).get(`/api/repos/${encodeURIComponent('/repos/foo')}/learnings`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(2);
});

it('DELETE /api/learnings/:id removes a row', async () => {
  // seed one
  const app = createApp();
  const res = await request(app).delete('/api/learnings/L1');
  expect(res.status).toBe(204);
  expect(getDb().prepare('SELECT * FROM review_learnings WHERE id = "L1"').get()).toBeUndefined();
});
```

- [ ] **Step 2: Implement**

```ts
import { listLearningsForRepo, deleteLearning } from './review-learnings.js';

app.get('/api/repos/:repoPath/learnings', (req, res) => {
  const path = decodeURIComponent(req.params.repoPath);
  res.json(listLearningsForRepo(path));
});

app.delete('/api/learnings/:id', (req, res) => {
  deleteLearning(req.params.id);
  res.status(204).send();
});
```

- [ ] **Step 3: Run to verify pass**

Run: `bun run test server/api.review.test.ts -t "learnings"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/api.ts server/api.review.test.ts
git commit -m "feat(api): GET/DELETE learnings per repo"
```

---

## Phase B — Frontend routing + sidebar

## Task B1: Add `/reviews` + `/reviews/:id` routes; sidebar entry

**Files:**

- Modify: `src/App.tsx`
- Modify: `src/components/layout/<Sidebar>` (grep to find)

- [ ] **Step 1: Add the routes**

In `src/App.tsx`, add inside the `<Routes>`:

```tsx
<Route path="/reviews" element={<ReviewsPage />} />
<Route path="/reviews/:id" element={<ReviewDetailPage />} />
```

Import the components from `./pages/ReviewsPage` and `./pages/ReviewDetailPage` (placeholder for now — content lands in Phase C/D).

- [ ] **Step 2: Add the sidebar entry**

Add a "Reviews" link in the sidebar between "Tasks" and "Workspaces". Match the existing styling and icon convention (the project already has Lucide icons — pick `MessageSquareCode` or `GitPullRequestArrow`). The badge displays the count of inbox rows whose `status` is `drafts-ready` or `head-advanced`. Fetch this via the existing client polling pattern (or SSE if there's an inbox-updated event); poll `/api/reviews` every 10s.

- [ ] **Step 3: Create placeholder pages**

Create stub `src/pages/ReviewsPage.tsx`:

```tsx
export default function ReviewsPage() {
  return <div>Reviews inbox (placeholder)</div>;
}
```

Create stub `src/pages/ReviewDetailPage.tsx`:

```tsx
import { useParams } from 'react-router-dom';

export default function ReviewDetailPage() {
  const { id } = useParams();
  return <div>Review detail for {id} (placeholder)</div>;
}
```

- [ ] **Step 4: Run dev + sanity check the routes**

Run: `bun run dev`
Navigate to `http://localhost:5173/reviews` and `/reviews/x`. Expected: placeholder text renders.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/layout src/pages/ReviewsPage.tsx src/pages/ReviewDetailPage.tsx
git commit -m "feat(routes): /reviews + /reviews/:id placeholders and sidebar entry"
```

---

## Task B2: Filter auto_review from `/tasks` + redirect `/tasks/:id` for auto_review

**Files:**

- Modify: `src/pages/TasksPage.tsx`
- Modify: `src/pages/TaskDetail.tsx`
- Modify: `src/pages/TasksPage.test.tsx`
- Modify: `src/pages/TaskDetail.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `TasksPage.test.tsx`:

```ts
it('hides tasks with source=auto_review from the list', async () => {
  mockApi.tasks.list.mockResolvedValueOnce([
    makeTask({ id: 'a', source: null, title: 'normal' }),
    makeTask({ id: 'b', source: 'auto_review', title: 'PR review' }),
  ]);
  renderWithRouter(<TasksPage />);
  expect(await screen.findByText('normal')).toBeTruthy();
  expect(screen.queryByText('PR review')).toBeNull();
});
```

In `TaskDetail.test.tsx`:

```ts
it('redirects to /reviews/:id for auto_review tasks', async () => {
  mockApi.tasks.get.mockResolvedValueOnce(makeTask({ id: 'b', source: 'auto_review' }));
  const { navigate } = renderWithRouter(<TaskDetail />, { initialEntries: ['/tasks/b'] });
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/reviews/b', { replace: true }));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test src/pages/TasksPage.test.tsx src/pages/TaskDetail.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement filtering and redirect**

In `TasksPage.tsx`, where the tasks list is rendered:

```tsx
const visible = tasks.filter((t) => t.source !== 'auto_review');
```

In `TaskDetail.tsx`, on data load:

```tsx
useEffect(() => {
  if (task?.source === 'auto_review') navigate(`/reviews/${task.id}`, { replace: true });
}, [task, navigate]);
```

- [ ] **Step 4: Run to verify pass**

Run: `bun run test src/pages/TasksPage.test.tsx src/pages/TaskDetail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/TasksPage.tsx src/pages/TaskDetail.tsx src/pages/TasksPage.test.tsx src/pages/TaskDetail.test.tsx
git commit -m "feat(tasks): hide auto_review from /tasks and redirect /tasks/:id to /reviews/:id"
```

---

## Phase C — Reviews inbox

## Task C1: Inbox page

**Files:**

- Modify: `src/pages/ReviewsPage.tsx`
- Create: `src/pages/ReviewsPage.test.tsx`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the client function**

In `src/lib/api.ts`:

```ts
export type ReviewInboxRow = {
  task_id: string;
  pr_number: number;
  pr_url: string;
  pr_title: string;
  pr_head_sha: string;
  author_login: string | null;
  repo_path: string;
  status: 'reviewing' | 'drafts-ready' | 'head-advanced' | 'published' | 'failed';
  draft_count: number;
  accepted_count: number;
  rejected_count: number;
  stale_count: number;
  last_activity_at: string;
};

export async function listReviewsInbox(): Promise<ReviewInboxRow[]> {
  const res = await fetch('/api/reviews');
  if (!res.ok) throw new Error(`reviews list failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Write the failing test**

Create `src/pages/ReviewsPage.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import ReviewsPage from './ReviewsPage';
import { renderWithRouter, mockApi } from '../test-helpers';

describe('ReviewsPage', () => {
  it('renders one row per inbox entry grouped by repo', async () => {
    mockApi.reviews = {
      list: vi.fn().mockResolvedValueOnce([
        {
          task_id: 't1',
          pr_number: 1,
          pr_url: 'u',
          pr_title: 'Add foo',
          pr_head_sha: 's',
          author_login: 'alice',
          repo_path: '/repos/foo',
          status: 'drafts-ready',
          draft_count: 8,
          accepted_count: 4,
          rejected_count: 2,
          stale_count: 1,
          last_activity_at: '2026-05-28',
        },
        {
          task_id: 't2',
          pr_number: 2,
          pr_url: 'u',
          pr_title: 'Fix bar',
          pr_head_sha: 's',
          author_login: 'bob',
          repo_path: '/repos/foo',
          status: 'reviewing',
          draft_count: 0,
          accepted_count: 0,
          rejected_count: 0,
          stale_count: 0,
          last_activity_at: '2026-05-28',
        },
      ]),
    };
    renderWithRouter(<ReviewsPage />);
    expect(await screen.findByText('Add foo')).toBeTruthy();
    expect(await screen.findByText('Fix bar')).toBeTruthy();
    expect(screen.getByText(/drafts-ready/)).toBeTruthy();
    expect(screen.getByText(/reviewing/)).toBeTruthy();
  });

  it('clicking a row navigates to /reviews/:id', async () => {
    // ... similar setup, fireEvent.click, assert navigate
  });

  it('shows an empty state when no reviews are pending', async () => {
    mockApi.reviews = { list: vi.fn().mockResolvedValueOnce([]) };
    renderWithRouter(<ReviewsPage />);
    expect(await screen.findByText(/no open review requests/i)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun run test src/pages/ReviewsPage.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement**

Replace the placeholder in `src/pages/ReviewsPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listReviewsInbox, type ReviewInboxRow } from '../lib/api';
import { Card } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

const STATUS_PILL: Record<
  ReviewInboxRow['status'],
  { label: string; tone: 'default' | 'secondary' | 'destructive' }
> = {
  reviewing: { label: 'reviewing', tone: 'secondary' },
  'drafts-ready': { label: 'drafts ready', tone: 'default' },
  'head-advanced': { label: 'head advanced', tone: 'secondary' },
  published: { label: 'published', tone: 'secondary' },
  failed: { label: 'failed', tone: 'destructive' },
};

export default function ReviewsPage() {
  const [rows, setRows] = useState<ReviewInboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  useEffect(() => {
    let cancelled = false;
    listReviewsInbox()
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const tick = setInterval(() => {
      listReviewsInbox()
        .then((r) => {
          if (!cancelled) setRows(r);
        })
        .catch(() => {});
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, []);

  if (loading) return <div className="p-6">Loading…</div>;
  if (rows.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">No open review requests right now.</div>
    );
  }

  // Group by repo_path
  const byRepo = new Map<string, ReviewInboxRow[]>();
  for (const r of rows) {
    const list = byRepo.get(r.repo_path) ?? [];
    list.push(r);
    byRepo.set(r.repo_path, list);
  }

  return (
    <div className="p-6 space-y-6">
      {Array.from(byRepo.entries()).map(([repo, repoRows]) => (
        <section key={repo}>
          <h2 className="text-sm font-medium text-muted-foreground mb-2">{repo}</h2>
          <div className="space-y-2">
            {repoRows.map((r) => (
              <Card
                key={r.task_id}
                className="p-4 cursor-pointer hover:bg-muted"
                onClick={() => nav(`/reviews/${r.task_id}`)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium">{r.pr_title}</span>
                  <span className="text-xs text-muted-foreground">#{r.pr_number}</span>
                  <Badge variant={STATUS_PILL[r.status].tone}>{STATUS_PILL[r.status].label}</Badge>
                  {r.author_login && (
                    <span className="text-xs text-muted-foreground">by @{r.author_login}</span>
                  )}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {r.accepted_count} accepted · {r.draft_count} drafts · {r.rejected_count} rejected
                  {r.stale_count > 0 && ` · ${r.stale_count} stale`}
                </div>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Run to verify pass**

Run: `bun run test src/pages/ReviewsPage.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pages/ReviewsPage.tsx src/pages/ReviewsPage.test.tsx src/lib/api.ts
git commit -m "feat(reviews): inbox page grouped by repo with status pills"
```

---

## Phase D — Review detail

Phase D is the biggest single workstream. Tasks are split so each commit is small.

## Task D1: ReviewDetailPage scaffold + data loading

**Files:**

- Modify: `src/pages/ReviewDetailPage.tsx`
- Create: `src/pages/ReviewDetailPage.test.tsx`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the client function**

In `src/lib/api.ts`:

```ts
export type ReviewDetail = {
  task: {
    id: string;
    title: string;
    pr_url: string;
    pr_head_sha: string;
    pr_number: number;
    repo_path: string;
  };
  latest_run: {
    id: string;
    pr_head_sha: string;
    walkthrough: string | null;
    status: string;
  } | null;
  all_runs: Array<{
    id: string;
    pr_head_sha: string;
    status: string;
    started_at: string;
    completed_at: string | null;
  }>;
  comments: InlineCommentDTO[];
  published_history: Array<{
    id: string;
    github_review_url: string | null;
    published_at: string;
    verdict: string;
    comment_count: number;
  }>;
};

export type InlineCommentDTO = {
  id: string;
  task_id: string;
  file_path: string;
  line: number;
  side: 'new' | 'old';
  body: string;
  status: 'draft' | 'accepted' | 'rejected' | 'published' | 'stale';
  kind: 'comment' | 'suggestion';
  severity: 'nit' | 'suggestion' | 'issue' | 'critical' | null;
  bucket: 'actionable' | 'informational' | null;
  existing_code: string | null;
  suggested_code: string | null;
  re_flag_of: string | null;
  auto_resolved_at: string | null;
  auto_resolved_reason: string | null;
  github_comment_id: number | null;
  review_run_id: string | null;
};

export async function getReviewDetail(taskId: string): Promise<ReviewDetail> {
  const res = await fetch(`/api/reviews/${taskId}`);
  if (!res.ok) throw new Error(`review detail failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: Write the failing test**

Create `src/pages/ReviewDetailPage.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import ReviewDetailPage from './ReviewDetailPage';
import { renderWithRouter, mockApi } from '../test-helpers';

describe('ReviewDetailPage', () => {
  it('renders the PR title from review detail', async () => {
    mockApi.reviews = {
      ...mockApi.reviews,
      get: vi.fn().mockResolvedValueOnce({
        task: {
          id: 't1',
          title: 'Add foo',
          pr_url: '',
          pr_head_sha: 's',
          pr_number: 1,
          repo_path: '/r',
        },
        latest_run: null,
        all_runs: [],
        comments: [],
        published_history: [],
      }),
    };
    renderWithRouter(<ReviewDetailPage />, { initialEntries: ['/reviews/t1'] });
    expect(await screen.findByText('Add foo')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Implement the scaffold**

Replace `src/pages/ReviewDetailPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getReviewDetail, type ReviewDetail } from '../lib/api';

export default function ReviewDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    getReviewDetail(id)
      .then(setDetail)
      .catch((e) => setError((e as Error).message));
  }, [id]);

  if (error) return <div className="p-6 text-red-600">{error}</div>;
  if (!detail) return <div className="p-6">Loading…</div>;
  return (
    <div className="p-6 space-y-6">
      <header className="flex items-baseline gap-2">
        <h1 className="text-lg font-medium">{detail.task.title}</h1>
        <span className="text-xs text-muted-foreground">#{detail.task.pr_number}</span>
      </header>
      {/* WalkthroughTree, PublishBar, ReviewFilters, comment cards come in subsequent tasks */}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun run test src/pages/ReviewDetailPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/ReviewDetailPage.tsx src/pages/ReviewDetailPage.test.tsx src/lib/api.ts
git commit -m "feat(reviews): /reviews/:id scaffold loads detail JSON"
```

---

## Task D2: `WalkthroughTree` component (scalar pill bar + collapsible groups)

**Files:**

- Create: `src/components/review/WalkthroughTree.tsx`
- Create: `src/components/review/WalkthroughTree.test.tsx`
- Modify: `src/pages/ReviewDetailPage.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WalkthroughTree } from './WalkthroughTree';

const WT = {
  global: {
    type: 'Enhancement',
    risk: 'low',
    effort: 2,
    relevant_tests: 'yes',
    security_concerns: null,
    ticket_compliance: [],
    summary: 'adds X',
    key_review_points: ['look at Y'],
  },
  groups: [
    {
      name: 'Schema',
      summary: 's',
      files: [{ path: 'a.ts', label: 'dependencies', summary: 'd' }],
    },
  ],
};

describe('WalkthroughTree', () => {
  it('renders scalar pill bar with type, risk, effort, tests', () => {
    render(<WalkthroughTree walkthrough={WT} onEditSection={() => {}} />);
    expect(screen.getByText('Enhancement')).toBeTruthy();
    expect(screen.getByText(/Effort 2\/5/)).toBeTruthy();
    expect(screen.getByText(/Tests: yes/)).toBeTruthy();
  });

  it('renders groups and files', () => {
    render(<WalkthroughTree walkthrough={WT} onEditSection={() => {}} />);
    expect(screen.getByText('Schema')).toBeTruthy();
    expect(screen.getByText('a.ts')).toBeTruthy();
  });

  it('shows ticket_compliance pill when entries exist', () => {
    const wt = {
      ...WT,
      global: {
        ...WT.global,
        ticket_compliance: [{ ticket: 'IN-1', status: 'partially' as const }],
      },
    };
    render(<WalkthroughTree walkthrough={wt} onEditSection={() => {}} />);
    expect(screen.getByText(/IN-1/)).toBeTruthy();
    expect(screen.getByText(/partially/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test src/components/review/WalkthroughTree.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/components/review/WalkthroughTree.tsx`. Render the structure shown in the spec's UI mockup: scalar pill bar at top, then summary + key_review_points, then collapsible groups, each containing one-line file entries (path + `[label]` chip + summary). Use shadcn `<Collapsible>` or `<details>` natively. Pass `onEditSection({ kind: 'global' | 'group' | 'file', key })` so the parent can render an inline markdown editor.

(Implementation roughly 80–120 lines; follow existing component conventions in `src/components/`.)

- [ ] **Step 4: Wire into ReviewDetailPage**

In `ReviewDetailPage.tsx`, after the header:

```tsx
{
  detail.latest_run?.walkthrough && (
    <WalkthroughTree
      walkthrough={JSON.parse(detail.latest_run.walkthrough)}
      onEditSection={() => {
        /* hook up in Task D3 */
      }}
    />
  );
}
```

- [ ] **Step 5: Run to verify pass**

Run: `bun run test src/components/review/WalkthroughTree.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/review/WalkthroughTree.tsx src/components/review/WalkthroughTree.test.tsx src/pages/ReviewDetailPage.tsx
git commit -m "feat(reviews): WalkthroughTree with scalar pills + collapsible groups"
```

---

## Task D3: Walkthrough section edit affordance

**Files:**

- Modify: `src/components/review/WalkthroughTree.tsx`
- Modify: `src/pages/ReviewDetailPage.tsx`
- Modify: `src/lib/api.ts`

Add per-section "Edit" buttons that open a modal (or inline textarea) with markdown for that section only. On save, PATCH `/api/tasks/:id/review-runs/:rid/walkthrough` with the partial JSON.

- [ ] Tests: section edit opens textarea, save calls api with deep partial.
- [ ] Implement.
- [ ] Commit.

```bash
git commit -m "feat(reviews): per-section walkthrough edit"
```

---

## Task D4: `InlineCommentCard` for kind=comment

**Files:**

- Create: `src/components/review/InlineCommentCard.tsx`
- Create: `src/components/review/InlineCommentCard.test.tsx`

- [ ] Tests verify rendering of:
  - severity chip (color/icon per `nit | suggestion | issue | critical`)
  - bucket chip (`actionable` vs `informational` muted)
  - Accept / Reject / Edit buttons
  - Action buttons call the patched comment API
- [ ] Implement with the rendering shown in the spec UI mockup. Use shadcn `Card`, `Badge`, `Button`. Edit mode swaps body to a textarea + Save/Cancel.
- [ ] Commit:

```bash
git commit -m "feat(reviews): InlineCommentCard for kind=comment with accept/reject/edit"
```

---

## Task D5: `InlineCommentCard` for kind=suggestion (patch preview)

**Files:**

- Modify: `src/components/review/InlineCommentCard.tsx`
- Modify: `src/components/review/InlineCommentCard.test.tsx`

- [ ] Tests verify:
  - `kind=suggestion` shows a `🔧 patch` chip and an inline two-line diff preview (existing → suggested) rendered with the existing diff styles
  - Edit mode for suggestions exposes two textareas (existing_code, suggested_code) plus body
  - Accept includes the suggestion code in the saved row
- [ ] Implement. Reuse the existing token-level diff highlighter if available; otherwise plain monospace with `+`/`-` prefixes is acceptable for v1.
- [ ] Commit:

```bash
git commit -m "feat(reviews): InlineCommentCard renders kind=suggestion patch preview"
```

---

## Task D6: Re-flag badge, auto-resolved dim-and-sink, stale warnings

**Files:**

- Modify: `src/components/review/InlineCommentCard.tsx`
- Modify: `src/components/review/InlineCommentCard.test.tsx`
- Modify: `src/pages/ReviewDetailPage.tsx`

- [ ] Tests:
  - `re_flag_of != null` renders the `↻ re-flag of #abc` badge linking to anchor `#comment-abc`
  - `auto_resolved_at != null` renders the card dimmed (`opacity-60`) with a `✓ resolved` chip; hover shows `auto_resolved_reason`
  - `status='stale'` renders a yellow border + warning that the line moved
- [ ] Implement. Sort order in the file's comment list: open + accepted first, then stale, then auto-resolved.
- [ ] Commit:

```bash
git commit -m "feat(reviews): re-flag badge, auto-resolved dim+sink, stale warning"
```

---

## Task D7: `ReviewFilters` component (severity / bucket / kind / show resolved)

**Files:**

- Create: `src/components/review/ReviewFilters.tsx`
- Create: `src/components/review/ReviewFilters.test.tsx`
- Modify: `src/pages/ReviewDetailPage.tsx`

- [ ] Tests verify filter state in URL search params: `?severity=issue,critical&bucket=actionable&kind=comment&resolved=hidden`. Toggles update the URL; ReviewDetailPage reads URL params and passes to comment cards / hides accordingly.
- [ ] Implement with shadcn `<ToggleGroup>` or button group; persist via React Router's `useSearchParams`.
- [ ] Commit:

```bash
git commit -m "feat(reviews): ReviewFilters pill bar bound to URL params"
```

---

## Task D8: `PublishBar` with verdict dropdown + counts

**Files:**

- Create: `src/components/review/PublishBar.tsx`
- Create: `src/components/review/PublishBar.test.tsx`
- Modify: `src/pages/ReviewDetailPage.tsx`
- Modify: `src/lib/api.ts`

- [ ] Add client function `publishReview(taskId, { verdict, body })`.
- [ ] Tests:
  - Bar shows `N accepted · M drafts · K stale`
  - Verdict dropdown defaults to `Comment`; options `Comment | Approve | Request changes`
  - Publish button disabled when accepted_count == 0
  - Click calls api with correct verdict; on success, refreshes detail; on failure, surfaces error toast
- [ ] Implement as a sticky top section on `/reviews/:id`. Use shadcn `Select` for verdict.
- [ ] Commit:

```bash
git commit -m "feat(reviews): PublishBar with verdict dropdown and counts"
```

---

## Task D9: `RejectDialog` with "remember this" learning capture

**Files:**

- Create: `src/components/review/RejectDialog.tsx`
- Create: `src/components/review/RejectDialog.test.tsx`
- Modify: `src/components/review/InlineCommentCard.tsx`

- [ ] Tests:
  - Dialog opens when clicking Reject on a card
  - Two buttons: "Reject only" PATCHes with `{ status: 'rejected' }`; "Reject + remember this" PATCHes with `{ status: 'rejected', rejection_why: <text> }`
  - Why field is optional; "Reject + remember this" disabled when empty
- [ ] Implement using shadcn `Dialog`.
- [ ] Commit:

```bash
git commit -m "feat(reviews): RejectDialog captures optional rejection_why as a learning"
```

---

## Task D10: Re-run button

**Files:**

- Modify: `src/components/review/PublishBar.tsx` (or a sibling header strip)
- Modify: `src/lib/api.ts`

- [ ] Add `requestReReview(taskId)` client → `POST /api/tasks/:id/review-runs`.
- [ ] Disabled when a `review_run.status='running'` exists for the task.
- [ ] On success, toast "Re-review started" and refresh detail.
- [ ] Tests + commit:

```bash
git commit -m "feat(reviews): Re-run button triggers POST /api/tasks/:id/review-runs"
```

---

## Task D11: `HeadAdvancedBanner` (live SSE while triaging)

**Files:**

- Create: `src/components/review/HeadAdvancedBanner.tsx`
- Modify: `src/pages/ReviewDetailPage.tsx`

- [ ] Subscribe to the existing SSE/WS stream for `review:head-advanced` / `review:drafts-ready` / `review:run-failed`.
- [ ] When `head-advanced` fires for the current task, show a banner with the new SHA and a "Re-run incremental review" button (auto-fires the re-run if not already running).
- [ ] When `drafts-ready` fires after a head advance, dismiss the banner and silently refresh `getReviewDetail`.
- [ ] Tests use a fake SSE source. Commit:

```bash
git commit -m "feat(reviews): HeadAdvancedBanner reacts to SSE while triaging"
```

---

## Phase E — Settings: learnings panel

## Task E1: `LearningsPanel` in settings

**Files:**

- Create: `src/components/settings/LearningsPanel.tsx`
- Create: `src/components/settings/LearningsPanel.test.tsx`
- Modify: `src/pages/SettingsPage.tsx`
- Modify: `src/lib/api.ts`

- [ ] Client functions: `listLearnings(repoPath)`, `deleteLearning(id)`.
- [ ] UI: list rows showing `why` (markdown-rendered), `usage_count`, `last_used_at`, with a Delete button per row. Per-repo selector at top (defaults to the currently focused repo if there's a global "current repo" context; otherwise asks the user to pick).
- [ ] Tests: list renders rows, delete removes a row optimistically.
- [ ] Mount under a new "Reviews" tab/section in `SettingsPage.tsx`.
- [ ] Commit:

```bash
git commit -m "feat(settings): per-repo Learnings panel for reject-driven learnings"
```

---

## Phase F — E2E + final pass

## Task F1: Playwright happy-path E2E

**Files:**

- Create: `e2e/review-orchestrator.spec.ts`
- Create: `e2e/helpers-review.ts`

The E2E test should not depend on a real Claude agent. Seed a review task directly via DB / API into `drafts-ready` state with two draft comments — one kind=comment, one kind=suggestion — then drive the UI:

- [ ] `createReviewFixture` helper: creates a task with `source='auto_review'`, a `review_runs` row with a valid walkthrough JSON, and two `inline_comments` drafts.
- [ ] Test path:
  1. Navigate to `/reviews`
  2. Click the seeded review
  3. Expect WalkthroughTree, two comment cards visible
  4. Accept the kind=comment card
  5. Accept the kind=suggestion card
  6. Click "Publish review"
  7. Stub the gh CLI invocation (env var or test fixture that intercepts the gh subprocess) to return a canned response
  8. Expect the PublishBar updates to show "Published" and the comments transition to dimmed `status=published`
- [ ] Commit:

```bash
git commit -m "test(e2e): Playwright happy-path for review orchestrator"
```

---

## Task F2: Full pass

- [ ] `bun run typecheck` → no errors
- [ ] `bun run test` → green
- [ ] `bun run lint` → no errors
- [ ] `bun run test:e2e` → green
- [ ] Manual smoke test against a real open PR:
  1. Confirm the inbox shows it.
  2. Confirm the walkthrough renders.
  3. Accept a single draft, hit Publish, confirm the GitHub PR shows a new review with that one inline comment (and, if kind=suggestion, a ` ```suggestion ` block apply-able by the author).
  4. Push a new commit to the PR. Watch the banner fire, the new `review_run` complete, and the re-flag drafts appear if there were unresolved published comments.

---

## Self-review checklist

- [ ] Every new endpoint in `server/api.ts` has a supertest test in `server/api.review.test.ts` (or its sibling file).
- [ ] The PATCH `/api/tasks/:id/comments/:cid` handler explicitly refuses transitions on `status='published'`.
- [ ] The publish endpoint's all-or-nothing semantics are preserved: the DB transaction wraps both the `published_reviews` insert and the per-comment updates so a failure rolls everything back.
- [ ] `kind=suggestion` rows are wrapped in ` ```suggestion ` blocks on publish. `kind=comment` rows are not.
- [ ] The walkthrough is never sent to GitHub. The publish payload's `body` field is the user-supplied summary (often empty), not the walkthrough JSON.
- [ ] `/tasks` hides auto_review rows; `/tasks/:id` for auto_review redirects to `/reviews/:id`.
- [ ] The sidebar "Reviews" badge counts only `drafts-ready` + `head-advanced` statuses, not `reviewing` or `published`.
- [ ] Auto-resolved comments are dim+sunk in the UI but still visible (Devin pattern); clicking shows the auto_resolved_reason.

## Done criteria

- All test suites green (`bun run test`, `bun run test:e2e`, `bun run typecheck`, `bun run lint`).
- A real PR review can be drafted, triaged, and published end-to-end against an actual repo via the dashboard.
- Rejecting a draft with a "why" string creates a `review_learnings` row that survives across review_runs.
- Pushing new commits to a published PR triggers an automatic incremental re-review without manual intervention; the banner fires and previously-unresolved comments are re-flagged as fresh drafts.

Step 3 ships the user-facing experience and completes the orchestrator feature. Future work parked in the spec's "Out of scope" section can land independently.
