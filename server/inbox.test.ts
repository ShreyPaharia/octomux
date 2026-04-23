import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, insertTask, insertPermissionPrompt, DEFAULTS } from './test-helpers.js';
import { getNeedsYou, getActivity } from './inbox.js';

describe('inbox queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('getNeedsYou', () => {
    it('returns task with a pending permission prompt', () => {
      insertTask(db, { id: 'task-pp', status: 'running' });
      insertPermissionPrompt(db, {
        id: 'pp1',
        task_id: 'task-pp',
        agent_id: null,
        status: 'pending',
      });

      const rows = getNeedsYou();
      expect(rows.map((t) => t.id)).toContain('task-pp');
    });

    it('returns errored + unviewed task', () => {
      insertTask(db, {
        id: 'task-err',
        status: 'error',
        last_viewed_at: null,
        updated_at: '2026-04-23 10:00:00',
      });

      const rows = getNeedsYou();
      expect(rows.map((t) => t.id)).toContain('task-err');
    });

    it('returns errored task whose view is stale (viewed before latest update)', () => {
      insertTask(db, {
        id: 'task-err-stale',
        status: 'error',
        last_viewed_at: '2026-04-20 10:00:00',
        updated_at: '2026-04-23 10:00:00',
      });

      const rows = getNeedsYou();
      expect(rows.map((t) => t.id)).toContain('task-err-stale');
    });

    it('omits errored task that has been viewed since update', () => {
      insertTask(db, {
        id: 'task-err-viewed',
        status: 'error',
        last_viewed_at: '2026-04-23 11:00:00',
        updated_at: '2026-04-23 10:00:00',
      });

      const rows = getNeedsYou();
      expect(rows.map((t) => t.id)).not.toContain('task-err-viewed');
    });

    it('omits running task with no pending prompts and no error', () => {
      insertTask(db, { id: 'task-run', status: 'running' });
      const rows = getNeedsYou();
      expect(rows.map((t) => t.id)).not.toContain('task-run');
    });

    it('does not double-count when a task has multiple pending prompts', () => {
      insertTask(db, { id: 'task-many-pp', status: 'running' });
      insertPermissionPrompt(db, {
        id: 'pp-a',
        task_id: 'task-many-pp',
        agent_id: null,
        status: 'pending',
      });
      insertPermissionPrompt(db, {
        id: 'pp-b',
        task_id: 'task-many-pp',
        agent_id: null,
        status: 'pending',
      });
      const rows = getNeedsYou();
      expect(rows.filter((t) => t.id === 'task-many-pp')).toHaveLength(1);
    });

    it('orders by updated_at DESC', () => {
      insertTask(db, {
        id: 'task-old',
        status: 'error',
        updated_at: '2026-04-20 00:00:00',
      });
      insertTask(db, {
        id: 'task-new',
        status: 'error',
        updated_at: '2026-04-23 00:00:00',
      });
      const rows = getNeedsYou();
      expect(rows[0].id).toBe('task-new');
      expect(rows[1].id).toBe('task-old');
    });
  });

  describe('getActivity', () => {
    it('returns closed + unviewed task within 7 days', () => {
      insertTask(db, {
        id: 'task-closed',
        status: 'closed',
        last_viewed_at: null,
        updated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      });
      const rows = getActivity();
      expect(rows.map((t) => t.id)).toContain('task-closed');
    });

    it('omits closed task older than 7 days', () => {
      insertTask(db, {
        id: 'task-stale',
        status: 'closed',
        last_viewed_at: null,
        updated_at: '2026-04-01 00:00:00',
      });
      const rows = getActivity();
      expect(rows.map((t) => t.id)).not.toContain('task-stale');
    });

    it('omits closed task that has been viewed since update', () => {
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      insertTask(db, {
        id: 'task-seen',
        status: 'closed',
        updated_at: now,
        last_viewed_at: '2099-01-01 00:00:00',
      });
      const rows = getActivity();
      expect(rows.map((t) => t.id)).not.toContain('task-seen');
    });

    it('omits running tasks', () => {
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      insertTask(db, {
        id: 'task-run',
        status: 'running',
        updated_at: now,
        last_viewed_at: null,
      });
      const rows = getActivity();
      expect(rows.map((t) => t.id)).not.toContain('task-run');
    });

    it('omits errored tasks (they belong in needs-you)', () => {
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      insertTask(db, {
        id: 'task-err',
        status: 'error',
        updated_at: now,
        last_viewed_at: null,
      });
      const rows = getActivity();
      expect(rows.map((t) => t.id)).not.toContain('task-err');
    });

    it('omits task that also has pending permission prompt (needs-you wins)', () => {
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      insertTask(db, {
        id: 'task-both',
        status: 'closed',
        updated_at: now,
        last_viewed_at: null,
      });
      insertPermissionPrompt(db, {
        id: 'pp-x',
        task_id: 'task-both',
        agent_id: null,
        status: 'pending',
      });

      expect(getNeedsYou().map((t) => t.id)).toContain('task-both');
      expect(getActivity().map((t) => t.id)).not.toContain('task-both');
    });

    it('caps at 50 rows', () => {
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      for (let i = 0; i < 60; i++) {
        insertTask(db, {
          id: `task-${i}`,
          status: 'closed',
          updated_at: now,
          last_viewed_at: null,
        });
      }
      const rows = getActivity();
      expect(rows).toHaveLength(50);
    });

    it('uses default fixture shape', () => {
      // Sanity: DEFAULTS exposes last_viewed_at as null
      expect(DEFAULTS.task.last_viewed_at).toBeNull();
    });
  });
});
