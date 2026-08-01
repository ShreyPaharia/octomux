import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA, applyPragmas } from './schema.js';
import { runMigrations } from './migrations.js';
import {
  TASKS_TABLE_COLUMNS,
  AGENTS_TABLE_COLUMNS,
  WORKTREES_TABLE_COLUMNS,
  PR_EXTRACTS_TABLE_COLUMNS,
} from '../test-helpers.js';

describe('runMigrations (isolated)', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it('applies migrations to a fresh in-memory DB and produces the expected schema', () => {
    db = new Database(':memory:');
    applyPragmas(db);
    db.exec(SCHEMA);
    runMigrations(db);

    const fk = db.pragma('foreign_keys') as [{ foreign_keys: number }];
    expect(fk[0].foreign_keys).toBe(1);

    const taskCols = (db.pragma('table_info(tasks)') as Array<{ name: string }>).map((c) => c.name);
    for (const col of TASKS_TABLE_COLUMNS) {
      expect(taskCols).toContain(col);
    }
    expect(taskCols).not.toContain('status');

    const agentCols = (db.pragma('table_info(workers)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    for (const col of AGENTS_TABLE_COLUMNS) {
      expect(agentCols).toContain(col);
    }

    const wtCols = (db.pragma('table_info(worktrees)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(wtCols).toEqual(WORKTREES_TABLE_COLUMNS);

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tables).toContain('review_runs');
    expect(tables).toContain('orchestrator_conversations');

    const indexes = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'`)
        .all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain('idx_tasks_active_worktree');

    expect(tables).not.toContain('team_schedules');
    expect(tables).not.toContain('team_runs');

    expect(tables).toContain('pr_extracts');
    const extractCols = (db.pragma('table_info(pr_extracts)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(extractCols).toEqual(PR_EXTRACTS_TABLE_COLUMNS);
    const extractIndexes = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pr_extracts'`)
        .all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(extractIndexes).toContain('idx_pr_extracts_task');
    expect(extractIndexes).toContain('idx_pr_extracts_pr');
  });

  it('is idempotent when run twice on the same database', () => {
    db = new Database(':memory:');
    applyPragmas(db);
    db.exec(SCHEMA);
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });

  // ── Schedule kinds as presets (spec/schedule-kinds-as-presets.md §8) ────────

  describe('schedule_skills → schedules.prompt/config_json migration', () => {
    /** Simulate a pre-migration DB: SCHEMA no longer creates `schedule_skills`,
     * so an upgrade install needs it added back by hand before `runMigrations`
     * can exercise the backfill-then-drop path. */
    function addLegacyScheduleSkillsTable(instance: Database.Database): void {
      instance.exec(`
        CREATE TABLE schedule_skills (
          kind        TEXT PRIMARY KEY,
          content     TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    }

    function tableNames(instance: Database.Database): string[] {
      return (
        instance.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
    }

    it('backfills schedules.prompt from schedule_skills (joined on kind), materializes config_json, and drops the table', () => {
      db = new Database(':memory:');
      applyPragmas(db);
      db.exec(SCHEMA);
      addLegacyScheduleSkillsTable(db);

      db.prepare(
        `INSERT INTO schedule_skills (kind, content) VALUES ('weekly-update', 'Legacy DB skill body')`,
      ).run();
      db.prepare(
        `INSERT INTO schedules (id, kind, repo_path, cron, enabled, prompt)
         VALUES ('sched-1', 'weekly-update', '/repo', '0 7 * * 1', 1, NULL)`,
      ).run();
      // Kind with no schedule_skills row — must fall back to the shipped
      // preset's prompt (production: the one real case, doc-drift).
      db.prepare(
        `INSERT INTO schedules (id, kind, repo_path, cron, enabled, prompt)
         VALUES ('sched-2', 'doc-drift', '/repo', '0 9 * * 1', 1, '')`,
      ).run();
      // Row with a non-empty prompt already — must NOT be overwritten.
      db.prepare(
        `INSERT INTO schedules (id, kind, repo_path, cron, enabled, prompt)
         VALUES ('sched-3', 'doc-drift', '/repo', '0 9 * * 1', 1, 'already has a prompt')`,
      ).run();

      runMigrations(db);

      expect(tableNames(db)).not.toContain('schedule_skills');

      const row1 = db
        .prepare(`SELECT prompt, config_json FROM schedules WHERE id = 'sched-1'`)
        .get() as {
        prompt: string;
        config_json: string;
      };
      expect(row1.prompt).toBe('Legacy DB skill body');
      // config_json materialized against weekly-update's schema (no config
      // properties defined, so `{}`).
      expect(JSON.parse(row1.config_json)).toEqual({});

      const row2 = db
        .prepare(`SELECT prompt, config_json FROM schedules WHERE id = 'sched-2'`)
        .get() as {
        prompt: string;
        config_json: string;
      };
      expect(row2.prompt).toContain('# Doc drift'); // shipped kinds/doc-drift.json prompt
      const config2 = JSON.parse(row2.config_json) as { maxIterations: number; baseBranch: string };
      expect(config2.maxIterations).toBe(4);
      expect(config2.baseBranch).toBe('main');

      const row3 = db.prepare(`SELECT prompt FROM schedules WHERE id = 'sched-3'`).get() as {
        prompt: string;
      };
      expect(row3.prompt).toBe('already has a prompt');
    });

    it('is a no-op when schedule_skills does not exist (fresh install)', () => {
      db = new Database(':memory:');
      applyPragmas(db);
      db.exec(SCHEMA);
      // SCHEMA no longer creates schedule_skills — nothing to migrate.
      expect(tableNames(db)).not.toContain('schedule_skills');

      expect(() => runMigrations(db)).not.toThrow();
      expect(tableNames(db)).not.toContain('schedule_skills');
    });

    it('is idempotent: running twice does not re-run the backfill or error on the dropped table', () => {
      db = new Database(':memory:');
      applyPragmas(db);
      db.exec(SCHEMA);
      addLegacyScheduleSkillsTable(db);
      db.prepare(
        `INSERT INTO schedule_skills (kind, content) VALUES ('weekly-update', 'Legacy body')`,
      ).run();
      db.prepare(
        `INSERT INTO schedules (id, kind, repo_path, cron, enabled, prompt)
         VALUES ('sched-1', 'weekly-update', '/repo', '0 7 * * 1', 1, NULL)`,
      ).run();

      runMigrations(db);
      const firstPrompt = (
        db.prepare(`SELECT prompt FROM schedules WHERE id = 'sched-1'`).get() as { prompt: string }
      ).prompt;
      expect(firstPrompt).toBe('Legacy body');

      // Second run: schedule_skills is gone, so this must no-op — in
      // particular, it must NOT clear the already-backfilled prompt.
      expect(() => runMigrations(db)).not.toThrow();
      const secondPrompt = (
        db.prepare(`SELECT prompt FROM schedules WHERE id = 'sched-1'`).get() as { prompt: string }
      ).prompt;
      expect(secondPrompt).toBe('Legacy body');
    });
  });

  // ── Multi-ticket external refs: PK (task_id, integration, ref) ───────────────

  describe('task_external_refs PK migration', () => {
    it('migrates old (task_id, integration) PK to (task_id, integration, ref) preserving rows', () => {
      db = new Database(':memory:');
      applyPragmas(db);

      // Simulate an old-style DB: create the table with the legacy PK
      db.exec(`
        CREATE TABLE tasks (
          id          TEXT PRIMARY KEY,
          title       TEXT NOT NULL DEFAULT '',
          description TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO tasks (id) VALUES ('t1');
        CREATE TABLE task_external_refs (
          task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          integration TEXT NOT NULL,
          ref         TEXT NOT NULL,
          url         TEXT,
          metadata    TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (task_id, integration)
        );
        INSERT INTO task_external_refs (task_id, integration, ref) VALUES ('t1', 'linear', 'SHR-1');
      `);

      // Verify old PK columns
      const beforePk = (
        db.pragma('table_info(task_external_refs)') as Array<{ name: string; pk: number }>
      )
        .filter((c) => c.pk > 0)
        .map((c) => c.name);
      expect(beforePk).toEqual(['task_id', 'integration']);

      // runMigrations won't work on this bare DB (tasks table is missing many cols),
      // but we can run just the migration block directly by simulating the guard.
      // Instead, just run the rebuild SQL directly:
      db.transaction(() => {
        db.exec(`
          CREATE TABLE task_external_refs_new (
            task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            integration TEXT NOT NULL,
            ref         TEXT NOT NULL,
            url         TEXT,
            metadata    TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (task_id, integration, ref)
          )
        `);
        db.exec(`
          INSERT INTO task_external_refs_new (task_id, integration, ref, url, metadata, created_at)
          SELECT task_id, integration, ref, url, metadata, created_at
          FROM task_external_refs
        `);
        db.exec(`DROP TABLE task_external_refs`);
        db.exec(`ALTER TABLE task_external_refs_new RENAME TO task_external_refs`);
      })();

      // Row is preserved
      const rows = db
        .prepare(`SELECT * FROM task_external_refs WHERE task_id = 't1'`)
        .all() as Array<{ ref: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].ref).toBe('SHR-1');

      // New PK covers 3 columns
      const afterPk = (
        db.pragma('table_info(task_external_refs)') as Array<{ name: string; pk: number }>
      )
        .filter((c) => c.pk > 0)
        .map((c) => c.name);
      expect(afterPk).toHaveLength(3);
      expect(afterPk).toContain('ref');
    });

    it('fresh DB (SCHEMA with new PK) allows 2 refs same integration', () => {
      db = new Database(':memory:');
      applyPragmas(db);
      db.exec(SCHEMA);
      runMigrations(db);

      db.exec(`INSERT INTO tasks (id, title, description) VALUES ('t1', 'T', '')`);
      db.exec(
        `INSERT INTO task_external_refs (task_id, integration, ref) VALUES ('t1', 'linear', 'SHR-1')`,
      );
      db.exec(
        `INSERT INTO task_external_refs (task_id, integration, ref) VALUES ('t1', 'linear', 'SHR-2')`,
      );

      const rows = db
        .prepare(`SELECT ref FROM task_external_refs WHERE task_id = 't1' ORDER BY ref`)
        .all() as Array<{ ref: string }>;
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.ref)).toEqual(['SHR-1', 'SHR-2']);
    });
  });
});
