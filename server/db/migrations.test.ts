import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getArtifactSummary } from '../artifact.js';
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
    expect(taskCols).not.toContain('current_summary');
    expect(taskCols).not.toContain('current_summary_updated_at');

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

  describe('retired current_summary columns', () => {
    /**
     * Simulate a pre-retirement DB: SCHEMA no longer creates these columns, so
     * an upgrade install needs them added back by hand before runMigrations can
     * exercise the back-fill path.
     */
    function oldInstall(worktree: string | null): Database.Database {
      const instance = new Database(':memory:');
      applyPragmas(instance);
      instance.exec(SCHEMA);
      instance.exec(`ALTER TABLE tasks ADD COLUMN current_summary TEXT`);
      instance.exec(`ALTER TABLE tasks ADD COLUMN current_summary_updated_at TEXT`);
      if (worktree) {
        instance
          .prepare(
            `INSERT INTO worktrees (id, path, repo_path, mode)
             VALUES ('w1', ?, '/tmp/repo', 'worktree')`,
          )
          .run(worktree);
      }
      instance
        .prepare(
          `INSERT INTO tasks (id, title, description, worktree_id,
                              current_summary, current_summary_updated_at)
           VALUES ('t1', 'T', 'D', ?, 'old summary', '2026-01-01 00:00:00')`,
        )
        .run(worktree ? 'w1' : null);
      return instance;
    }

    it('copies an existing summary into the task artifact, keeping its timestamp', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-mig-'));
      try {
        db = oldInstall(dir);
        runMigrations(db);

        const got = getArtifactSummary(dir);
        expect(got.current_summary).toBe('old summary');
        // Not restamped to now — a migrated summary that looks freshly written
        // would defeat the staleness indicator on every upgraded board card.
        expect(got.current_summary_updated_at).toBe('2026-01-01 00:00:00');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('KEEPS the columns rather than dropping them', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-mig-'));
      try {
        db = oldInstall(dir);
        runMigrations(db);

        // Deliberately not dropped: a task whose worktree is gone has nowhere
        // to put an artifact, so dropping would destroy that prose forever for
        // no functional gain — nothing reads the column either way.
        const taskCols = (db.pragma('table_info(tasks)') as Array<{ name: string }>).map(
          (c) => c.name,
        );
        expect(taskCols).toContain('current_summary');
        expect(taskCols).toContain('current_summary_updated_at');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not throw for a task with no worktree to write an artifact into', () => {
      db = oldInstall(null);
      expect(() => runMigrations(db)).not.toThrow();
      const row = db.prepare(`SELECT id, current_summary FROM tasks WHERE id = 't1'`).get();
      // Unmigratable, but preserved in the retired column rather than lost.
      expect(row).toMatchObject({ id: 't1', current_summary: 'old summary' });
    });
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
});
