# Review Orchestrator — Step 2: Backend (data model, CLI, skill, poller)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the review orchestrator produce structured drafts (walkthrough JSON + inline draft comments) in the database whenever a PR awaits the user's review. No UI yet — Step 3 builds that. By the end of Step 2, the engineer can: open `~/.octomux/octomux.sqlite`, run an auto-review task, and watch `review_runs` and `inline_comments` rows populate as the agent works; force-push to the PR head and watch a second `review_run` land via the poller's automatic incremental re-review.

**Architecture:** One forward-only SQL migration adds three tables (`review_runs`, `published_reviews`, `review_learnings`) and 14 columns to `inline_comments`. New thin DB helper modules (`server/review-runs.ts`, `server/published-reviews.ts`, `server/review-learnings.ts`, `server/review-staleness.ts`, `server/instruction-files.ts`) own all reads/writes to the new tables; the existing `server/inline-comments.ts` is extended (not rewritten) to accept the new optional columns. A new `cli/review/` subcommand tree opens the same SQLite DB synchronously (via the existing `bin/octomux.js` pattern) so the agent inside the worktree's tmux pane can write structured output via `octomux review <subcommand>` calls. A new agent skill `skills/review-orchestrator/SKILL.md` teaches the agent to drive this CLI. The poller (`server/poller.ts`) is extended to auto-start auto-review tasks instead of leaving them idle, to `git fetch && git checkout` to the new head before nudging the agent on re-review, and to fall back to a full re-review when the prior head is unreachable. A watchdog tick fails stuck `review_runs` after 15 minutes.

**Tech Stack:** TypeScript, better-sqlite3 (SQLite 3.49+), Express 5, vitest, pino logger, nanoid(12), node-pty + tmux for runtime. ESM modules. CLI uses the `commander`-style pattern already present in `bin/octomux.js`.

**Spec reference:** `docs/superpowers/specs/2026-05-27-review-orchestrator-design.md`. Step 2 implements sections 2 (data model), 3 (runtime / orchestration flow) including the auto-staleness, draft carry-forward, incremental re-review, force-push fallback, update-while-triaging signal, watchdog, and the new CLI surface; plus the `review-orchestrator` skill. Step 3 implements section 4 (publish + UI) and section 5's GitHub-side failure-mode handling.

**Working assumptions about the codebase** (verify with the current source, do not rely on memory):

- `server/db.ts` exposes `getDb()` and an init function that runs `CREATE TABLE IF NOT EXISTS` statements in declared order; new statements append to the existing block.
- `server/db.ts` already has the helper `addColumn(table, name, ddl, cols)` (used by previous migrations). Reuse it.
- `server/test-helpers.ts` exports `createTestDb()` which calls `setDb()` for isolation. All DB tests use this.
- `server/inline-comments.ts` exposes `addComment`, `listComments`, `getComment` today. Extend its `AddCommentInput` interface; do not invent a second module.
- `server/inline-comments-outdated.ts` already has the line-comparison logic (`gitShow(worktree, sha, relPath)` etc.). Reuse it from `server/review-staleness.ts`.
- `bin/octomux.js` dispatches subcommands by argv[2]. Add a `review` case that hands off to `cli/review/index.ts`.
- The existing `cli/` directory has subcommand modules (`create-task.ts`, `list-tasks.ts`, etc.) using `parseArgs` from `node:util`. Mirror that pattern.
- `server/poller.ts` exports `pollReviewerRequests`. `upsertReviewTask` returns the action verb. The integration test pattern is in `server/poller.test.ts`.
- `server/task-runner.ts` exports `createTask` (a.k.a. the lifecycle entry point). Confirm exact function name with `grep` and use whichever is exported.
- All server logs go through `childLogger('<module>')`. Never `console.*` in `server/`. CLI commands print to stdout/stderr directly (they are intentional output channels, not log calls).
- Conventional Commits, kebab-case scopes, 100-char header. Never add `Co-Authored-By:` trailers.
- Tests run with `bun run test`. CLI integration tests use a real temp DB created via `createTestDb()` and shell-invoke the CLI through `execFile` with `NODE_ENV=test`.

---

## File structure

### New files

| Path                                  | Responsibility                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------- | ------------- | -------------- | -------- | ----------- |
| `server/review-runs.ts`               | CRUD for `review_runs`: `createReviewRun`, `getReviewRun`, `getCurrentRun(taskId)`, `completeRun`, `failRun`. |
| `server/review-runs.test.ts`          |                                                                                                               |
| `server/published-reviews.ts`         | CRUD for `published_reviews`. Used by Step 3 but defined here so types are stable.                            |
| `server/published-reviews.test.ts`    |                                                                                                               |
| `server/review-learnings.ts`          | CRUD for `review_learnings`: `addLearning`, `touchLearning`, `listLearningsForRepo`, `deleteLearning`.        |
| `server/review-learnings.test.ts`     |                                                                                                               |
| `server/review-staleness.ts`          | `markStaleDrafts(taskId, newHeadSha)` and `autoResolvePublished(taskId, run)`.                                |
| `server/review-staleness.test.ts`     |                                                                                                               |
| `server/instruction-files.ts`         | `findInstructionFiles(worktreePath)` — Devin-style glob + parent-scope inheritance.                           |
| `server/instruction-files.test.ts`    |                                                                                                               |
| `server/walkthrough.ts`               | TypeScript types for the structured `Walkthrough` JSON + a `validateWalkthrough(input, diffFiles)` function.  |
| `server/walkthrough.test.ts`          |                                                                                                               |
| `cli/review/index.ts`                 | Subcommand dispatcher (`start                                                                                 | walkthrough | draft-comment | check-previous | complete | learning`). |
| `cli/review/start.ts`                 | Implements `octomux review start --task <id>`.                                                                |
| `cli/review/start.test.ts`            |                                                                                                               |
| `cli/review/walkthrough.ts`           | Implements `octomux review walkthrough --task <id> --json-file <path>`.                                       |
| `cli/review/walkthrough.test.ts`      |                                                                                                               |
| `cli/review/draft-comment.ts`         | Implements `octomux review draft-comment ...` (kind=comment and kind=suggestion).                             |
| `cli/review/draft-comment.test.ts`    |                                                                                                               |
| `cli/review/check-previous.ts`        | Implements `octomux review check-previous ...`.                                                               |
| `cli/review/check-previous.test.ts`   |                                                                                                               |
| `cli/review/complete.ts`              | Implements `octomux review complete --task <id>`; runs auto-resolve.                                          |
| `cli/review/complete.test.ts`         |                                                                                                               |
| `cli/review/learning.ts`              | Implements `octomux review learning add                                                                       | touch`.     |
| `cli/review/learning.test.ts`         |                                                                                                               |
| `skills/review-orchestrator/SKILL.md` | Agent skill: read instruction files, produce walkthrough + drafts via CLI.                                    |

### Modified files

| Path                        | Change                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `server/db.ts`              | Append the migration: `review_runs`, `published_reviews`, `review_learnings`, and 14 columns on `inline_comments`.            |
| `server/types.ts`           | Add `ReviewRun`, `PublishedReview`, `ReviewLearning`, expanded `InlineComment` fields, `Walkthrough` JSON types.              |
| `server/inline-comments.ts` | Extend `AddCommentInput` and `addComment` to accept the new optional fields. Backward-compatible.                             |
| `server/poller.ts`          | Auto-start auto-review tasks; pre-fetch and checkout new head before nudging; force-push fallback; watchdog tick.             |
| `server/poller.test.ts`     | New tests for auto-start, force-push fallback, watchdog. Update existing nudge tests to expect the prior `git checkout` call. |
| `bin/octomux.js`            | Register the new `review` subcommand.                                                                                         |

---

## Phase A — Schema migration & types

## Task A1: Add the migration to `server/db.ts`

**Files:**

- Modify: `server/db.ts` (append to the init/migration block)
- Modify: `server/db.test.ts` (assert new tables/columns exist)

- [ ] **Step 1: Write the failing test**

Append to `server/db.test.ts`:

```ts
describe('review orchestrator migration', () => {
  it('creates review_runs, published_reviews, review_learnings tables', () => {
    const db = createTestDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('review_runs');
    expect(names).toContain('published_reviews');
    expect(names).toContain('review_learnings');
  });

  it('adds 14 new columns to inline_comments', () => {
    const db = createTestDb();
    const cols = db.prepare('PRAGMA table_info(inline_comments)').all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    for (const name of [
      'status',
      'review_run_id',
      'severity',
      'bucket',
      'kind',
      'existing_code',
      'suggested_code',
      'published_review_id',
      'github_comment_id',
      're_flag_of',
      'last_check_run_id',
      'last_check_status',
      'auto_resolved_at',
      'auto_resolved_reason',
    ]) {
      expect(colNames).toContain(name);
    }
  });

  it('defaults inline_comments.status to draft for new rows', () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO inline_comments (id, task_id, file_path, line, side, original_commit_sha, body)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('c1', 't1', 'a.ts', 1, 'new', 'sha', 'body');
    const row = db.prepare('SELECT status, kind FROM inline_comments WHERE id = ?').get('c1') as {
      status: string;
      kind: string;
    };
    expect(row.status).toBe('draft');
    expect(row.kind).toBe('comment');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test server/db.test.ts -t "review orchestrator migration"`
Expected: FAIL — tables/columns don't exist yet.

- [ ] **Step 3: Implement the migration**

In `server/db.ts`, append to the init block where the existing `CREATE TABLE IF NOT EXISTS` statements live. Insert AFTER the `inline_comments` table creation and AFTER any harness-abstraction migration:

