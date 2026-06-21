import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createTestDb, insertTask } from './test-helpers.js';
import { setDb } from './db.js';
import { createApp } from './app.js';

describe('GET /api/health', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns 200 with a healthy report and all five fields', async () => {
    const res = await request(createApp()).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toEqual({ ok: true });
    expect(typeof res.body.uptime).toBe('number');
    expect(Number.isInteger(res.body.running_tasks)).toBe(true);
    expect(typeof res.body.data_dir).toBe('string');
    expect(res.body.data_dir.length).toBeGreaterThan(0);
  });

  it('counts only tasks in running runtime_state', async () => {
    insertTask(db, { id: 'r1', runtime_state: 'running' });
    insertTask(db, { id: 'r2', runtime_state: 'running' });
    insertTask(db, { id: 'r3', runtime_state: 'running' });
    insertTask(db, { id: 'i1', runtime_state: 'idle' });
    insertTask(db, { id: 'e1', runtime_state: 'error' });

    const res = await request(createApp()).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.running_tasks).toBe(3);
  });

  describe('when the database is unreachable', () => {
    afterEach(() => {
      // Restore a working in-memory DB for any later tests.
      createTestDb();
    });

    it('returns 503 with a degraded report', async () => {
      const failing = {
        prepare: vi.fn(() => {
          throw new Error('database is locked');
        }),
      } as unknown as Database.Database;
      setDb(failing);

      const res = await request(createApp()).get('/api/health');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('degraded');
      expect(res.body.db.ok).toBe(false);
      expect(typeof res.body.db.error).toBe('string');
      expect(res.body.db.error.length).toBeGreaterThan(0);
      expect(res.body.running_tasks).toBe(0);
    });
  });
});
