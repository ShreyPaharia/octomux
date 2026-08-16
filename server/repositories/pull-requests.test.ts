import { describe, it, expect, beforeEach } from '../bun-test.js';
import type Database from '../sqlite.js';
import { createTestDb, insertTask } from '../test-helpers.js';
import {
  upsertPullRequest,
  listPullRequestsByTask,
  syncDerivedPrimaryPr,
} from './pull-requests.js';

describe('pull-requests repository', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  // ── migration + backfill ─────────────────────────────────────────────────

  describe('migration backfill', () => {
    it('seeds a pull_requests row from tasks.pr_url on initDb', () => {
      // Insert a task that already has a pr_url (simulates an existing production row).
      insertTask(db, {
        id: 'task-mig-1',
        pr_url: 'https://github.com/org/repo/pull/7',
        pr_number: 7,
        branch: 'agents/task-mig-1',
      });

      // Manually run the backfill SQL as the migration does (createTestDb already ran it
      // via initDb, but here the task was inserted AFTER initDb — so run it explicitly to
      // test the migration logic in isolation).
      db.exec(`
        INSERT OR IGNORE INTO pull_requests (id, task_id, branch, base_branch, number, url, state)
        SELECT
          lower(hex(randomblob(6))) || lower(hex(randomblob(6))),
          t.id, w.branch, w.base_branch, t.pr_number, t.pr_url, 'open'
        FROM tasks t
        INNER JOIN worktrees w ON t.worktree_id = w.id
        WHERE t.pr_url IS NOT NULL AND w.branch IS NOT NULL
      `);

      const rows = db
        .prepare(`SELECT * FROM pull_requests WHERE task_id = 'task-mig-1'`)
        .all() as Array<Record<string, unknown>>;

      expect(rows).toHaveLength(1);
      expect(rows[0].url).toBe('https://github.com/org/repo/pull/7');
      expect(rows[0].number).toBe(7);
      expect(rows[0].branch).toBe('agents/task-mig-1');
      expect(rows[0].state).toBe('open');
    });

    it('is idempotent — running the backfill twice produces one row', () => {
      insertTask(db, {
        id: 'task-mig-2',
        pr_url: 'https://github.com/org/repo/pull/8',
        pr_number: 8,
        branch: 'agents/task-mig-2',
      });

      const sql = `
        INSERT OR IGNORE INTO pull_requests (id, task_id, branch, base_branch, number, url, state)
        SELECT
          lower(hex(randomblob(6))) || lower(hex(randomblob(6))),
          t.id, w.branch, w.base_branch, t.pr_number, t.pr_url, 'open'
        FROM tasks t
        INNER JOIN worktrees w ON t.worktree_id = w.id
        WHERE t.pr_url IS NOT NULL AND w.branch IS NOT NULL
      `;
      db.exec(sql);
      db.exec(sql); // second run — must no-op

      const count = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM pull_requests WHERE task_id = 'task-mig-2'`)
          .get() as { n: number }
      ).n;
      expect(count).toBe(1);
    });
  });

  // ── upsertPullRequest ────────────────────────────────────────────────────

  describe('upsertPullRequest', () => {
    it('inserts a new row on first call', () => {
      insertTask(db, { id: 'task-up-1', branch: 'agents/task-up-1' });
      const pr = upsertPullRequest({
        task_id: 'task-up-1',
        branch: 'agents/task-up-1',
        number: 10,
        url: 'https://github.com/o/r/pull/10',
        state: 'open',
      });
      expect(pr.id).toBeTruthy();
      expect(pr.task_id).toBe('task-up-1');
      expect(pr.branch).toBe('agents/task-up-1');
      expect(pr.number).toBe(10);
      expect(pr.state).toBe('open');
    });

    it('updates an existing row on second call for same (task_id, branch)', () => {
      insertTask(db, { id: 'task-up-2', branch: 'agents/task-up-2' });
      upsertPullRequest({
        task_id: 'task-up-2',
        branch: 'agents/task-up-2',
        number: 11,
        url: 'https://github.com/o/r/pull/11',
        state: 'open',
      });
      const updated = upsertPullRequest({
        task_id: 'task-up-2',
        branch: 'agents/task-up-2',
        state: 'merged',
      });
      expect(updated.state).toBe('merged');
      expect(updated.number).toBe(11); // preserved from first insert (COALESCE)
    });

    it('two calls with different branches produce two rows', () => {
      insertTask(db, { id: 'task-up-3', branch: 'agents/task-up-3' });
      upsertPullRequest({
        task_id: 'task-up-3',
        branch: 'agents/task-up-3',
        number: 20,
        url: 'https://github.com/o/r/pull/20',
        state: 'open',
      });
      upsertPullRequest({
        task_id: 'task-up-3',
        branch: 'agents/task-up-3-slice1',
        number: 21,
        url: 'https://github.com/o/r/pull/21',
        state: 'open',
      });
      const rows = listPullRequestsByTask('task-up-3');
      expect(rows).toHaveLength(2);
    });
  });

  // ── listPullRequestsByTask ────────────────────────────────────────────────

  describe('listPullRequestsByTask', () => {
    it('returns rows newest-first', () => {
      insertTask(db, { id: 'task-list-1', branch: 'agents/task-list-1' });
      const a = upsertPullRequest({
        task_id: 'task-list-1',
        branch: 'agents/task-list-1',
        number: 1,
        url: 'u1',
        state: 'open',
      });
      const b = upsertPullRequest({
        task_id: 'task-list-1',
        branch: 'agents/task-list-1-s2',
        number: 2,
        url: 'u2',
        state: 'open',
      });
      const rows = listPullRequestsByTask('task-list-1');
      // b was inserted after a — should come first (DESC created_at).
      expect(rows[0].id).toBe(b.id);
      expect(rows[1].id).toBe(a.id);
    });

    it('returns empty array for task with no PRs', () => {
      insertTask(db, { id: 'task-list-2', branch: 'agents/task-list-2' });
      expect(listPullRequestsByTask('task-list-2')).toEqual([]);
    });
  });

  // ── syncDerivedPrimaryPr ──────────────────────────────────────────────────

  describe('syncDerivedPrimaryPr', () => {
    const cases = [
      {
        name: '0 PRs → nulls on tasks',
        prs: [] as Array<{
          branch: string;
          number: number;
          url: string;
          state: 'open' | 'merged' | 'closed';
        }>,
        expected: { pr_url: null, pr_number: null, pr_head_sha: null },
      },
      {
        name: '1 open PR → that PR is primary',
        prs: [{ branch: 'b1', number: 5, url: 'https://gh/pr/5', state: 'open' as const }],
        expected: { pr_url: 'https://gh/pr/5', pr_number: 5, pr_head_sha: null },
      },
      {
        name: 'open + merged → open wins',
        prs: [
          { branch: 'b1', number: 5, url: 'u5', state: 'open' as const },
          { branch: 'b2', number: 6, url: 'u6', state: 'merged' as const },
        ],
        expected: { pr_url: 'u5', pr_number: 5, pr_head_sha: null },
      },
      {
        name: 'all merged → newest row is primary',
        prs: [
          { branch: 'b1', number: 3, url: 'u3', state: 'merged' as const },
          { branch: 'b2', number: 4, url: 'u4', state: 'merged' as const },
        ],
        // b2 inserted last → newest created_at → primary
        expected: { pr_url: 'u4', pr_number: 4, pr_head_sha: null },
      },
    ] as const;

    it.each(cases)('$name', ({ prs, expected }) => {
      const taskId = `task-sync-${Math.random().toString(36).slice(2, 8)}`;
      insertTask(db, { id: taskId, branch: 'agents/' + taskId });

      for (const pr of prs) {
        upsertPullRequest({ task_id: taskId, ...pr });
      }

      syncDerivedPrimaryPr(taskId);

      const row = db
        .prepare(`SELECT pr_url, pr_number, pr_head_sha FROM tasks WHERE id = ?`)
        .get(taskId) as {
        pr_url: string | null;
        pr_number: number | null;
        pr_head_sha: string | null;
      };

      expect(row.pr_url).toBe(expected.pr_url);
      expect(row.pr_number).toBe(expected.pr_number);
      expect(row.pr_head_sha).toBe(expected.pr_head_sha);
    });
  });
});