```ts
// ── Review orchestrator (2026-05-28) ─────────────────────────────────────

instance.exec(`
  CREATE TABLE IF NOT EXISTS review_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    pr_head_sha TEXT NOT NULL,
    walkthrough TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    started_at TIMESTAMP NOT NULL DEFAULT (datetime('now')),
    completed_at TIMESTAMP,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_review_runs_task ON review_runs(task_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_review_runs_task_sha_status
    ON review_runs(task_id, pr_head_sha)
    WHERE status IN ('running', 'completed');

  CREATE TABLE IF NOT EXISTS published_reviews (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    github_review_id INTEGER NOT NULL,
    github_review_url TEXT,
    head_sha TEXT NOT NULL,
    verdict TEXT NOT NULL DEFAULT 'COMMENT',
    comment_count INTEGER NOT NULL,
    published_at TIMESTAMP NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_published_reviews_task ON published_reviews(task_id);

  CREATE TABLE IF NOT EXISTS review_learnings (
    id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    why TEXT NOT NULL,
    created_from_comment_id TEXT REFERENCES inline_comments(id) ON DELETE SET NULL,
    usage_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_review_learnings_repo ON review_learnings(repo_path);
`);

const inlineCommentCols = instance.prepare('PRAGMA table_info(inline_comments)').all() as {
  name: string;
}[];

addColumn(
  instance,
  'inline_comments',
  'status',
  "TEXT NOT NULL DEFAULT 'draft'",
  inlineCommentCols,
);
addColumn(
  instance,
  'inline_comments',
  'review_run_id',
  'TEXT REFERENCES review_runs(id)',
  inlineCommentCols,
);
addColumn(instance, 'inline_comments', 'severity', 'TEXT', inlineCommentCols);
addColumn(instance, 'inline_comments', 'bucket', 'TEXT', inlineCommentCols);
addColumn(
  instance,
  'inline_comments',
  'kind',
  "TEXT NOT NULL DEFAULT 'comment'",
  inlineCommentCols,
);
addColumn(instance, 'inline_comments', 'existing_code', 'TEXT', inlineCommentCols);
addColumn(instance, 'inline_comments', 'suggested_code', 'TEXT', inlineCommentCols);
addColumn(
  instance,
  'inline_comments',
  'published_review_id',
  'TEXT REFERENCES published_reviews(id)',
  inlineCommentCols,
);
addColumn(instance, 'inline_comments', 'github_comment_id', 'INTEGER', inlineCommentCols);
addColumn(
  instance,
  'inline_comments',
  're_flag_of',
  'TEXT REFERENCES inline_comments(id)',
  inlineCommentCols,
);
addColumn(
  instance,
  'inline_comments',
  'last_check_run_id',
  'TEXT REFERENCES review_runs(id)',
  inlineCommentCols,
);
addColumn(instance, 'inline_comments', 'last_check_status', 'TEXT', inlineCommentCols);
addColumn(instance, 'inline_comments', 'auto_resolved_at', 'TIMESTAMP', inlineCommentCols);
addColumn(instance, 'inline_comments', 'auto_resolved_reason', 'TEXT', inlineCommentCols);
```

Verify with `grep` that `addColumn` is imported / in scope. If not, lift its existing definition into the same file or import from wherever the harness-abstraction migration uses it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test server/db.test.ts -t "review orchestrator migration"`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full db test file**

Run: `bun run test server/db.test.ts`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add server/db.ts server/db.test.ts
git commit -m "feat(db): add review_runs, published_reviews, review_learnings + inline_comments columns"
```

---

## Task A2: Add TypeScript types in `server/types.ts`

**Files:**

- Modify: `server/types.ts`

- [ ] **Step 1: Add the new exported types**

Append to `server/types.ts`:

```ts
// ── Review orchestrator types ─────────────────────────────────────────────

export type PRType = 'Bug fix' | 'Tests' | 'Enhancement' | 'Documentation' | 'Other';

export type FileLabel =
  | 'bug fix'
  | 'tests'
  | 'enhancement'
  | 'documentation'
  | 'error handling'
  | 'configuration changes'
  | 'dependencies'
  | 'formatting'
  | 'miscellaneous';

export type TicketCompliance = {
  ticket: string;
  status: 'fully' | 'partially' | 'not' | 'no_ticket';
  reason?: string;
};

export type Walkthrough = {
  global: {
    type: PRType;
    risk: 'low' | 'medium' | 'high';
    effort: 1 | 2 | 3 | 4 | 5;
    relevant_tests: 'yes' | 'no' | 'partial';
    security_concerns: string | null;
    ticket_compliance: TicketCompliance[];
    summary: string;
    key_review_points: string[];
  };
  groups: Array<{
    name: string;
    summary: string;
    files: Array<{ path: string; label: FileLabel; summary: string }>;
  }>;
};

export type ReviewRunStatus = 'running' | 'completed' | 'failed';

export interface ReviewRun {
  id: string;
  task_id: string;
  pr_head_sha: string;
  walkthrough: string | null; // raw JSON string; parse with JSON.parse to get Walkthrough
  status: ReviewRunStatus;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

export type PublishedReviewVerdict = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface PublishedReview {
  id: string;
  task_id: string;
  github_review_id: number;
  github_review_url: string | null;
  head_sha: string;
  verdict: PublishedReviewVerdict;
  comment_count: number;
  published_at: string;
}

export interface ReviewLearning {
  id: string;
  repo_path: string;
  why: string;
  created_from_comment_id: string | null;
  usage_count: number;
  last_used_at: string | null;
  created_at: string;
}

export type CommentStatus = 'draft' | 'accepted' | 'rejected' | 'published' | 'stale';
export type CommentKind = 'comment' | 'suggestion';
export type CommentBucket = 'actionable' | 'informational';
export type CommentSeverity = 'nit' | 'suggestion' | 'issue' | 'critical';
export type LastCheckStatus = 'resolved' | 'still_applies' | 'partial' | 'unclear';
```

- [ ] **Step 2: Extend the existing `InlineComment` interface**

Locate the existing `InlineComment` (or `InlineCommentRow`) interface in `server/types.ts` (or `server/inline-comments.ts`). It currently has `id, task_id, agent_id, file_path, line, side, original_commit_sha, body, created_at, resolved_at`. Add as nullable fields, in this order:

```ts
status: CommentStatus;
review_run_id: string | null;
severity: CommentSeverity | null;
bucket: CommentBucket | null;
kind: CommentKind;
existing_code: string | null;
suggested_code: string | null;
published_review_id: string | null;
github_comment_id: number | null;
re_flag_of: string | null;
last_check_run_id: string | null;
last_check_status: LastCheckStatus | null;
auto_resolved_at: string | null;
auto_resolved_reason: string | null;
```

If the interface lives in `server/inline-comments.ts` instead of `server/types.ts`, edit it there.

- [ ] **Step 3: Type-check**

Run: `bun run typecheck`
Expected: no errors. (Adding optional fields to InlineComment may surface call-sites that destructure with strict shapes; fix them inline to spread the new fields safely — typically by changing destructures to `as InlineComment` or by adding the new fields to mock fixtures.)

- [ ] **Step 4: Commit**

```bash
git add server/types.ts server/inline-comments.ts
git commit -m "feat(types): add review orchestrator types and extend InlineComment"
```

---

## Phase B — DB helper modules

## Task B1: `server/review-runs.ts`

**Files:**

- Create: `server/review-runs.ts`
- Create: `server/review-runs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/review-runs.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers.js';
import {
  createReviewRun,
  getReviewRun,
  getCurrentRun,
  completeRun,
  failRun,
} from './review-runs.js';

const TASK_ID = 't_task1';

function insertTask(db: ReturnType<typeof createTestDb>): void {
  db.prepare(
    `INSERT INTO tasks (id, title, runtime_state, workflow_status, source)
     VALUES (?, 'x', 'idle', 'backlog', 'auto_review')`,
  ).run(TASK_ID);
}

describe('review-runs', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
    insertTask(db);
  });

  it('createReviewRun inserts a row with status=running', () => {
    const run = createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha1' });
    expect(run.status).toBe('running');
    expect(run.pr_head_sha).toBe('sha1');
    expect(run.walkthrough).toBeNull();
    expect(run.id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
  });

  it('getCurrentRun returns the latest non-failed run for the task', () => {
    createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha1' });
    const newer = createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha2' });
    const current = getCurrentRun(TASK_ID);
    expect(current?.id).toBe(newer.id);
  });

  it('completeRun stores walkthrough JSON and marks completed', () => {
    const run = createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha1' });
    completeRun(run.id, { walkthrough: '{"global":{}}' });
    const fresh = getReviewRun(run.id);
    expect(fresh?.status).toBe('completed');
    expect(fresh?.walkthrough).toBe('{"global":{}}');
    expect(fresh?.completed_at).not.toBeNull();
  });

  it('failRun records error and marks failed', () => {
    const run = createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha1' });
    failRun(run.id, 'agent crashed');
    const fresh = getReviewRun(run.id);
    expect(fresh?.status).toBe('failed');
    expect(fresh?.error).toBe('agent crashed');
  });

  it('unique index prevents two running runs on the same task+sha', () => {
    createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha1' });
    expect(() => createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha1' })).toThrow();
  });

  it('failed run on the same sha can be retried (creates a new running row)', () => {
    const a = createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha1' });
    failRun(a.id, 'timeout');
    const b = createReviewRun({ task_id: TASK_ID, pr_head_sha: 'sha1' });
    expect(b.id).not.toBe(a.id);
    expect(b.status).toBe('running');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test server/review-runs.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement the module**

Create `server/review-runs.ts`:

```ts
import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { childLogger } from './logger.js';
import type { ReviewRun } from './types.js';

const logger = childLogger('review-runs');

export interface CreateReviewRunInput {
  task_id: string;
  pr_head_sha: string;
}

export function createReviewRun(input: CreateReviewRunInput): ReviewRun {
  const id = nanoid(12);
  getDb()
    .prepare(`INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES (?, ?, ?)`)
    .run(id, input.task_id, input.pr_head_sha);
  const row = getReviewRun(id);
  if (!row) throw new Error('failed to read review_run after insert');
  logger.info(
    { task_id: input.task_id, review_run_id: id, pr_head_sha: input.pr_head_sha },
    'review_run created',
  );
  return row;
}

export function getReviewRun(id: string): ReviewRun | null {
  return (
    (getDb().prepare(`SELECT * FROM review_runs WHERE id = ?`).get(id) as ReviewRun | undefined) ??
    null
  );
}

/** Latest non-failed run for the task (running OR completed). */
export function getCurrentRun(taskId: string): ReviewRun | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM review_runs
         WHERE task_id = ? AND status != 'failed'
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(taskId) as ReviewRun | undefined) ?? null
  );
}

/** All review_runs for a task, newest first. Useful for history views. */
export function listRunsForTask(taskId: string): ReviewRun[] {
  return getDb()
    .prepare(`SELECT * FROM review_runs WHERE task_id = ? ORDER BY started_at DESC`)
    .all(taskId) as ReviewRun[];
}

export interface CompleteRunInput {
  walkthrough?: string; // JSON string
}

export function completeRun(id: string, input: CompleteRunInput = {}): void {
  getDb()
    .prepare(
      `UPDATE review_runs
         SET status = 'completed',
             walkthrough = COALESCE(?, walkthrough),
             completed_at = datetime('now')
       WHERE id = ? AND status = 'running'`,
    )
    .run(input.walkthrough ?? null, id);
}

export function failRun(id: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE review_runs
         SET status = 'failed', error = ?, completed_at = datetime('now')
       WHERE id = ? AND status = 'running'`,
    )
    .run(error, id);
}

export function setWalkthrough(id: string, walkthroughJson: string): void {
  getDb().prepare(`UPDATE review_runs SET walkthrough = ? WHERE id = ?`).run(walkthroughJson, id);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test server/review-runs.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/review-runs.ts server/review-runs.test.ts
git commit -m "feat(server): add review-runs db helper"
```

---

## Task B2: `server/published-reviews.ts`

**Files:**

- Create: `server/published-reviews.ts`
- Create: `server/published-reviews.test.ts`

This module is consumed by Step 3 (the publish endpoint), but we define it now so its types and helpers exist for the rest of Step 2 to import.

- [ ] **Step 1: Write the failing test**

Create `server/published-reviews.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers.js';
import { recordPublishedReview, listPublishedReviews } from './published-reviews.js';

const TASK_ID = 't1';

function insertTask(db: ReturnType<typeof createTestDb>): void {
  db.prepare(
    `INSERT INTO tasks (id, title, runtime_state, workflow_status, source)
     VALUES (?, 'x', 'idle', 'backlog', 'auto_review')`,
  ).run(TASK_ID);
}

describe('published-reviews', () => {
  beforeEach(() => {
    const db = createTestDb();
    insertTask(db);
  });

  it('records a published review and returns the row', () => {
    const row = recordPublishedReview({
      task_id: TASK_ID,
      github_review_id: 12345,
      github_review_url: 'https://github.com/o/r/pull/1#pullrequestreview-12345',
      head_sha: 'abc',
      verdict: 'COMMENT',
      comment_count: 3,
    });
    expect(row.id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
    expect(row.github_review_id).toBe(12345);
    expect(row.published_at).toBeTruthy();
  });

  it('lists newest first', () => {
    recordPublishedReview({
      task_id: TASK_ID,
      github_review_id: 1,
      github_review_url: null,
      head_sha: 'a',
      verdict: 'COMMENT',
      comment_count: 1,
    });
    recordPublishedReview({
      task_id: TASK_ID,
      github_review_id: 2,
      github_review_url: null,
      head_sha: 'b',
      verdict: 'APPROVE',
      comment_count: 0,
    });
    const all = listPublishedReviews(TASK_ID);
    expect(all.map((r) => r.github_review_id)).toEqual([2, 1]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test server/published-reviews.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

Create `server/published-reviews.ts`:

```ts
import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { childLogger } from './logger.js';
import type { PublishedReview, PublishedReviewVerdict } from './types.js';

const logger = childLogger('published-reviews');

export interface RecordPublishedReviewInput {
  task_id: string;
  github_review_id: number;
  github_review_url: string | null;
  head_sha: string;
  verdict: PublishedReviewVerdict;
  comment_count: number;
}

export function recordPublishedReview(input: RecordPublishedReviewInput): PublishedReview {
  const id = nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO published_reviews
         (id, task_id, github_review_id, github_review_url, head_sha, verdict, comment_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.task_id,
      input.github_review_id,
      input.github_review_url,
      input.head_sha,
      input.verdict,
      input.comment_count,
    );
  const row = getDb().prepare(`SELECT * FROM published_reviews WHERE id = ?`).get(id) as
    | PublishedReview
    | undefined;
  if (!row) throw new Error('failed to read published_review after insert');
  logger.info(
    { task_id: input.task_id, published_review_id: id, github_review_id: input.github_review_id },
    'published_review recorded',
  );
  return row;
}

export function listPublishedReviews(taskId: string): PublishedReview[] {
  return getDb()
    .prepare(`SELECT * FROM published_reviews WHERE task_id = ? ORDER BY published_at DESC`)
    .all(taskId) as PublishedReview[];
}

export function getLatestPublishedReview(taskId: string): PublishedReview | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM published_reviews
         WHERE task_id = ? ORDER BY published_at DESC LIMIT 1`,
      )
      .get(taskId) as PublishedReview | undefined) ?? null
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test server/published-reviews.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/published-reviews.ts server/published-reviews.test.ts
git commit -m "feat(server): add published-reviews db helper"
```

---

## Task B3: `server/review-learnings.ts`

**Files:**

- Create: `server/review-learnings.ts`
- Create: `server/review-learnings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/review-learnings.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers.js';
import {
  addLearning,
  touchLearning,
  listLearningsForRepo,
  deleteLearning,
} from './review-learnings.js';

describe('review-learnings', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('adds a learning row with usage_count=0', () => {
    const row = addLearning({ repo_path: '/repos/foo', why: "don't memoize side-effects" });
    expect(row.id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
    expect(row.usage_count).toBe(0);
    expect(row.last_used_at).toBeNull();
  });

  it('touchLearning increments usage_count and updates last_used_at', () => {
    const row = addLearning({ repo_path: '/r', why: 'w' });
    touchLearning(row.id);
    touchLearning(row.id);
    const all = listLearningsForRepo('/r');
    expect(all[0].usage_count).toBe(2);
    expect(all[0].last_used_at).not.toBeNull();
  });

  it('listLearningsForRepo returns most-recently-used first, then most-used', () => {
    const a = addLearning({ repo_path: '/r', why: 'a' });
    const b = addLearning({ repo_path: '/r', why: 'b' });
    const c = addLearning({ repo_path: '/r', why: 'c' });
    touchLearning(b.id);
    touchLearning(a.id);
    const ordered = listLearningsForRepo('/r').map((l) => l.why);
    // a most recently used, then b, then c (never used) by created_at desc tie-break
    expect(ordered[0]).toBe('a');
    expect(ordered[1]).toBe('b');
    expect(ordered[2]).toBe('c');
  });

  it('caps list to limit (50 default)', () => {
    for (let i = 0; i < 60; i++) addLearning({ repo_path: '/r', why: `w${i}` });
    expect(listLearningsForRepo('/r').length).toBe(50);
    expect(listLearningsForRepo('/r', { limit: 5 }).length).toBe(5);
  });

  it('deleteLearning removes the row', () => {
    const row = addLearning({ repo_path: '/r', why: 'x' });
    deleteLearning(row.id);
    expect(listLearningsForRepo('/r').length).toBe(0);
  });

  it('scopes by repo_path', () => {
    addLearning({ repo_path: '/r1', why: 'a' });
    addLearning({ repo_path: '/r2', why: 'b' });
    expect(listLearningsForRepo('/r1').map((l) => l.why)).toEqual(['a']);
    expect(listLearningsForRepo('/r2').map((l) => l.why)).toEqual(['b']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test server/review-learnings.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

Create `server/review-learnings.ts`:

```ts
import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { childLogger } from './logger.js';
import type { ReviewLearning } from './types.js';

const logger = childLogger('review-learnings');

const DEFAULT_LIST_LIMIT = 50;

export interface AddLearningInput {
  repo_path: string;
  why: string;
  created_from_comment_id?: string | null;
}

export function addLearning(input: AddLearningInput): ReviewLearning {
  const id = nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO review_learnings (id, repo_path, why, created_from_comment_id)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, input.repo_path, input.why, input.created_from_comment_id ?? null);
  const row = getDb().prepare(`SELECT * FROM review_learnings WHERE id = ?`).get(id) as
    | ReviewLearning
    | undefined;
  if (!row) throw new Error('failed to read review_learning after insert');
  logger.info({ learning_id: id, repo_path: input.repo_path }, 'learning added');
  return row;
}

export function touchLearning(id: string): void {
  getDb()
    .prepare(
      `UPDATE review_learnings
         SET usage_count = usage_count + 1, last_used_at = datetime('now')
       WHERE id = ?`,
    )
    .run(id);
}

export function deleteLearning(id: string): void {
  getDb().prepare(`DELETE FROM review_learnings WHERE id = ?`).run(id);
}

export interface ListLearningsOpts {
  limit?: number;
}

