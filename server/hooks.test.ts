import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import {
  createTestDb,
  insertTask,
  insertAgent,
  insertPermissionPrompt,
  getPermissionPrompts,
  getAgentActivity,
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

  describe('POST /api/hooks/user-prompt-submit', () => {
    const activatableCases = [
      { from: 'idle', description: 'idle agent' },
      { from: 'waiting', description: 'waiting agent' },
    ];

    it.each(activatableCases)(
      'sets $description to active when user submits a prompt',
      async ({ from }) => {
        db.prepare(`UPDATE agents SET hook_activity = ? WHERE id = ?`).run(from, 'a1');

        await request(app)
          .post('/api/hooks/user-prompt-submit')
          .send({ session_id: 'sess-123' })
          .expect(200);

        expect(getAgentActivity(db, 'a1').hook_activity).toBe('active');
      },
    );

    const ignoreCases = [
      { name: 'unknown session_id', body: { session_id: 'unknown' } },
      { name: 'missing session_id', body: {} },
    ];

    it.each(ignoreCases)('ignores request with $name', async ({ body }) => {
      await request(app).post('/api/hooks/user-prompt-submit').send(body).expect(200);
    });
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

      expect(getAgentActivity(db, 'a1').hook_activity).toBe('waiting');
    });

    const ignoreCases = [
      {
        name: 'unknown session_id',
        body: { session_id: 'unknown', tool_name: 'Bash', tool_input: {} },
      },
      { name: 'missing fields', body: {} },
    ];

    it.each(ignoreCases)('ignores request with $name', async ({ body }) => {
      await request(app).post('/api/hooks/permission-request').send(body).expect(200);

      const prompts = getPermissionPrompts(db, 't1');
      expect(prompts).toHaveLength(0);
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

      expect(getAgentActivity(db, 'a1').hook_activity).toBe('active');
    });

    it('no-ops when no pending prompts exist', async () => {
      await request(app)
        .post('/api/hooks/post-tool-use')
        .send({ session_id: 'sess-123', tool_name: 'Bash', tool_input: {} })
        .expect(200);

      expect(getAgentActivity(db, 'a1').hook_activity).toBe('active');
    });

    it('does not override idle state (Stop hook may have fired first)', async () => {
      db.prepare(`UPDATE agents SET hook_activity = 'idle' WHERE id = ?`).run('a1');

      await request(app)
        .post('/api/hooks/post-tool-use')
        .send({ session_id: 'sess-123', tool_name: 'Bash', tool_input: {} })
        .expect(200);

      expect(getAgentActivity(db, 'a1').hook_activity).toBe('idle');
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

      expect(getAgentActivity(db, 'a1').hook_activity).toBe('idle');
    });

    it('ignores subagent stops (agent_id present in payload)', async () => {
      await request(app)
        .post('/api/hooks/stop')
        .send({ session_id: 'sess-123', agent_id: 'subagent-abc' })
        .expect(200);

      // Agent should remain active — subagent stop must not set it to idle
      expect(getAgentActivity(db, 'a1').hook_activity).toBe('active');
    });
  });
});
