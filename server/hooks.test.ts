import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import {
  createTestDb,
  insertTask,
  insertAgent,
  insertPermissionPrompt,
  getPermissionPrompts,
} from './test-helpers.js';
import { createApp } from './app.js';

describe('Hook endpoints', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    insertTask(db, { id: 't1', status: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', claude_session_id: 'sess-123' });
  });

  describe('POST /api/hooks/permission-request', () => {
    it('creates pending permission prompt and sets agent to waiting', async () => {
      await request(app)
        .post('/api/hooks/permission-request')
        .send({
          session_id: 'sess-123',
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf dist' },
        })
        .expect(200);

      const prompts = getPermissionPrompts(db, 't1');
      expect(prompts).toHaveLength(1);
      expect(prompts[0].tool_name).toBe('Bash');
      expect(prompts[0].status).toBe('pending');
      expect(prompts[0].agent_id).toBe('a1');

      const agent = db.prepare('SELECT hook_activity FROM agents WHERE id = ?').get('a1') as {
        hook_activity: string;
      };
      expect(agent.hook_activity).toBe('waiting');
    });

    it('ignores unknown session_id', async () => {
      await request(app)
        .post('/api/hooks/permission-request')
        .send({ session_id: 'unknown', tool_name: 'Bash', tool_input: {} })
        .expect(200);

      const prompts = getPermissionPrompts(db, 't1');
      expect(prompts).toHaveLength(0);
    });

    it('ignores request with missing fields', async () => {
      await request(app).post('/api/hooks/permission-request').send({}).expect(200);
    });
  });

  describe('POST /api/hooks/post-tool-use', () => {
    it('resolves oldest pending prompt and sets agent to active', async () => {
      insertPermissionPrompt(db, {
        id: 'pp1',
        task_id: 't1',
        agent_id: 'a1',
        session_id: 'sess-123',
        created_at: '2026-01-01T00:00:00Z',
      });
      insertPermissionPrompt(db, {
        id: 'pp2',
        task_id: 't1',
        agent_id: 'a1',
        session_id: 'sess-123',
        created_at: '2026-01-01T00:01:00Z',
      });

      await request(app)
        .post('/api/hooks/post-tool-use')
        .send({ session_id: 'sess-123', tool_name: 'Bash', tool_input: {} })
        .expect(200);

      const prompts = getPermissionPrompts(db, 't1');
      const pp1 = prompts.find((p) => p.id === 'pp1');
      const pp2 = prompts.find((p) => p.id === 'pp2');
      expect(pp1?.status).toBe('resolved');
      expect(pp2?.status).toBe('pending');

      const agent = db.prepare('SELECT hook_activity FROM agents WHERE id = ?').get('a1') as {
        hook_activity: string;
      };
      expect(agent.hook_activity).toBe('active');
    });

    it('no-ops when no pending prompts exist', async () => {
      await request(app)
        .post('/api/hooks/post-tool-use')
        .send({ session_id: 'sess-123', tool_name: 'Bash', tool_input: {} })
        .expect(200);

      const agent = db.prepare('SELECT hook_activity FROM agents WHERE id = ?').get('a1') as {
        hook_activity: string;
      };
      expect(agent.hook_activity).toBe('active');
    });
  });

  describe('POST /api/hooks/stop', () => {
    it('resolves all pending prompts and sets agent to idle', async () => {
      insertPermissionPrompt(db, {
        id: 'pp1',
        task_id: 't1',
        agent_id: 'a1',
        session_id: 'sess-123',
      });
      insertPermissionPrompt(db, {
        id: 'pp2',
        task_id: 't1',
        agent_id: 'a1',
        session_id: 'sess-123',
      });

      await request(app)
        .post('/api/hooks/stop')
        .send({ session_id: 'sess-123', stop_hook_active: false })
        .expect(200);

      const prompts = getPermissionPrompts(db, 't1');
      expect(prompts.every((p) => p.status === 'resolved')).toBe(true);

      const agent = db.prepare('SELECT hook_activity FROM agents WHERE id = ?').get('a1') as {
        hook_activity: string;
      };
      expect(agent.hook_activity).toBe('idle');
    });
  });
});