export function listLearningsForRepo(
  repoPath: string,
  opts: ListLearningsOpts = {},
): ReviewLearning[] {
  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  return getDb()
    .prepare(
      `SELECT * FROM review_learnings
         WHERE repo_path = ?
       ORDER BY (last_used_at IS NULL) ASC,
                last_used_at DESC,
                usage_count DESC,
                created_at DESC
       LIMIT ?`,
    )
    .all(repoPath, limit) as ReviewLearning[];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test server/review-learnings.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/review-learnings.ts server/review-learnings.test.ts
git commit -m "feat(server): add review-learnings db helper"
```

---

## Task B4: Extend `server/inline-comments.ts`

**Files:**

- Modify: `server/inline-comments.ts`
- Modify: `server/inline-comments.test.ts` (add tests for new fields)

- [ ] **Step 1: Write the failing tests**

Append to `server/inline-comments.test.ts`:

```ts
describe('inline-comments — orchestrator fields', () => {
  beforeEach(() => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO tasks (id, title, runtime_state, workflow_status, source)
       VALUES ('t1', 'x', 'idle', 'backlog', 'auto_review')`,
    ).run();
    db.prepare(
      `INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES ('r1', 't1', 'sha1')`,
    ).run();
  });

  it('inserts a kind=comment draft with bucket+severity+review_run_id', () => {
    const row = addComment({
      task_id: 't1',
      file_path: 'a.ts',
      line: 10,
      side: 'new',
      original_commit_sha: 'sha1',
      body: 'consider memoizing',
      kind: 'comment',
      severity: 'suggestion',
      bucket: 'actionable',
      review_run_id: 'r1',
    });
    expect(row.kind).toBe('comment');
    expect(row.bucket).toBe('actionable');
    expect(row.severity).toBe('suggestion');
    expect(row.review_run_id).toBe('r1');
    expect(row.status).toBe('draft');
  });

  it('inserts a kind=suggestion draft with existing_code + suggested_code', () => {
    const row = addComment({
      task_id: 't1',
      file_path: 'a.ts',
      line: 12,
      side: 'new',
      original_commit_sha: 'sha1',
      body: 'use Object.fromEntries',
      kind: 'suggestion',
      severity: 'nit',
      bucket: 'actionable',
      review_run_id: 'r1',
      existing_code: 'return data.reduce(...)',
      suggested_code: 'return Object.fromEntries(data);',
    });
    expect(row.kind).toBe('suggestion');
    expect(row.existing_code).toBe('return data.reduce(...)');
    expect(row.suggested_code).toBe('return Object.fromEntries(data);');
  });

  it('inserts a re_flag_of pointer when set', () => {
    const original = addComment({
      task_id: 't1',
      file_path: 'a.ts',
      line: 1,
      side: 'new',
      original_commit_sha: 'sha0',
      body: 'first',
      review_run_id: 'r1',
    });
    const reflag = addComment({
      task_id: 't1',
      file_path: 'a.ts',
      line: 1,
      side: 'new',
      original_commit_sha: 'sha1',
      body: 'still applies',
      review_run_id: 'r1',
      re_flag_of: original.id,
    });
    expect(reflag.re_flag_of).toBe(original.id);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test server/inline-comments.test.ts -t "orchestrator fields"`
Expected: FAIL — `addComment` doesn't accept the new fields.

- [ ] **Step 3: Extend `addComment`**

In `server/inline-comments.ts`, locate the `AddCommentInput` interface and extend:

```ts
export interface AddCommentInput {
  task_id: string;
  agent_id?: string | null;
  file_path: string;
  line: number;
  side: 'old' | 'new';
  original_commit_sha: string;
  body: string;
  // ── New optional orchestrator fields (defaults applied by DB column defaults
  // when omitted):
  kind?: 'comment' | 'suggestion';
  severity?: 'nit' | 'suggestion' | 'issue' | 'critical' | null;
  bucket?: 'actionable' | 'informational' | null;
  review_run_id?: string | null;
  existing_code?: string | null;
  suggested_code?: string | null;
  re_flag_of?: string | null;
}
```

Update the SQL in `addComment` to include the new fields:

```ts
getDb()
  .prepare(
    `INSERT INTO inline_comments
       (id, task_id, agent_id, file_path, line, side, original_commit_sha, body,
        kind, severity, bucket, review_run_id, existing_code, suggested_code, re_flag_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  .run(
    id,
    input.task_id,
    input.agent_id ?? null,
    input.file_path,
    input.line,
    input.side,
    input.original_commit_sha,
    input.body,
    input.kind ?? 'comment',
    input.severity ?? null,
    input.bucket ?? null,
    input.review_run_id ?? null,
    input.existing_code ?? null,
    input.suggested_code ?? null,
    input.re_flag_of ?? null,
  );
```

The existing `getComment` and `listComments` already use `SELECT *` (verify), so they'll pick up the new columns automatically. If they project columns explicitly, expand the projection to include all new fields.

- [ ] **Step 4: Run to verify pass**

Run: `bun run test server/inline-comments.test.ts`
Expected: PASS (existing + 3 new tests).

- [ ] **Step 5: Commit**

```bash
git add server/inline-comments.ts server/inline-comments.test.ts
git commit -m "feat(inline-comments): accept kind, bucket, severity, suggestion code, re_flag_of"
```

---

## Task B5: `server/walkthrough.ts` — JSON validator

**Files:**

- Create: `server/walkthrough.ts`
- Create: `server/walkthrough.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/walkthrough.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateWalkthrough } from './walkthrough.js';

const VALID = {
  global: {
    type: 'Enhancement',
    risk: 'low',
    effort: 2,
    relevant_tests: 'yes',
    security_concerns: null,
    ticket_compliance: [],
    summary: 'adds a thing',
    key_review_points: ['look at the thing'],
  },
  groups: [
    {
      name: 'Schema',
      summary: '',
      files: [{ path: 'server/db.ts', label: 'dependencies', summary: 'adds column' }],
    },
  ],
};

describe('validateWalkthrough', () => {
  it('accepts a valid walkthrough when group files match diff', () => {
    const result = validateWalkthrough(VALID, ['server/db.ts']);
    expect(result.ok).toBe(true);
  });

  it('rejects unknown PR type', () => {
    const bad = { ...VALID, global: { ...VALID.global, type: 'Refactor' } };
    const result = validateWalkthrough(bad, ['server/db.ts']);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'global.type must be one of: Bug fix, Tests, Enhancement, Documentation, Other',
    );
  });

  it('rejects effort outside 1-5', () => {
    const bad = { ...VALID, global: { ...VALID.global, effort: 7 } };
    const result = validateWalkthrough(bad, ['server/db.ts']);
    expect(result.ok).toBe(false);
  });

  it('rejects a file path that is not in the diff', () => {
    const bad = {
      ...VALID,
      groups: [
        {
          name: 'X',
          summary: '',
          files: [{ path: 'made/up.ts', label: 'miscellaneous', summary: '' }],
        },
      ],
    };
    const result = validateWalkthrough(bad, ['server/db.ts']);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/hallucinated file path/);
  });

  it('reports orphans (diff files not in any group) without rejecting', () => {
    const result = validateWalkthrough(VALID, ['server/db.ts', 'package-lock.json']);
    expect(result.ok).toBe(true);
    expect(result.orphans).toEqual(['package-lock.json']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test server/walkthrough.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `server/walkthrough.ts`:

```ts
import type { Walkthrough, PRType, FileLabel } from './types.js';

const PR_TYPES: PRType[] = ['Bug fix', 'Tests', 'Enhancement', 'Documentation', 'Other'];
const FILE_LABELS: FileLabel[] = [
  'bug fix',
  'tests',
  'enhancement',
  'documentation',
  'error handling',
  'configuration changes',
  'dependencies',
  'formatting',
  'miscellaneous',
];
const RISKS = ['low', 'medium', 'high'] as const;
const TESTS = ['yes', 'no', 'partial'] as const;

export type ValidateResult =
  | { ok: true; orphans: string[] }
  | { ok: false; errors: string[]; orphans: string[] };

/**
 * Validate a candidate walkthrough JSON against the diff file list.
 *
 * - Returns ok:false with errors when the JSON shape is wrong or it references
 *   files not present in the diff (agent hallucinated a path).
 * - Returns ok:true with orphans listing diff files that the agent didn't
 *   place in any group; the caller can synthesize an "Other changes" group.
 *
 * `diffFiles` is the unique list of files changed in `<base>..<head>`
 * (`git diff --name-only`), in PR-head terms.
 */
export function validateWalkthrough(input: unknown, diffFiles: string[]): ValidateResult {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['walkthrough must be an object'], orphans: [] };
  }
  const wt = input as Walkthrough;

  // global
  if (!wt.global || typeof wt.global !== 'object') {
    errors.push('global is required');
  } else {
    if (!PR_TYPES.includes(wt.global.type)) {
      errors.push(`global.type must be one of: ${PR_TYPES.join(', ')}`);
    }
    if (!(RISKS as readonly string[]).includes(wt.global.risk)) {
      errors.push(`global.risk must be one of: ${RISKS.join(', ')}`);
    }
    if (![1, 2, 3, 4, 5].includes(wt.global.effort)) {
      errors.push('global.effort must be 1, 2, 3, 4, or 5');
    }
    if (!(TESTS as readonly string[]).includes(wt.global.relevant_tests)) {
      errors.push(`global.relevant_tests must be one of: ${TESTS.join(', ')}`);
    }
    if (wt.global.security_concerns !== null && typeof wt.global.security_concerns !== 'string') {
      errors.push('global.security_concerns must be string or null');
    }
    if (!Array.isArray(wt.global.ticket_compliance)) {
      errors.push('global.ticket_compliance must be an array');
    }
    if (typeof wt.global.summary !== 'string') {
      errors.push('global.summary must be a string');
    }
    if (!Array.isArray(wt.global.key_review_points)) {
      errors.push('global.key_review_points must be an array of strings');
    }
  }

  // groups
  if (!Array.isArray(wt.groups)) {
    errors.push('groups must be an array');
  }

  const allListedPaths = new Set<string>();
  const diffSet = new Set(diffFiles);
  for (let gi = 0; gi < (wt.groups ?? []).length; gi++) {
    const g = wt.groups[gi];
    if (!g || typeof g.name !== 'string' || !Array.isArray(g.files)) {
      errors.push(`groups[${gi}] must have a name and a files array`);
      continue;
    }
    for (let fi = 0; fi < g.files.length; fi++) {
      const f = g.files[fi];
      if (!f || typeof f.path !== 'string' || !FILE_LABELS.includes(f.label)) {
        errors.push(
          `groups[${gi}].files[${fi}] must have a path and a valid label (one of ${FILE_LABELS.join(', ')})`,
        );
        continue;
      }
      if (!diffSet.has(f.path)) {
        errors.push(`hallucinated file path: ${f.path} (groups[${gi}].files[${fi}])`);
      }
      allListedPaths.add(f.path);
    }
  }

  const orphans = diffFiles.filter((p) => !allListedPaths.has(p));

  if (errors.length > 0) return { ok: false, errors, orphans };
  return { ok: true, orphans };
}

/** Append an auto-generated "Other changes" group covering orphan paths. */
export function appendOrphansGroup(wt: Walkthrough, orphans: string[]): Walkthrough {
  if (orphans.length === 0) return wt;
  return {
    ...wt,
    groups: [
      ...wt.groups,
      {
        name: 'Other changes',
        summary:
          "Files not covered by the agent's grouping. Often lockfiles, config touch-ups, or trivial edits.",
        files: orphans.map((path) => ({ path, label: 'miscellaneous', summary: '' })),
      },
    ],
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun run test server/walkthrough.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/walkthrough.ts server/walkthrough.test.ts
git commit -m "feat(server): walkthrough JSON validator with orphan detection"
```

---

## Task B6: `server/review-staleness.ts`

**Files:**

- Create: `server/review-staleness.ts`
- Create: `server/review-staleness.test.ts`

This module owns two pieces of mechanical work the spec calls out:

1. `markStaleDrafts(taskId, newHeadSha)` — at the start of a new `review_run`, mark drafts/accepted comments whose anchor line moved between the previous head and the new head.
2. `autoResolvePublished(taskId, runId)` — at the tail of `octomux review complete`, mark previously-published comments resolved when their region was modified AND the run did NOT include a re-flag of them.

- [ ] **Step 1: Write the failing test**

Create `server/review-staleness.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers.js';

vi.mock('./inline-comments-outdated.js', () => ({
  isAnchorOutdated: vi.fn(),
}));

import { markStaleDrafts, autoResolvePublished } from './review-staleness.js';
import { isAnchorOutdated } from './inline-comments-outdated.js';
import { getDb } from './db.js';

const TASK_ID = 't1';

function seed() {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO tasks (id, title, runtime_state, workflow_status, source, worktree)
     VALUES (?, 'x', 'idle', 'backlog', 'auto_review', '/wt')`,
  ).run(TASK_ID);
  db.prepare(
    `INSERT INTO review_runs (id, task_id, pr_head_sha, status, completed_at)
     VALUES ('r1', ?, 'sha-old', 'completed', datetime('now'))`,
  ).run(TASK_ID);
  return db;
}

describe('markStaleDrafts', () => {
  beforeEach(() => {
    vi.mocked(isAnchorOutdated).mockReset();
  });

  it('marks a draft stale when its anchor line moved', async () => {
    const db = seed();
    db.prepare(
      `INSERT INTO inline_comments
         (id, task_id, file_path, line, side, original_commit_sha, body, status, review_run_id)
       VALUES ('c1', ?, 'a.ts', 10, 'new', 'sha-old', 'b', 'draft', 'r1')`,
    ).run(TASK_ID);
    vi.mocked(isAnchorOutdated).mockResolvedValue(true);

    await markStaleDrafts(TASK_ID, 'sha-new');

    const row = db.prepare(`SELECT status FROM inline_comments WHERE id = 'c1'`).get() as {
      status: string;
    };
    expect(row.status).toBe('stale');
  });

  it('leaves a draft alone when its anchor is still present', async () => {
    const db = seed();
    db.prepare(
      `INSERT INTO inline_comments
         (id, task_id, file_path, line, side, original_commit_sha, body, status, review_run_id)
       VALUES ('c1', ?, 'a.ts', 10, 'new', 'sha-old', 'b', 'draft', 'r1')`,
    ).run(TASK_ID);
    vi.mocked(isAnchorOutdated).mockResolvedValue(false);

    await markStaleDrafts(TASK_ID, 'sha-new');

    const row = db.prepare(`SELECT status FROM inline_comments WHERE id = 'c1'`).get() as {
      status: string;
    };
    expect(row.status).toBe('draft');
  });

  it('does not touch published or rejected rows', async () => {
    const db = seed();
    db.prepare(
      `INSERT INTO inline_comments
         (id, task_id, file_path, line, side, original_commit_sha, body, status, review_run_id)
       VALUES
         ('c1', ?, 'a.ts', 10, 'new', 'sha-old', 'b', 'published', 'r1'),
         ('c2', ?, 'a.ts', 12, 'new', 'sha-old', 'b', 'rejected', 'r1')`,
    ).run(TASK_ID, TASK_ID);
    vi.mocked(isAnchorOutdated).mockResolvedValue(true);

    await markStaleDrafts(TASK_ID, 'sha-new');

    const rows = db
      .prepare(`SELECT id, status FROM inline_comments WHERE task_id = ?`)
      .all(TASK_ID) as { id: string; status: string }[];
    expect(rows.find((r) => r.id === 'c1')?.status).toBe('published');
    expect(rows.find((r) => r.id === 'c2')?.status).toBe('rejected');
  });
});

describe('autoResolvePublished', () => {
  beforeEach(() => {
    vi.mocked(isAnchorOutdated).mockReset();
  });

  it('resolves a published comment when its line moved AND no re-flag exists in this run', async () => {
    const db = seed();
    db.prepare(
      `INSERT INTO inline_comments
         (id, task_id, file_path, line, side, original_commit_sha, body, status, review_run_id)
       VALUES ('p1', ?, 'a.ts', 10, 'new', 'sha-old', 'b', 'published', 'r1')`,
    ).run(TASK_ID);
    db.prepare(
      `INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES ('r2', ?, 'sha-new')`,
    ).run(TASK_ID);
    vi.mocked(isAnchorOutdated).mockResolvedValue(true);

    await autoResolvePublished(TASK_ID, 'r2');

    const row = db
      .prepare(`SELECT auto_resolved_at, auto_resolved_reason FROM inline_comments WHERE id = 'p1'`)
      .get() as { auto_resolved_at: string | null; auto_resolved_reason: string | null };
    expect(row.auto_resolved_at).not.toBeNull();
    expect(row.auto_resolved_reason).toMatch(/line range modified/);
  });

  it('skips when run contains a re_flag_of pointer at the published id', async () => {
    const db = seed();
    db.prepare(
      `INSERT INTO inline_comments
         (id, task_id, file_path, line, side, original_commit_sha, body, status, review_run_id)
       VALUES ('p1', ?, 'a.ts', 10, 'new', 'sha-old', 'b', 'published', 'r1')`,
    ).run(TASK_ID);
    db.prepare(
      `INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES ('r2', ?, 'sha-new')`,
    ).run(TASK_ID);
    db.prepare(
      `INSERT INTO inline_comments
         (id, task_id, file_path, line, side, original_commit_sha, body, status, review_run_id, re_flag_of)
       VALUES ('d1', ?, 'a.ts', 10, 'new', 'sha-new', 'still applies', 'draft', 'r2', 'p1')`,
    ).run(TASK_ID);
    vi.mocked(isAnchorOutdated).mockResolvedValue(true);

    await autoResolvePublished(TASK_ID, 'r2');

    const row = db
      .prepare(`SELECT auto_resolved_at FROM inline_comments WHERE id = 'p1'`)
      .get() as { auto_resolved_at: string | null };
    expect(row.auto_resolved_at).toBeNull();
  });

  it('skips when line range is unchanged', async () => {
    const db = seed();
    db.prepare(
      `INSERT INTO inline_comments
         (id, task_id, file_path, line, side, original_commit_sha, body, status, review_run_id)
       VALUES ('p1', ?, 'a.ts', 10, 'new', 'sha-old', 'b', 'published', 'r1')`,
    ).run(TASK_ID);
    db.prepare(
      `INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES ('r2', ?, 'sha-new')`,
    ).run(TASK_ID);
    vi.mocked(isAnchorOutdated).mockResolvedValue(false);

    await autoResolvePublished(TASK_ID, 'r2');

    const row = db
      .prepare(`SELECT auto_resolved_at FROM inline_comments WHERE id = 'p1'`)
      .get() as { auto_resolved_at: string | null };
    expect(row.auto_resolved_at).toBeNull();
  });
});
```

You will need to confirm the actual export name from `server/inline-comments-outdated.ts`. If the file does not export an `isAnchorOutdated(...)` function, write a thin wrapper inside `review-staleness.ts` that calls into whatever it does export (the file already does `gitShow(worktree, sha, relPath)` and line-comparison). Add the wrapper rather than restructuring the existing module.

- [ ] **Step 2: Run to verify failure**

Run: `bun run test server/review-staleness.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

Create `server/review-staleness.ts`:

```ts
import { getDb } from './db.js';
import { childLogger } from './logger.js';
import { isAnchorOutdated } from './inline-comments-outdated.js';
import type { Task } from './types.js';

const logger = childLogger('review-staleness');

interface DraftRow {
  id: string;
  file_path: string;
  line: number;
  side: 'old' | 'new';
  original_commit_sha: string;
}

interface PublishedRow extends DraftRow {
  id: string;
}

/**
 * Mark drafts/accepted comments stale when the file/line they anchor on has
 * changed between `original_commit_sha` and `newHeadSha` in the task's worktree.
 *
 * Idempotent: only flips draft|accepted → stale, never the other way.
 */
export async function markStaleDrafts(taskId: string, newHeadSha: string): Promise<void> {
  const db = getDb();
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Task | undefined;
  if (!task || !task.worktree) return;

  const candidates = db
    .prepare(
      `SELECT id, file_path, line, side, original_commit_sha
         FROM inline_comments
        WHERE task_id = ?
          AND status IN ('draft', 'accepted')
          AND original_commit_sha != ?`,
    )
    .all(taskId, newHeadSha) as DraftRow[];

  for (const c of candidates) {
    let outdated: boolean;
    try {
      outdated = await isAnchorOutdated({
        worktree: task.worktree,
        oldSha: c.original_commit_sha,
        newSha: newHeadSha,
        file: c.file_path,
        line: c.line,
        side: c.side,
      });
    } catch (err) {
      logger.warn(
        { task_id: taskId, comment_id: c.id, err: (err as Error).message },
        'staleness check failed; leaving comment unchanged',
      );
      continue;
    }

    if (outdated) {
      db.prepare(`UPDATE inline_comments SET status = 'stale' WHERE id = ?`).run(c.id);
      logger.info(
        { task_id: taskId, comment_id: c.id, file: c.file_path, line: c.line },
        'comment marked stale',
      );
    }
  }
}

/**
 * Auto-resolve published comments whose anchored region was modified in the
 * latest review_run's head SHA, when the run did NOT include a re-flag draft
 * pointing at them.
 *
 * Idempotent: only flips published with auto_resolved_at IS NULL → set the
 * resolved fields. Never un-resolves.
 */
export async function autoResolvePublished(taskId: string, runId: string): Promise<void> {
  const db = getDb();
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Task | undefined;
  if (!task || !task.worktree) return;

  const run = db.prepare(`SELECT pr_head_sha FROM review_runs WHERE id = ?`).get(runId) as
    | { pr_head_sha: string }
    | undefined;
  if (!run) return;

  const published = db
    .prepare(
      `SELECT id, file_path, line, side, original_commit_sha
         FROM inline_comments
        WHERE task_id = ?
          AND status = 'published'
          AND auto_resolved_at IS NULL`,
    )
    .all(taskId) as PublishedRow[];

  const reflagSet = new Set(
    (
      db
        .prepare(
          `SELECT re_flag_of FROM inline_comments
          WHERE task_id = ? AND review_run_id = ? AND re_flag_of IS NOT NULL`,
        )
        .all(taskId, runId) as { re_flag_of: string }[]
    ).map((r) => r.re_flag_of),
  );

  for (const p of published) {
    if (reflagSet.has(p.id)) continue;

    let outdated: boolean;
    try {
      outdated = await isAnchorOutdated({
        worktree: task.worktree,
        oldSha: p.original_commit_sha,
        newSha: run.pr_head_sha,
        file: p.file_path,
        line: p.line,
        side: p.side,
      });
    } catch (err) {
      logger.warn(
        { task_id: taskId, comment_id: p.id, err: (err as Error).message },
        'auto-resolve check failed; leaving published comment unchanged',
      );
      continue;
    }

    if (!outdated) continue;

    db.prepare(
      `UPDATE inline_comments
          SET auto_resolved_at = datetime('now'),
              auto_resolved_reason = ?
        WHERE id = ?`,
    ).run(`line range modified in ${run.pr_head_sha}; no re-flag in run ${runId}`, p.id);
    logger.info(
      { task_id: taskId, comment_id: p.id, run_id: runId },
      'published comment auto-resolved',
    );
  }
}
```

If `server/inline-comments-outdated.ts` does not already export `isAnchorOutdated`, add it there:

```ts
export interface AnchorCheck {
  worktree: string;
  oldSha: string;
  newSha: string;
  file: string;
  line: number;
  side: 'old' | 'new';
}

export async function isAnchorOutdated(input: AnchorCheck): Promise<boolean> {
  const oldContent = await gitShow(input.worktree, input.oldSha, input.file);
  const newContent = await gitShow(input.worktree, input.newSha, input.file);
  if (oldContent === null || newContent === null) return true;
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const idx = input.line - 1;
  if (idx < 0 || idx >= newLines.length) return true;
  return oldLines[idx] !== newLines[idx];
}
```

(Use whatever already-exported helpers exist; keep this thin.)

- [ ] **Step 4: Run to verify pass**

Run: `bun run test server/review-staleness.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/review-staleness.ts server/review-staleness.test.ts server/inline-comments-outdated.ts
git commit -m "feat(server): review-staleness for drafts + auto-resolve published comments"
```

---

## Task B7: `server/instruction-files.ts`

**Files:**

- Create: `server/instruction-files.ts`
- Create: `server/instruction-files.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/instruction-files.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { findInstructionFiles } from './instruction-files.js';

let tmpDir: string;

function write(rel: string, content = 'x'): void {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('findInstructionFiles', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-instr-'));
  });

  it('finds root-level CLAUDE.md, AGENTS.md, CONTRIBUTING.md, REVIEW.md', () => {
    write('CLAUDE.md');
    write('AGENTS.md');
    write('CONTRIBUTING.md');
    write('REVIEW.md');
    const result = findInstructionFiles(tmpDir);
    const paths = result.map((r) => r.path);
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('AGENTS.md');
    expect(paths).toContain('CONTRIBUTING.md');
    expect(paths).toContain('REVIEW.md');
  });

  it('returns scope="root" for top-level files', () => {
    write('CLAUDE.md');
    const result = findInstructionFiles(tmpDir);
    expect(result[0].scope).toBe('root');
  });

  it('returns scope set to the parent directory for nested .agents/REVIEW.md', () => {
    write('src/.agents/REVIEW.md');
    const result = findInstructionFiles(tmpDir);
    const file = result.find((r) => r.path === 'src/.agents/REVIEW.md');
    expect(file?.scope).toBe('src/');
  });

  it('returns scope=src/ for nested .cursor/rules/foo.mdc', () => {
    write('src/.cursor/rules/foo.mdc');
    const result = findInstructionFiles(tmpDir);
    const file = result.find((r) => r.path === 'src/.cursor/rules/foo.mdc');
    expect(file?.scope).toBe('src/');
  });

  it('skips files larger than 64KB and logs a warning', () => {
    const big = 'x'.repeat(64 * 1024 + 1);
    write('BIG.md', big);
    write('SMALL.md', 'ok');
    const result = findInstructionFiles(tmpDir);
    const paths = result.map((r) => r.path);
    expect(paths).toContain('SMALL.md');
    expect(paths).not.toContain('BIG.md');
  });

  it('matches .cursorrules and .windsurfrules at root', () => {
    write('.cursorrules');
    write('.windsurfrules');
    const result = findInstructionFiles(tmpDir);
    const paths = result.map((r) => r.path);
    expect(paths).toContain('.cursorrules');
    expect(paths).toContain('.windsurfrules');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test server/instruction-files.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

Create `server/instruction-files.ts`:

```ts
import fs from 'fs';
import path from 'path';
import { childLogger } from './logger.js';

const logger = childLogger('instruction-files');

const MAX_SIZE_BYTES = 64 * 1024;

/** Glob-ish patterns (anchored at worktree root). */
const ROOT_MATCHES = new Set([
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'REVIEW.md',
  '.cursorrules',
  '.windsurfrules',
]);

const SUFFIX_MATCHES = ['.rules', '.mdc'];

const SCOPE_CARRIER_DIRS = new Set(['.agents', '.devin', '.cursor', '.github']);

export interface InstructionFile {
  path: string; // relative to worktree root, forward slashes
  scope: string; // 'root' or a directory prefix like 'src/'
  size: number;
}

/**
 * Locate instruction files in the worktree.
 *
 * - Matches well-known filenames anywhere in the tree.
 * - Matches `*.rules` / `*.mdc` anywhere in the tree.
 * - When a match lives under `.agents/`, `.devin/`, `.cursor/`, or `.github/`,
 *   its scope is the directory containing that carrier — e.g.
 *   `src/.agents/REVIEW.md` has scope `src/`. The agent should treat it as
 *   applying only to paths under `src/`.
 * - Skips files larger than 64KB (logs a warning).
 * - Skips anything inside `node_modules/` and `.git/`.
 */
export function findInstructionFiles(worktreeRoot: string): InstructionFile[] {
  const results: InstructionFile[] = [];
  walk(worktreeRoot, worktreeRoot, results);
  return results;
}

function walk(root: string, dir: string, out: InstructionFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(root, abs, out);
      continue;
    }
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (!matches(e.name)) continue;
    const stat = fs.statSync(abs);
    if (stat.size > MAX_SIZE_BYTES) {
      logger.warn({ path: rel, size: stat.size }, 'instruction file too large; skipping');
      continue;
    }
    out.push({ path: rel, scope: scopeFor(rel), size: stat.size });
  }
}

function matches(filename: string): boolean {
  if (ROOT_MATCHES.has(filename)) return true;
  for (const suffix of SUFFIX_MATCHES) {
    if (filename.endsWith(suffix)) return true;
  }
  return false;
}

function scopeFor(relPath: string): string {
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (SCOPE_CARRIER_DIRS.has(parts[i])) {
      // scope is everything before the carrier, with trailing '/'
      const prefix = parts.slice(0, i).join('/');
      return prefix === '' ? 'root' : prefix + '/';
    }
  }
  return 'root';
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun run test server/instruction-files.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/instruction-files.ts server/instruction-files.test.ts
git commit -m "feat(server): instruction-files discovery with parent-scope inheritance"
```

---

## Phase C — CLI subcommands

## Task C1: Wire the `review` subcommand into `bin/octomux.js`

**Files:**

- Modify: `bin/octomux.js`
- Create: `cli/review/index.ts`

- [ ] **Step 1: Register the subcommand**

Open `bin/octomux.js`. Add a `case 'review':` next to the other subcommand dispatches. The handler calls into `cli/review/index.ts`:

```js
case 'review': {
  const { runReview } = await import('../cli/review/index.js');
  await runReview(process.argv.slice(3));
  break;
}
```

- [ ] **Step 2: Implement the dispatcher**

Create `cli/review/index.ts`:

```ts
import { runStart } from './start.js';
import { runWalkthrough } from './walkthrough.js';
import { runDraftComment } from './draft-comment.js';
import { runCheckPrevious } from './check-previous.js';
import { runComplete } from './complete.js';
import { runLearning } from './learning.js';

const USAGE = `octomux review <subcommand> [options]

Subcommands:
  start          Print current run state + previous review + learnings (JSON).
  walkthrough    Ingest a Walkthrough JSON file onto the current run.
  draft-comment  File a draft inline comment (kind=comment) or suggestion (kind=suggestion).
  check-previous Record verify-previous result on a published comment.
  complete       Mark the current run completed; runs auto-resolve.
  learning       add | touch  - manage repo-scoped review learnings.

All subcommands require --task <id> except 'learning'.
`;

export async function runReview(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'start':
      return runStart(rest);
    case 'walkthrough':
      return runWalkthrough(rest);
    case 'draft-comment':
      return runDraftComment(rest);
    case 'check-previous':
      return runCheckPrevious(rest);
    case 'complete':
      return runComplete(rest);
    case 'learning':
      return runLearning(rest);
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`unknown subcommand: ${sub}\n${USAGE}`);
      process.exit(2);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add bin/octomux.js cli/review/index.ts
git commit -m "feat(cli): scaffold octomux review subcommand dispatcher"
```

---

## Task C2: `octomux review start --task <id>`

**Files:**

- Create: `cli/review/start.ts`
- Create: `cli/review/start.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/review/start.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../../server/test-helpers.js';
import { runStart } from './start.js';

// Capture stdout / stderr writes
let stdoutBuf = '';
let stderrBuf = '';

beforeEach(() => {
  stdoutBuf = '';
  stderrBuf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
    stdoutBuf += String(chunk);
    return true;
  }) as any);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => {
    stderrBuf += String(chunk);
    return true;
  }) as any);
});

function seedTask(db: ReturnType<typeof createTestDb>): void {
  db.prepare(
    `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, mode, status)
     VALUES ('wt1', '/tmp/wt', '/repos/foo', 'review/x', 'main', 'new', 'available')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks
       (id, title, runtime_state, workflow_status, source, worktree_id, worktree, pr_url, pr_number, pr_head_sha, base_sha)
     VALUES
       ('t1', 'PR review', 'running', 'backlog', 'auto_review', 'wt1', '/tmp/wt',
        'https://github.com/o/r/pull/1', 1, 'sha-head', 'sha-base')`,
  ).run();
}

describe('octomux review start', () => {
  it('creates a review_run and prints JSON with run id, sha, prev review (null), learnings (empty)', async () => {
    const db = createTestDb();
    seedTask(db);
    await runStart(['--task', 't1']);
    const out = JSON.parse(stdoutBuf);
    expect(out.review_run_id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
    expect(out.pr_head_sha).toBe('sha-head');
    expect(out.base_sha).toBe('sha-base');
    expect(out.previous_review).toBeNull();
    expect(Array.isArray(out.learnings)).toBe(true);
    expect(out.learnings.length).toBe(0);
    expect(Array.isArray(out.instruction_files)).toBe(true);
  });

  it('reuses the current run if one is still running for the same sha', async () => {
    const db = createTestDb();
    seedTask(db);
    db.prepare(
      `INSERT INTO review_runs (id, task_id, pr_head_sha, status)
       VALUES ('r-existing', 't1', 'sha-head', 'running')`,
    ).run();
    await runStart(['--task', 't1']);
    const out = JSON.parse(stdoutBuf);
    expect(out.review_run_id).toBe('r-existing');
  });

  it('includes previous_review when a prior published review exists', async () => {
    const db = createTestDb();
    seedTask(db);
    db.prepare(
      `INSERT INTO review_runs (id, task_id, pr_head_sha, status, walkthrough, completed_at)
       VALUES ('r-old', 't1', 'sha-prev', 'completed', '{"global":{}}', datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO published_reviews (id, task_id, github_review_id, github_review_url, head_sha, verdict, comment_count)
       VALUES ('pr1', 't1', 1, 'https://x', 'sha-prev', 'COMMENT', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO inline_comments
         (id, task_id, file_path, line, side, original_commit_sha, body, status, kind, published_review_id)
       VALUES ('c1', 't1', 'a.ts', 5, 'new', 'sha-prev', 'old', 'published', 'comment', 'pr1')`,
    ).run();
    await runStart(['--task', 't1']);
    const out = JSON.parse(stdoutBuf);
    expect(out.previous_review).not.toBeNull();
    expect(out.previous_review.head_sha).toBe('sha-prev');
    expect(out.previous_review.comments[0].id).toBe('c1');
  });

  it('exits 2 when --task is missing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error(`exit ${_code}`);
    }) as any);
    await expect(runStart([])).rejects.toThrow(/exit 2/);
    expect(stderrBuf).toMatch(/--task is required/);
    exitSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test cli/review/start.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `cli/review/start.ts`:

```ts
import { parseArgs } from 'node:util';
import { getDb } from '../../server/db.js';
import { createReviewRun, getCurrentRun } from '../../server/review-runs.js';
import { getLatestPublishedReview } from '../../server/published-reviews.js';
import { listLearningsForRepo } from '../../server/review-learnings.js';
import { findInstructionFiles } from '../../server/instruction-files.js';
import { markStaleDrafts } from '../../server/review-staleness.js';
import type { Task, InlineComment } from '../../server/types.js';

export async function runStart(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    options: { task: { type: 'string' } },
  });
  if (!values.task) {
    process.stderr.write('--task is required\n');
    process.exit(2);
  }
  const taskId = values.task as string;

  const db = getDb();
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Task | undefined;
  if (!task) {
    process.stderr.write(`task not found: ${taskId}\n`);
    process.exit(2);
  }
  if (!task.pr_head_sha) {
    process.stderr.write(`task ${taskId} has no pr_head_sha\n`);
    process.exit(2);
  }

  // Run staleness against the new head before starting/locating a run, so
  // drafts from prior heads get flipped to 'stale' first.
  await markStaleDrafts(taskId, task.pr_head_sha);

  let run = getCurrentRun(taskId);
  if (!run || run.pr_head_sha !== task.pr_head_sha) {
    run = createReviewRun({ task_id: taskId, pr_head_sha: task.pr_head_sha });
  }

  // Load latest published review (if any) + its comments for verify-previous.
  const prev = getLatestPublishedReview(taskId);
  let previous_review = null as null | {
    head_sha: string;
    verdict: string;
    walkthrough: unknown | null;
    comments: Array<
      Pick<
        InlineComment,
        'id' | 'file_path' | 'line' | 'side' | 'body' | 'severity' | 'bucket' | 'kind'
      >
    >;
  };
  if (prev) {
    const prevRunWalkthrough =
      (
        db
          .prepare(
            `SELECT walkthrough FROM review_runs WHERE task_id = ? AND pr_head_sha = ? ORDER BY started_at DESC LIMIT 1`,
          )
          .get(taskId, prev.head_sha) as { walkthrough: string | null } | undefined
      )?.walkthrough ?? null;
    const comments = db
      .prepare(
        `SELECT id, file_path, line, side, body, severity, bucket, kind
           FROM inline_comments
          WHERE published_review_id = ?
          ORDER BY file_path, line`,
      )
      .all(prev.id) as Array<
      Pick<
        InlineComment,
        'id' | 'file_path' | 'line' | 'side' | 'body' | 'severity' | 'bucket' | 'kind'
      >
    >;
    previous_review = {
      head_sha: prev.head_sha,
      verdict: prev.verdict,
      walkthrough: prevRunWalkthrough ? safeParse(prevRunWalkthrough) : null,
      comments,
    };
  }

  // Load learnings (capped) + instruction files.
  const repoPath =
    (
      db.prepare(`SELECT w.repo_path FROM worktrees w WHERE w.id = ?`).get(task.worktree_id) as
        | { repo_path: string }
        | undefined
    )?.repo_path ?? '';
  const learnings = repoPath ? listLearningsForRepo(repoPath) : [];
  const instruction_files = task.worktree ? findInstructionFiles(task.worktree) : [];

  // Carry-forward draft summary for the agent's prompt context.
  const carry_forward = db
    .prepare(
      `SELECT id, file_path, line, status FROM inline_comments
        WHERE task_id = ? AND status IN ('draft', 'accepted', 'stale')
              AND (review_run_id != ? OR review_run_id IS NULL)
        ORDER BY file_path, line`,
    )
    .all(taskId, run.id) as Array<{ id: string; file_path: string; line: number; status: string }>;

  process.stdout.write(
    JSON.stringify(
      {
        review_run_id: run.id,
        pr_head_sha: task.pr_head_sha,
        base_sha: task.base_sha ?? null,
        pr_url: task.pr_url ?? null,
        worktree: task.worktree ?? null,
        previous_review,
        learnings: learnings.map((l) => ({ id: l.id, why: l.why })),
        instruction_files,
        carry_forward,
      },
      null,
      2,
    ),
  );
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun run test cli/review/start.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/review/start.ts cli/review/start.test.ts
git commit -m "feat(cli): octomux review start emits run state + previous review + learnings"
```

---

## Task C3: `octomux review walkthrough --task <id> --json-file <path>`

**Files:**

- Create: `cli/review/walkthrough.ts`
- Create: `cli/review/walkthrough.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/review/walkthrough.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createTestDb } from '../../server/test-helpers.js';
import { runWalkthrough } from './walkthrough.js';
import { getReviewRun } from '../../server/review-runs.js';

// Mock the diff helper used to enumerate changed files in the PR.
vi.mock('../../server/diff.js', () => ({
  listChangedFiles: vi.fn(async () => ['server/db.ts', 'package-lock.json']),
}));

let tmpDir: string;
let stdoutBuf = '';
let stderrBuf = '';

beforeEach(() => {
  stdoutBuf = '';
  stderrBuf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
    stdoutBuf += String(chunk);
    return true;
  }) as any);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => {
    stderrBuf += String(chunk);
    return true;
  }) as any);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-wt-'));
});

const VALID = {
  global: {
    type: 'Enhancement',
    risk: 'low',
    effort: 2,
    relevant_tests: 'yes',
    security_concerns: null,
    ticket_compliance: [],
    summary: 's',
    key_review_points: ['x'],
  },
  groups: [
    {
      name: 'Schema',
      summary: '',
      files: [{ path: 'server/db.ts', label: 'dependencies', summary: 's' }],
    },
  ],
};

function seedRunningTask(): { taskId: string; runId: string } {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, mode, status)
     VALUES ('wt1', ?, '/repos/foo', 'review/x', 'main', 'new', 'available')`,
  ).run(tmpDir);
  db.prepare(
    `INSERT INTO tasks (id, title, runtime_state, workflow_status, source, worktree_id, worktree, pr_head_sha, base_sha)
     VALUES ('t1', 'x', 'running', 'backlog', 'auto_review', 'wt1', ?, 'sha-head', 'sha-base')`,
  ).run(tmpDir);
  db.prepare(
    `INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES ('r1', 't1', 'sha-head')`,
  ).run();
  return { taskId: 't1', runId: 'r1' };
}

describe('octomux review walkthrough', () => {
  it('ingests a valid walkthrough JSON and appends an Other changes orphan group', async () => {
    seedRunningTask();
    const file = path.join(tmpDir, 'wt.json');
    fs.writeFileSync(file, JSON.stringify(VALID));
    await runWalkthrough(['--task', 't1', '--json-file', file]);
    const run = getReviewRun('r1');
    const ingested = JSON.parse(run!.walkthrough!) as typeof VALID & { groups: any[] };
    const groupNames = ingested.groups.map((g) => g.name);
    expect(groupNames).toContain('Schema');
    expect(groupNames).toContain('Other changes');
    expect(stderrBuf).toMatch(/auto-appended/);
  });

  it('rejects when the JSON references a file not in the diff', async () => {
    seedRunningTask();
    const bad = {
      ...VALID,
      groups: [
        {
          name: 'X',
          summary: '',
          files: [{ path: 'made/up.ts', label: 'miscellaneous', summary: '' }],
        },
      ],
    };
    const file = path.join(tmpDir, 'wt.json');
    fs.writeFileSync(file, JSON.stringify(bad));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error(`exit ${_code}`);
    }) as any);
    await expect(runWalkthrough(['--task', 't1', '--json-file', file])).rejects.toThrow(/exit 2/);
    expect(stderrBuf).toMatch(/hallucinated file path: made\/up\.ts/);
    exitSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test cli/review/walkthrough.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

Create `cli/review/walkthrough.ts`:

```ts
import fs from 'fs';
import { parseArgs } from 'node:util';
import { getDb } from '../../server/db.js';
import { getCurrentRun, setWalkthrough } from '../../server/review-runs.js';
import { listChangedFiles } from '../../server/diff.js';
import { validateWalkthrough, appendOrphansGroup } from '../../server/walkthrough.js';
import type { Task, Walkthrough } from '../../server/types.js';

export async function runWalkthrough(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    options: {
      task: { type: 'string' },
      'json-file': { type: 'string' },
    },
  });
  if (!values.task) {
    process.stderr.write('--task is required\n');
    process.exit(2);
  }
  if (!values['json-file']) {
    process.stderr.write('--json-file is required\n');
    process.exit(2);
  }

  const taskId = values.task as string;
  const jsonPath = values['json-file'] as string;

  const db = getDb();
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Task | undefined;
  if (!task || !task.worktree || !task.pr_head_sha || !task.base_sha) {
    process.stderr.write(`task ${taskId} is not ready for walkthrough ingest\n`);
    process.exit(2);
  }

  const run = getCurrentRun(taskId);
  if (!run) {
    process.stderr.write(`no current review_run for task ${taskId}\n`);
    process.exit(2);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(jsonPath, 'utf-8');
  } catch (err) {
    process.stderr.write(`could not read ${jsonPath}: ${(err as Error).message}\n`);
    process.exit(2);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`invalid JSON in ${jsonPath}: ${(err as Error).message}\n`);
    process.exit(2);
  }

  const diffFiles = await listChangedFiles({
    worktree: task.worktree,
    base: task.base_sha,
    head: task.pr_head_sha,
  });

  const result = validateWalkthrough(parsed, diffFiles);
  if (!result.ok) {
    for (const e of result.errors) process.stderr.write(`${e}\n`);
    process.exit(2);
  }

  const walkthrough = appendOrphansGroup(parsed as Walkthrough, result.orphans);
  if (result.orphans.length > 0) {
    process.stderr.write(
      `auto-appended ${result.orphans.length} orphan file(s) to "Other changes": ${result.orphans.join(', ')}\n`,
    );
  }

  setWalkthrough(run.id, JSON.stringify(walkthrough));
  process.stdout.write(
    JSON.stringify({ ok: true, run_id: run.id, orphans: result.orphans }) + '\n',
  );
}
```

This depends on `server/diff.ts` exposing a `listChangedFiles({ worktree, base, head })` helper that returns `string[]` of paths from `git diff --name-only base..head`. If `diff.ts` doesn't have this, add it as a thin wrapper around `execFile('git', ['-C', worktree, 'diff', '--name-only', `${base}..${head}`])` returning the split lines.

- [ ] **Step 4: Run to verify pass**

Run: `bun run test cli/review/walkthrough.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/review/walkthrough.ts cli/review/walkthrough.test.ts server/diff.ts
git commit -m "feat(cli): octomux review walkthrough validates + ingests structured JSON"
```

---

## Task C4: `octomux review draft-comment` (kind=comment)

**Files:**

- Create: `cli/review/draft-comment.ts`
- Create: `cli/review/draft-comment.test.ts`

- [ ] **Step 1: Write the failing test (kind=comment path only — kind=suggestion lands in C5)**

Create `cli/review/draft-comment.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createTestDb } from '../../server/test-helpers.js';
import { runDraftComment } from './draft-comment.js';
import { getDb } from '../../server/db.js';

let tmpDir: string;
let stdoutBuf = '';
let stderrBuf = '';

vi.mock('../../server/inline-comments-outdated.js', () => ({
  isAnchorOutdated: vi.fn(async () => false),
}));

vi.mock('../../server/diff.js', () => ({
  showFileAtSha: vi.fn(async () => 'line1\nline2\nline3\nline4\nline5\n'),
}));

beforeEach(() => {
  stdoutBuf = '';
  stderrBuf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
    stdoutBuf += String(chunk);
    return true;
  }) as any);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => {
    stderrBuf += String(chunk);
    return true;
  }) as any);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-dc-'));
});

function seed(): void {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, mode, status)
     VALUES ('wt1', ?, '/repos/foo', 'review/x', 'main', 'new', 'available')`,
  ).run(tmpDir);
  db.prepare(
    `INSERT INTO tasks (id, title, runtime_state, workflow_status, source, worktree_id, worktree, pr_head_sha, base_sha)
     VALUES ('t1', 'x', 'running', 'backlog', 'auto_review', 'wt1', ?, 'sha-head', 'sha-base')`,
  ).run(tmpDir);
  db.prepare(
    `INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES ('r1', 't1', 'sha-head')`,
  ).run();
}

describe('octomux review draft-comment (kind=comment)', () => {
  it('inserts a draft inline comment and prints its id', async () => {
    seed();
    await runDraftComment([
      '--task',
      't1',
      '--file',
      'server/db.ts',
      '--line',
      '3',
      '--side',
      'new',
      '--severity',
      'issue',
      '--bucket',
      'actionable',
      '--body',
      'Consider X.',
    ]);
    const out = JSON.parse(stdoutBuf);
    expect(out.id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
    expect(out.status).toBe('draft');

    const row = getDb().prepare(`SELECT * FROM inline_comments WHERE id = ?`).get(out.id) as any;
    expect(row.kind).toBe('comment');
    expect(row.severity).toBe('issue');
    expect(row.bucket).toBe('actionable');
    expect(row.body).toBe('Consider X.');
    expect(row.review_run_id).toBe('r1');
    expect(row.original_commit_sha).toBe('sha-head');
  });

  it('rejects an out-of-range line', async () => {
    seed();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error(`exit ${_code}`);
    }) as any);
    await expect(
      runDraftComment([
        '--task',
        't1',
        '--file',
        'server/db.ts',
        '--line',
        '99',
        '--side',
        'new',
        '--severity',
        'nit',
        '--bucket',
        'actionable',
        '--body',
        'x',
      ]),
    ).rejects.toThrow(/exit 2/);
    expect(stderrBuf).toMatch(/line 99 is out of range/);
    exitSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test cli/review/draft-comment.test.ts -t "kind=comment"`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement (commit-kind only for now; suggestion path lands in C5)**

Create `cli/review/draft-comment.ts`:

```ts
import { parseArgs } from 'node:util';
import { getDb } from '../../server/db.js';
import { getCurrentRun } from '../../server/review-runs.js';
import { addComment } from '../../server/inline-comments.js';
import { showFileAtSha } from '../../server/diff.js';
import type { Task } from '../../server/types.js';

export async function runDraftComment(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    options: {
      task: { type: 'string' },
      file: { type: 'string' },
      line: { type: 'string' },
      'start-line': { type: 'string' },
      side: { type: 'string' },
      severity: { type: 'string' },
      bucket: { type: 'string' },
      kind: { type: 'string', default: 'comment' },
      body: { type: 'string' },
      'existing-code': { type: 'string' },
      'suggested-code': { type: 'string' },
      'reflag-of': { type: 'string' },
    },
  });

  const required = ['task', 'file', 'line', 'side', 'severity', 'bucket', 'body'] as const;
  for (const k of required) {
    if (!values[k]) {
      process.stderr.write(`--${k} is required\n`);
      process.exit(2);
    }
  }
  if (!['new', 'old'].includes(values.side as string)) {
    process.stderr.write(`--side must be 'new' or 'old'\n`);
    process.exit(2);
  }
  if (!['nit', 'suggestion', 'issue', 'critical'].includes(values.severity as string)) {
    process.stderr.write(`--severity must be one of nit|suggestion|issue|critical\n`);
    process.exit(2);
  }
  if (!['actionable', 'informational'].includes(values.bucket as string)) {
    process.stderr.write(`--bucket must be 'actionable' or 'informational'\n`);
    process.exit(2);
  }
  const kind = values.kind as 'comment' | 'suggestion';
  if (!['comment', 'suggestion'].includes(kind)) {
    process.stderr.write(`--kind must be 'comment' or 'suggestion'\n`);
    process.exit(2);
  }

  const taskId = values.task as string;
  const line = Number(values.line);
  if (!Number.isInteger(line) || line < 1) {
    process.stderr.write(`--line must be a positive integer\n`);
    process.exit(2);
  }

  const db = getDb();
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Task | undefined;
  if (!task || !task.worktree || !task.pr_head_sha) {
    process.stderr.write(`task ${taskId} is not ready\n`);
    process.exit(2);
  }

  const run = getCurrentRun(taskId);
  if (!run) {
    process.stderr.write(`no current review_run for task ${taskId}\n`);
    process.exit(2);
  }

  // Verify file + line exist at the PR head.
  let content: string;
  try {
    content = await showFileAtSha({
      worktree: task.worktree,
      sha: task.pr_head_sha,
      relPath: values.file as string,
    });
  } catch {
    process.stderr.write(`file ${values.file} does not exist at sha ${task.pr_head_sha}\n`);
    process.exit(2);
  }
  const fileLines = content.split('\n');
  if (line > fileLines.length) {
    process.stderr.write(`line ${line} is out of range (file has ${fileLines.length} lines)\n`);
    process.exit(2);
  }

  // Suggestion-specific validation will be added in Task C5.
  if (kind === 'suggestion') {
    process.stderr.write('kind=suggestion path not yet implemented (added in Task C5)\n');
    process.exit(2);
  }

  const row = addComment({
    task_id: taskId,
    file_path: values.file as string,
    line,
    side: values.side as 'new' | 'old',
    original_commit_sha: task.pr_head_sha,
    body: values.body as string,
    kind,
    severity: values.severity as any,
    bucket: values.bucket as any,
    review_run_id: run.id,
    re_flag_of: (values['reflag-of'] as string) ?? null,
  });

  process.stdout.write(JSON.stringify({ id: row.id, status: row.status }) + '\n');
}
```

This depends on `server/diff.ts` exposing `showFileAtSha({ worktree, sha, relPath })`. If missing, add a thin wrapper around `git -C <worktree> show <sha>:<relPath>` returning the stdout, throwing on failure.

- [ ] **Step 4: Run to verify pass**

Run: `bun run test cli/review/draft-comment.test.ts -t "kind=comment"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/review/draft-comment.ts cli/review/draft-comment.test.ts server/diff.ts
git commit -m "feat(cli): octomux review draft-comment for kind=comment"
```

---

## Task C5: `octomux review draft-comment --kind suggestion`

**Files:**

- Modify: `cli/review/draft-comment.ts`
- Modify: `cli/review/draft-comment.test.ts`

- [ ] **Step 1: Add tests for the suggestion path**

Append to `cli/review/draft-comment.test.ts`:

```ts
describe('octomux review draft-comment (kind=suggestion)', () => {
  it('inserts a suggestion when existing_code matches the file verbatim', async () => {
    seed();
    await runDraftComment([
      '--task',
      't1',
      '--file',
      'server/db.ts',
      '--line',
      '3',
      '--side',
      'new',
      '--severity',
      'nit',
      '--bucket',
      'actionable',
      '--kind',
      'suggestion',
      '--existing-code',
      'line3',
      '--suggested-code',
      'line3-improved',
      '--body',
      'cleaner.',
    ]);
    const out = JSON.parse(stdoutBuf);
    expect(out.id).toBeTruthy();
    const row = getDb().prepare('SELECT * FROM inline_comments WHERE id = ?').get(out.id) as any;
    expect(row.kind).toBe('suggestion');
    expect(row.existing_code).toBe('line3');
    expect(row.suggested_code).toBe('line3-improved');
  });

  it('rejects when existing_code does not match the file at the line range', async () => {
    seed();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error(`exit ${_code}`);
    }) as any);
    await expect(
      runDraftComment([
        '--task',
        't1',
        '--file',
        'server/db.ts',
        '--line',
        '3',
        '--side',
        'new',
        '--severity',
        'nit',
        '--bucket',
        'actionable',
        '--kind',
        'suggestion',
        '--existing-code',
        'wrong content',
        '--suggested-code',
        'whatever',
        '--body',
        'x',
      ]),
    ).rejects.toThrow(/exit 2/);
    expect(stderrBuf).toMatch(/existing_code mismatch/);
    expect(stderrBuf).toMatch(/\-line3/); // unified diff hint
    exitSpy.mockRestore();
  });

  it('validates multi-line suggestion against the start-line..line range', async () => {
    seed();
    await runDraftComment([
      '--task',
      't1',
      '--file',
      'server/db.ts',
      '--start-line',
      '2',
      '--line',
      '4',
      '--side',
      'new',
      '--severity',
      'nit',
      '--bucket',
      'actionable',
      '--kind',
      'suggestion',
      '--existing-code',
      'line2\nline3\nline4',
      '--suggested-code',
      'replacement',
      '--body',
      'x',
    ]);
    const out = JSON.parse(stdoutBuf);
    expect(out.id).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test cli/review/draft-comment.test.ts -t "kind=suggestion"`
Expected: FAIL — current implementation rejects all kind=suggestion calls.

- [ ] **Step 3: Implement the suggestion validation**

Open `cli/review/draft-comment.ts`. Replace the `if (kind === 'suggestion') { process.stderr.write(...); process.exit(2); }` block with the validation + insert path:

```ts
if (kind === 'suggestion') {
  const existing = values['existing-code'];
  const suggested = values['suggested-code'];
  if (typeof existing !== 'string' || typeof suggested !== 'string') {
    process.stderr.write(
      `--existing-code and --suggested-code are required when --kind=suggestion\n`,
    );
    process.exit(2);
  }
  const startLine = values['start-line'] ? Number(values['start-line']) : line;
  if (!Number.isInteger(startLine) || startLine < 1 || startLine > line) {
    process.stderr.write(`--start-line must be a positive integer <= --line\n`);
    process.exit(2);
  }
  const expectedSlice = fileLines.slice(startLine - 1, line).join('\n');
  if (expectedSlice !== existing) {
    process.stderr.write(
      `existing_code mismatch at ${values.file}:${startLine}-${line}\n` +
        diffLikeHint(expectedSlice, existing) +
        '\n',
    );
    process.exit(2);
  }
  const row = addComment({
    task_id: taskId,
    file_path: values.file as string,
    line,
    side: values.side as 'new' | 'old',
    original_commit_sha: task.pr_head_sha!,
    body: values.body as string,
    kind: 'suggestion',
    severity: values.severity as any,
    bucket: values.bucket as any,
    review_run_id: run.id,
    existing_code: existing,
    suggested_code: suggested,
    re_flag_of: (values['reflag-of'] as string) ?? null,
  });
  process.stdout.write(JSON.stringify({ id: row.id, status: row.status }) + '\n');
  return;
}
```

Add `diffLikeHint` helper at the bottom:

```ts
function diffLikeHint(expected: string, actual: string): string {
  const e = expected.split('\n');
  const a = actual.split('\n');
  const out: string[] = [];
  const max = Math.max(e.length, a.length);
  for (let i = 0; i < max; i++) {
    if (e[i] === a[i]) {
      out.push(`  ${e[i] ?? ''}`);
    } else {
      if (e[i] !== undefined) out.push(`-${e[i]}`);
      if (a[i] !== undefined) out.push(`+${a[i]}`);
    }
  }
  return out.join('\n');
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun run test cli/review/draft-comment.test.ts`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add cli/review/draft-comment.ts cli/review/draft-comment.test.ts
git commit -m "feat(cli): octomux review draft-comment supports kind=suggestion with existing_code validation"
```

---

## Task C6: `octomux review check-previous`

**Files:**

- Create: `cli/review/check-previous.ts`
- Create: `cli/review/check-previous.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/review/check-previous.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../../server/test-helpers.js';
import { runCheckPrevious } from './check-previous.js';
import { getDb } from '../../server/db.js';

let stdoutBuf = '';
let stderrBuf = '';

beforeEach(() => {
  stdoutBuf = '';
  stderrBuf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
    stdoutBuf += String(chunk);
    return true;
  }) as any);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => {
    stderrBuf += String(chunk);
    return true;
  }) as any);
});

function seed(): void {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO tasks (id, title, runtime_state, workflow_status, source)
     VALUES ('t1', 'x', 'running', 'backlog', 'auto_review')`,
  ).run();
  db.prepare(`INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES ('r1', 't1', 'sha')`).run();
  db.prepare(
    `INSERT INTO inline_comments
       (id, task_id, file_path, line, side, original_commit_sha, body, status, kind)
     VALUES ('p1', 't1', 'a.ts', 5, 'new', 'sha-prev', 'b', 'published', 'comment')`,
  ).run();
}

describe('octomux review check-previous', () => {
  it('records resolved status', async () => {
    seed();
    await runCheckPrevious(['--comment', 'p1', '--status', 'resolved']);
    const row = getDb()
      .prepare(`SELECT last_check_status, last_check_run_id FROM inline_comments WHERE id = 'p1'`)
      .get() as any;
    expect(row.last_check_status).toBe('resolved');
    expect(row.last_check_run_id).toBe('r1');
  });

  it('with status=still_applies and --reflag-body, inserts a fresh re_flag_of draft', async () => {
    seed();
    await runCheckPrevious([
      '--comment',
      'p1',
      '--status',
      'still_applies',
      '--reflag-body',
      'still not handling null',
    ]);
    const drafts = getDb()
      .prepare(`SELECT * FROM inline_comments WHERE re_flag_of = 'p1'`)
      .all() as any[];
    expect(drafts).toHaveLength(1);
    expect(drafts[0].body).toBe('still not handling null');
    expect(drafts[0].status).toBe('draft');
    expect(drafts[0].review_run_id).toBe('r1');
  });

  it('without --reflag-body, no draft is created even for still_applies', async () => {
    seed();
    await runCheckPrevious(['--comment', 'p1', '--status', 'still_applies']);
    const drafts = getDb()
      .prepare(`SELECT * FROM inline_comments WHERE re_flag_of = 'p1'`)
      .all() as any[];
    expect(drafts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test cli/review/check-previous.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `cli/review/check-previous.ts`:

```ts
import { parseArgs } from 'node:util';
import { getDb } from '../../server/db.js';
import { addComment } from '../../server/inline-comments.js';
import type { InlineComment } from '../../server/types.js';

const VALID = ['resolved', 'still_applies', 'partial', 'unclear'] as const;

export async function runCheckPrevious(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    options: {
      comment: { type: 'string' },
      status: { type: 'string' },
      note: { type: 'string' },
      'reflag-body': { type: 'string' },
    },
  });
  if (!values.comment || !values.status) {
    process.stderr.write(`--comment and --status are required\n`);
    process.exit(2);
  }
  if (!(VALID as readonly string[]).includes(values.status as string)) {
    process.stderr.write(`--status must be one of ${VALID.join(', ')}\n`);
    process.exit(2);
  }

  const db = getDb();
  const target = db.prepare(`SELECT * FROM inline_comments WHERE id = ?`).get(values.comment) as
    | InlineComment
    | undefined;
  if (!target || target.status !== 'published') {
    process.stderr.write(`comment ${values.comment} is not a published row\n`);
    process.exit(2);
  }

  const run = db
    .prepare(
      `SELECT id FROM review_runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
    )
    .get(target.task_id) as { id: string } | undefined;
  if (!run) {
    process.stderr.write(`no running review_run for task ${target.task_id}\n`);
    process.exit(2);
  }

  db.prepare(
    `UPDATE inline_comments
        SET last_check_status = ?, last_check_run_id = ?
      WHERE id = ?`,
  ).run(values.status, run.id, values.comment);

  if (values.status === 'still_applies' && typeof values['reflag-body'] === 'string') {
    const task = db.prepare(`SELECT pr_head_sha FROM tasks WHERE id = ?`).get(target.task_id) as {
      pr_head_sha: string | null;
    };
    const headSha = task.pr_head_sha ?? target.original_commit_sha;
    addComment({
      task_id: target.task_id,
      file_path: target.file_path,
      line: target.line,
      side: target.side,
      original_commit_sha: headSha,
      body: values['reflag-body'] as string,
      kind: 'comment',
      severity: target.severity ?? 'issue',
      bucket: 'actionable',
      review_run_id: run.id,
      re_flag_of: target.id,
    });
  }

  process.stdout.write(JSON.stringify({ ok: true }) + '\n');
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun run test cli/review/check-previous.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/review/check-previous.ts cli/review/check-previous.test.ts
git commit -m "feat(cli): octomux review check-previous + optional re-flag draft"
```

---

## Task C7: `octomux review complete` — completes run + runs auto-resolve

**Files:**

- Create: `cli/review/complete.ts`
- Create: `cli/review/complete.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/review/complete.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../../server/test-helpers.js';
import { runComplete } from './complete.js';
import { getDb } from '../../server/db.js';
import { broadcast } from '../../server/events.js';

vi.mock('../../server/events.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../server/review-staleness.js', () => ({
  autoResolvePublished: vi.fn(async () => undefined),
  markStaleDrafts: vi.fn(async () => undefined),
}));

let stdoutBuf = '';
let stderrBuf = '';

beforeEach(() => {
  stdoutBuf = '';
  stderrBuf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
    stdoutBuf += String(chunk);
    return true;
  }) as any);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => {
    stderrBuf += String(chunk);
    return true;
  }) as any);
  vi.mocked(broadcast).mockReset();
});

function seed(): void {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO tasks (id, title, runtime_state, workflow_status, source)
     VALUES ('t1', 'x', 'running', 'backlog', 'auto_review')`,
  ).run();
  db.prepare(`INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES ('r1', 't1', 'sha')`).run();
}

describe('octomux review complete', () => {
  it('marks the run completed, runs auto-resolve, broadcasts drafts-ready', async () => {
    seed();
    await runComplete(['--task', 't1']);
    const row = getDb()
      .prepare(`SELECT status, completed_at FROM review_runs WHERE id = 'r1'`)
      .get() as any;
    expect(row.status).toBe('completed');
    expect(row.completed_at).not.toBeNull();
    expect(broadcast).toHaveBeenCalledWith({
      type: 'review:drafts-ready',
      payload: { taskId: 't1', reviewRunId: 'r1' },
    });
  });

  it('refuses to complete a run that has no walkthrough', async () => {
    seed();
    // walkthrough column is NULL by default
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_c?: number) => {
      throw new Error('exit ' + _c);
    }) as any);
    await expect(runComplete(['--task', 't1', '--require-walkthrough'])).rejects.toThrow(/exit 2/);
    expect(stderrBuf).toMatch(/walkthrough has not been written/);
    exitSpy.mockRestore();
  });
});
```

The `--require-walkthrough` flag is a guard the agent should always set (the skill instructs this), but the CLI defaults it off so we can test the lenient path too.

- [ ] **Step 2: Run to verify failure**

Run: `bun run test cli/review/complete.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `cli/review/complete.ts`:

```ts
import { parseArgs } from 'node:util';
import { getDb } from '../../server/db.js';
import { completeRun, getCurrentRun } from '../../server/review-runs.js';
import { autoResolvePublished } from '../../server/review-staleness.js';
import { broadcast } from '../../server/events.js';

export async function runComplete(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    options: {
      task: { type: 'string' },
      'require-walkthrough': { type: 'boolean', default: false },
    },
  });
  if (!values.task) {
    process.stderr.write(`--task is required\n`);
    process.exit(2);
  }
  const taskId = values.task as string;

  const run = getCurrentRun(taskId);
  if (!run) {
    process.stderr.write(`no current review_run for task ${taskId}\n`);
    process.exit(2);
  }

  if (values['require-walkthrough'] && !run.walkthrough) {
    process.stderr.write(`walkthrough has not been written for run ${run.id}\n`);
    process.exit(2);
  }

  completeRun(run.id);
  await autoResolvePublished(taskId, run.id);

  broadcast({ type: 'review:drafts-ready', payload: { taskId, reviewRunId: run.id } });

  process.stdout.write(JSON.stringify({ ok: true, run_id: run.id }) + '\n');
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun run test cli/review/complete.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/review/complete.ts cli/review/complete.test.ts
git commit -m "feat(cli): octomux review complete marks run done, runs auto-resolve, broadcasts"
```

---

## Task C8: `octomux review learning add | touch`

**Files:**

- Create: `cli/review/learning.ts`
- Create: `cli/review/learning.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/review/learning.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../../server/test-helpers.js';
import { runLearning } from './learning.js';
import { getDb } from '../../server/db.js';

let stdoutBuf = '';

beforeEach(() => {
  stdoutBuf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
    stdoutBuf += String(chunk);
    return true;
  }) as any);
  createTestDb();
});

describe('octomux review learning add', () => {
  it('inserts a row and prints the new id', async () => {
    await runLearning(['add', '--repo-path', '/r', '--why', "don't memoize"]);
    const out = JSON.parse(stdoutBuf);
    expect(out.id).toBeTruthy();
    const row = getDb().prepare(`SELECT * FROM review_learnings WHERE id = ?`).get(out.id) as any;
    expect(row.repo_path).toBe('/r');
    expect(row.why).toBe("don't memoize");
  });
});

describe('octomux review learning touch', () => {
  it('increments usage_count and sets last_used_at', async () => {
    await runLearning(['add', '--repo-path', '/r', '--why', 'w']);
    const id = JSON.parse(stdoutBuf).id as string;
    stdoutBuf = '';
    await runLearning(['touch', '--id', id]);
    const row = getDb().prepare(`SELECT * FROM review_learnings WHERE id = ?`).get(id) as any;
    expect(row.usage_count).toBe(1);
    expect(row.last_used_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test cli/review/learning.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `cli/review/learning.ts`:

```ts
import { parseArgs } from 'node:util';
import { addLearning, touchLearning } from '../../server/review-learnings.js';

export async function runLearning(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === 'add') {
    const { values } = parseArgs({
      args: rest,
      strict: false,
      options: {
        'repo-path': { type: 'string' },
        why: { type: 'string' },
        'from-comment': { type: 'string' },
      },
    });
    if (!values['repo-path'] || !values.why) {
      process.stderr.write(`--repo-path and --why are required\n`);
      process.exit(2);
    }
    const row = addLearning({
      repo_path: values['repo-path'] as string,
      why: values.why as string,
      created_from_comment_id: (values['from-comment'] as string) ?? null,
    });
    process.stdout.write(JSON.stringify({ id: row.id }) + '\n');
    return;
  }
  if (sub === 'touch') {
    const { values } = parseArgs({
      args: rest,
      strict: false,
      options: { id: { type: 'string' } },
    });
    if (!values.id) {
      process.stderr.write(`--id is required\n`);
      process.exit(2);
    }
    touchLearning(values.id as string);
    process.stdout.write(JSON.stringify({ ok: true }) + '\n');
    return;
  }
  process.stderr.write(`unknown learning subcommand: ${sub}\n`);
  process.exit(2);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun run test cli/review/learning.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/review/learning.ts cli/review/learning.test.ts
git commit -m "feat(cli): octomux review learning add | touch"
```

---

## Phase D — Agent skill

## Task D1: `skills/review-orchestrator/SKILL.md`

**Files:**

- Create: `skills/review-orchestrator/SKILL.md`

- [ ] **Step 1: Write the skill**

Create `skills/review-orchestrator/SKILL.md`:

```markdown
---
description: Drive an automated PR review. Produces a structured walkthrough plus inline draft comments via the octomux review CLI. NEVER posts to GitHub directly — publishing is human-gated.
---

# Review Orchestrator

You are reviewing a pull request from inside an octomux worktree. Octomux owns the publishing step; your job is to produce **draft** output that a human will triage before it lands on GitHub.

## Hard rules

- DO use `octomux review <subcommand>` for every piece of output (walkthrough, drafts, check-previous, complete).
- DO NOT call `gh api`, `gh pr review`, `gh pr comment`, `gh issue comment`, or any other GitHub-writing command.
- DO NOT post to chat. Everything you produce goes through the CLI.
- DO NOT edit files. Reviews are read-only.

## Phase 1: Bootstrap

Run `octomux review start --task <task_id>` first. It prints JSON containing:

- `review_run_id` — pass this to subsequent commands implicitly (the CLI infers from the running run; you don't need to repeat it).
- `pr_head_sha`, `base_sha`, `pr_url`, `worktree`.
- `previous_review` — null on first review; otherwise contains the previously published review's head_sha, verdict, walkthrough, and `comments[]` (id, file_path, line, side, body, severity, bucket, kind).
- `learnings` — array of `{ id, why }` strings the human has told you in the past. Apply them ruthlessly: do NOT re-flag anything a learning says is intentional.
- `instruction_files` — array of `{ path, scope, size }`. Read these next.
- `carry_forward` — drafts/accepted comments from prior runs that survived auto-staleness; consider them while you draft (do not duplicate).

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

## Phase 4 (re-reviews only): verify previous published comments

If `previous_review` is non-null, for each entry in `previous_review.comments`, decide whether it still applies at the new head:

- `resolved` — the author fixed it.
- `still_applies` — same issue is still present.
- `partial` — author addressed some of it but not all.
- `unclear` — you can't tell.

Run for each:

```

octomux review check-previous --comment <id> --status resolved|still_applies|partial|unclear [--reflag-body "<text>"]

````

For `still_applies`, ALWAYS pass `--reflag-body` with a fresh restatement — the next published review needs to surface it again so the author gets a notification.

For `resolved` and `partial`, do not pass `--reflag-body`.

## Phase 5: Write the walkthrough

Compose a single JSON file at `.octomux/review-walkthrough.json` with this exact shape:

```json
{
  "global": {
    "type": "Bug fix | Tests | Enhancement | Documentation | Other",
    "risk": "low | medium | high",
    "effort": 1,
    "relevant_tests": "yes | no | partial",
    "security_concerns": null,
    "ticket_compliance": [],
    "summary": "...",
    "key_review_points": ["..."]
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
````

Rules:

- Group files **logically**, not alphabetically. Imagine narrating the change top-to-bottom to a smart colleague.
- A file MAY appear in more than one group (cross-cutting concerns like "Untested files" group → real architectural groups).
- If you forget a file, octomux will auto-append it to an "Other changes" group at the end — but try not to miss any.
- `key_review_points` should be at most 5 short bullets that tell the reviewer where to focus.
- `ticket_compliance` should have one entry per linked ticket parsed from the PR body (look for IN-1234, github#456, etc.). If none, leave the array empty.

Then ingest:

```
octomux review walkthrough --task <task_id> --json-file .octomux/review-walkthrough.json
```

If the CLI rejects (stderr will explain), fix the JSON and re-run.

## Phase 6: Draft inline comments

For each issue, pick a kind:

- **comment** — narrative feedback. Architectural concerns, missing tests, "should we use X instead of Y", FYI context. Use this when the fix isn't a literal line-level replacement.
- **suggestion** — patch. A clean line-range replacement. Use this for typos, simple bug fixes, missing null checks, renames, simple refactors.

Severity:

- `critical` — bug that will reach prod / break things.
- `issue` — clear problem the author should fix.
- `suggestion` — non-trivial improvement worth raising.
- `nit` — minor; reviewer may ignore.

Bucket:

- `actionable` — the author should respond / change something.
- `informational` — FYI context for the reviewer; no action expected.

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

The CLI validates `existing-code` against the file content at `pr_head_sha`. If it complains "existing_code mismatch" with a diff hint, look at the printed diff and fix your `--existing-code` arg — usually a stray whitespace or missing newline.

### Multi-line suggestions

For a suggestion covering lines 12 through 18, pass `--start-line 12 --line 18` and `--existing-code` containing all 7 lines joined by `\n`.

### Honor the learnings

If a `learnings` entry from Phase 1 says "we intentionally do X here because Y", do NOT file a draft contradicting it. If you do reference a learning while drafting (e.g. you almost would have flagged something but the learning told you not to), call:

```
octomux review learning touch --id <learning_id>
```

So we can prune dead learnings over time.

## Phase 7: Complete

When all drafts are filed, run:

```
octomux review complete --task <task_id> --require-walkthrough
```

This marks the run done, runs the auto-resolve pass on previously-published comments, and broadcasts to the dashboard that drafts are ready for triage.

## Don'ts

- Don't ship a walkthrough without the scalar fields filled in.
- Don't file `kind=suggestion` for changes that require thinking beyond the single line range. Use `kind=comment` and describe the change in prose.
- Don't re-flag previously-published comments by filing fresh `kind=comment` drafts. Use `check-previous --reflag-body` so the chain is preserved.
- Don't open chat back-and-forth with the user. Your output is the DB rows.

````

- [ ] **Step 2: Commit**

```bash
git add skills/review-orchestrator/SKILL.md
git commit -m "feat(skill): add review-orchestrator skill driving octomux review CLI"
````

---

## Phase E — Poller changes

## Task E1: Auto-start auto_review tasks in `upsertReviewTask`

**Files:**

- Modify: `server/poller.ts`
- Modify: `server/poller.test.ts`

- [ ] **Step 1: Write the failing test**

In `server/poller.test.ts`, add (or update) a test in the `pollReviewerRequests` describe block:

```ts
it('auto-starts the task after creating it', async () => {
  // Mock task-runner.startTask
  const startTask = vi.fn(async () => undefined);
  vi.doMock('./task-runner.js', () => ({ startTask, closeTask: vi.fn(), deleteTask: vi.fn() }));
  // Re-import poller fresh so the mock applies
  vi.resetModules();
  const { pollReviewerRequests } = await import('./poller.js');

  mockPrList([makePR({ reviewRequests: [{ login: OWNER }] })]);
  await pollReviewerRequests();
  const created = getDb().prepare(`SELECT id FROM tasks WHERE source = 'auto_review'`).get() as {
    id: string;
  };
  expect(created).toBeTruthy();
  expect(startTask).toHaveBeenCalledWith(created.id);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test server/poller.test.ts -t "auto-starts"`
Expected: FAIL — current code only inserts an idle row.

- [ ] **Step 3: Update `upsertReviewTask`**

In `server/poller.ts`, locate the `created` branch of `upsertReviewTask` where it inserts the row with `runtime_state='idle'`. After the insert, return `{ action: 'created', taskId: id }` as before — but the **caller** (the existing `for (const pr of prs)` loop in `pollReviewerRequests`) needs to invoke `startTask(id)` when `result.action === 'created'`.

Add this import at the top of `poller.ts`:

```ts
import { startTask } from './task-runner.js';
```

In the for-loop:

```ts
if (result.action === 'created') {
  logger.info(
    { task_id: result.taskId, pr_number: pr.number, repo_path: repoPath },
    'auto-created review task for reviewer request',
  );
  broadcast({ type: 'task:created', payload: { taskId: result.taskId! } });
  try {
    await startTask(result.taskId!);
  } catch (err) {
    logger.error(
      { task_id: result.taskId, err: (err as Error).message },
      'failed to auto-start review task',
    );
  }
}
```

Verify by `grep`ping `server/task-runner.ts` for the actual exported entry point name. If it is `createTask` (not `startTask`), use that instead. Do not invent a new helper.

- [ ] **Step 4: Run to verify pass**

Run: `bun run test server/poller.test.ts -t "auto-starts"`
Expected: PASS.

- [ ] **Step 5: Run the full poller suite**

Run: `bun run test server/poller.test.ts`
Expected: PASS. The existing tests that assert behaviour around idle tasks should already mock `startTask` (or be unaffected because they don't reach the created branch).

- [ ] **Step 6: Commit**

```bash
git add server/poller.ts server/poller.test.ts
git commit -m "feat(poller): auto-start auto_review tasks on creation"
```

---

## Task E2: Pre-fetch + checkout new head before re-review nudge

**Files:**

- Modify: `server/poller.ts`
- Modify: `server/poller.test.ts`

- [ ] **Step 1: Write the failing test**

In the existing test that asserts the re-review nudge fires when head advances mid-run, also assert that `execFile('git', ['-C', <worktree>, 'fetch', ...])` is called BEFORE the `tmux send-keys` calls:

```ts
it('git-fetches and checks out the new head before nudging the agent', async () => {
  // setup running auto_review task with worktree '/wt', old head 'sha-old'
  // poll with new head 'sha-new'
  // ...
  await pollReviewerRequests();

  const gitCalls = vi.mocked(execFile).mock.calls.filter((c: any[]) => c[0] === 'git');
  const fetchIdx = gitCalls.findIndex((c) => (c[1] as string[]).includes('fetch'));
  const checkoutIdx = gitCalls.findIndex(
    (c) => (c[1] as string[]).includes('checkout') && (c[1] as string[]).includes('sha-new'),
  );
  expect(fetchIdx).toBeGreaterThanOrEqual(0);
  expect(checkoutIdx).toBeGreaterThan(fetchIdx);

  const sendKeysCalls = vi
    .mocked(execFile)
    .mock.calls.filter((c: any[]) => c[0] === 'tmux' && (c[1] as string[]).includes('send-keys'));
  expect(sendKeysCalls.length).toBe(2); // text + Enter from Step 1 helper
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test server/poller.test.ts -t "git-fetches and checks out"`
Expected: FAIL — no `git fetch` is currently invoked.

- [ ] **Step 3: Update `upsertReviewTask` (the `nudged` branch)**

Inside `upsertReviewTask`, in the branch where `existing.runtime_state === 'running' || 'setting_up'`, before calling `nudgeAgentForReReview`:

```ts
const worktreeRow = getDb()
  .prepare(`SELECT path FROM worktrees WHERE id = ?`)
  .get(/* existing.worktree_id */) as { path: string } | undefined;
if (worktreeRow?.path) {
  try {
    await execFile('git', ['-C', worktreeRow.path, 'fetch', 'origin', '--quiet']);
    await execFile('git', ['-C', worktreeRow.path, 'checkout', pr.headRefOid]);
  } catch (err) {
    logger.warn(
      { task_id: existing.id, err: (err as Error).message },
      'failed to fetch/checkout new head; nudging anyway and letting agent retry',
    );
  }
}
```

You will need to ensure `existing.worktree_id` is selected by the existing SQL in `upsertReviewTask`. If it isn't, add it to the `SELECT` projection.

- [ ] **Step 4: Run to verify pass**

Run: `bun run test server/poller.test.ts -t "git-fetches and checks out"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/poller.ts server/poller.test.ts
git commit -m "feat(poller): fetch+checkout new head before nudging agent on re-review"
```

---

## Task E3: Force-push fallback (previous head unreachable)

**Files:**

- Modify: `server/poller.ts`
- Modify: `server/poller.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('falls back to full re-review when prev head is unreachable from new head', async () => {
  // Mock `git merge-base --is-ancestor <prev> <new>` to exit non-zero.
  // Set up a running task with prev head 'sha-old', poll with new head 'sha-new'.
  await pollReviewerRequests();
  const sendKeysCalls = vi
    .mocked(execFile)
    .mock.calls.filter((c: any[]) => c[0] === 'tmux' && (c[1] as string[]).includes('send-keys'));
  const message = (sendKeysCalls[0][1] as string[]).find((a) => a.startsWith('Re-review'));
  expect(message).toMatch(/previous_head_unreachable=true/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test server/poller.test.ts -t "force-push"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `server/poller.ts`, before nudging, check reachability:

```ts
let previousHeadReachable = true;
try {
  await execFile('git', [
    '-C',
    worktreeRow.path,
    'merge-base',
    '--is-ancestor',
    existing.pr_head_sha,
    pr.headRefOid,
  ]);
} catch {
  previousHeadReachable = false;
}
```

Pass the flag into `buildReReviewNudge(pr, previousHeadReachable)`:

```ts
function buildReReviewNudge(pr: OpenReviewPR, previousHeadReachable: boolean): string {
  return (
    `Re-review requested for PR #${pr.number}. ` +
    `Head advanced to ${pr.headRefOid}. ` +
    `previous_head_unreachable=${!previousHeadReachable}. ` +
    `Please pull the latest and re-run the /review-orchestrator flow on ${pr.url}.`
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun run test server/poller.test.ts -t "force-push"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/poller.ts server/poller.test.ts
git commit -m "feat(poller): signal previous_head_unreachable in re-review nudge on force-push"
```

---

## Task E4: Watchdog for stuck review_runs

**Files:**

- Modify: `server/poller.ts`
- Modify: `server/poller.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('marks a review_run failed after 15min with no walkthrough and no comments', async () => {
  const db = getDb();
  // Insert task + a review_run started 16 minutes ago, no walkthrough, no inline_comments inserts after.
  db.prepare(
    `INSERT INTO tasks (id, title, runtime_state, workflow_status, source)
     VALUES ('t1', 'x', 'running', 'backlog', 'auto_review')`,
  ).run();
  db.prepare(
    `INSERT INTO review_runs (id, task_id, pr_head_sha, status, started_at)
     VALUES ('r1', 't1', 'sha', 'running', datetime('now', '-16 minutes'))`,
  ).run();

  const { sweepStuckReviewRuns } = await import('./poller.js');
  await sweepStuckReviewRuns();
  const row = db.prepare(`SELECT status, error FROM review_runs WHERE id = 'r1'`).get() as any;
  expect(row.status).toBe('failed');
  expect(row.error).toMatch(/timeout/);
});

it('leaves a fresh review_run alone', async () => {
  const db = getDb();
  db.prepare(
    `INSERT INTO tasks (id, title, runtime_state, workflow_status, source)
     VALUES ('t1', 'x', 'running', 'backlog', 'auto_review')`,
  ).run();
  db.prepare(
    `INSERT INTO review_runs (id, task_id, pr_head_sha, status, started_at)
     VALUES ('r1', 't1', 'sha', 'running', datetime('now', '-2 minutes'))`,
  ).run();
  const { sweepStuckReviewRuns } = await import('./poller.js');
  await sweepStuckReviewRuns();
  const row = db.prepare(`SELECT status FROM review_runs WHERE id = 'r1'`).get() as any;
  expect(row.status).toBe('running');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test server/poller.test.ts -t "review_run"`
Expected: FAIL.

- [ ] **Step 3: Implement `sweepStuckReviewRuns` and schedule it in the existing ticker**

Append to `server/poller.ts`:

```ts
const REVIEW_RUN_TIMEOUT_MIN = 15;

export async function sweepStuckReviewRuns(): Promise<void> {
  const db = getDb();
  const stuck = db
    .prepare(
      `SELECT rr.id, rr.task_id FROM review_runs rr
        WHERE rr.status = 'running'
          AND rr.started_at < datetime('now', ?)
          AND rr.walkthrough IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM inline_comments ic
             WHERE ic.review_run_id = rr.id
               AND ic.created_at > rr.started_at
          )`,
    )
    .all(`-${REVIEW_RUN_TIMEOUT_MIN} minutes`) as Array<{ id: string; task_id: string }>;

  for (const row of stuck) {
    db.prepare(
      `UPDATE review_runs
          SET status = 'failed',
              error = 'timeout: no progress for ${REVIEW_RUN_TIMEOUT_MIN} minutes',
              completed_at = datetime('now')
        WHERE id = ?`,
    ).run(row.id);
    logger.warn({ task_id: row.task_id, review_run_id: row.id }, 'review_run timed out');
    broadcast({ type: 'review:run-failed', payload: { taskId: row.task_id, reviewRunId: row.id } });
  }
}
```

Register the sweep in whatever interval `startPolling()` (or equivalent) sets up. If the poller has `PR_INTERVAL` already firing, piggyback on the same cadence.

- [ ] **Step 4: Run to verify pass**

Run: `bun run test server/poller.test.ts -t "review_run"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/poller.ts server/poller.test.ts
git commit -m "feat(poller): sweep stuck review_runs after 15min idle"
```

---

## Phase F — Final test + type pass

## Task F1: Full project pass

- [ ] **Step 1: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `bun run test`
Expected: all green.

- [ ] **Step 3: Lint**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 4: Smoke-test the CLI end-to-end manually**

Start a dev server and tail logs:

```bash
bun run dev
```

In another terminal, find an open PR awaiting your review on a tracked repo. Wait for the poller cycle (≤60s). Confirm:

1. `~/.octomux/octomux.sqlite` (or `./data/octomux.sqlite` in dev) shows a new `tasks` row with `source='auto_review'`.
2. `runtime_state` transitions through `setting_up` to `running` without manual intervention.
3. A `review_runs` row appears for the PR head SHA.
4. After 1–3 minutes, `inline_comments` rows with `status='draft'` appear; `review_runs.walkthrough` is populated; `review_runs.status='completed'`.
5. The dashboard SSE shows `review:drafts-ready`.

Capture the result in your engineering log. There is no UI yet — Step 3 builds the surface for triage and publish.

---

## Self-review checklist

After completing all tasks:

- [ ] Every new `cli/review/*.ts` file has a matching `*.test.ts` with at least one happy-path + one failure-path test.
- [ ] `server/inline-comments.ts` accepts the new optional fields and the SQL projection returns them.
- [ ] `server/db.ts` migration is idempotent (running init twice doesn't error).
- [ ] No `console.*` calls were added to `server/`. All logs go via `childLogger`.
- [ ] The skill file at `skills/review-orchestrator/SKILL.md` documents every CLI subcommand the agent uses, with concrete example invocations.
- [ ] The poller's `pollReviewerRequests` calls `startTask` only when `result.action === 'created'`. It does NOT auto-start when `action === 'updated'` or `'nudged'` (those keep the existing behaviour).
- [ ] `sweepStuckReviewRuns` is wired into a recurring tick in `startPolling`.

## Done criteria

- All `bun run test` + `bun run typecheck` + `bun run lint` are green.
- End-to-end smoke test produces walkthrough JSON + draft comments in the DB for a real open PR.

Step 2 ships an internal-only state. Drafts are visible only by inspecting SQLite directly. Step 3 builds the dashboard surface that turns this into a usable workflow and adds the publish-to-GitHub path.
