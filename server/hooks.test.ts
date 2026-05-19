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
    insertTask(db, { id: 't1', runtime_state: 'running' });
    insertAgent(db, {
      id: 'a1',
      task_id: 't1',
      harness_session_id: 'sess-123',
      hook_token: 'tok-test',
    } as any);
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
          .post('/api/hooks/user-prompt-submit?token=tok-test')
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
      await request(app)
        .post('/api/hooks/user-prompt-submit?token=tok-test')
        .send(body)
        .expect(401);
    });
  });

  describe('POST /api/hooks/permission-request', () => {
    it('creates pending permission prompt and sets agent to waiting', async () => {
      await request(app)
        .post('/api/hooks/permission-request?token=tok-test')
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
      await request(app)
        .post('/api/hooks/permission-request?token=tok-test')
        .send(body)
        .expect(401);

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
        .post('/api/hooks/post-tool-use?token=tok-test')
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
        .post('/api/hooks/post-tool-use?token=tok-test')
        .send({ session_id: 'sess-123', tool_name: 'Bash', tool_input: {} })
        .expect(200);

      expect(getAgentActivity(db, 'a1').hook_activity).toBe('active');
    });

    it('does not override idle state (Stop hook may have fired first)', async () => {
      db.prepare(`UPDATE agents SET hook_activity = 'idle' WHERE id = ?`).run('a1');

      await request(app)
        .post('/api/hooks/post-tool-use?token=tok-test')
        .send({ session_id: 'sess-123', tool_name: 'Bash', tool_input: {} })
        .expect(200);

      expect(getAgentActivity(db, 'a1').hook_activity).toBe('idle');
    });

    const summaryCases = [
      {
        name: 'Bash → command',
        body: { tool_name: 'Bash', tool_input: { command: 'npm test' } },
        expected: 'Bash: npm test',
      },
      {
        name: 'Edit → file_path',
        body: {
          tool_name: 'Edit',
          tool_input: { file_path: '/abs/repo/src/foo.ts', old_string: 'a', new_string: 'b' },
        },
        expected: 'Edit: /abs/repo/src/foo.ts',
      },
      {
        name: 'Grep → pattern',
        body: { tool_name: 'Grep', tool_input: { pattern: 'TODO', path: '.' } },
        expected: 'Grep: TODO',
      },
      {
        name: 'WebFetch → url',
        body: { tool_name: 'WebFetch', tool_input: { url: 'https://example.com', prompt: 'x' } },
        expected: 'WebFetch: https://example.com',
      },
      {
        name: 'falls back to tool name when no recognized field',
        body: { tool_name: 'TodoWrite', tool_input: { todos: [] } },
        expected: 'TodoWrite',
      },
    ];

    it.each(summaryCases)('populates current_summary: $name', async ({ body, expected }) => {
      await request(app)
        .post('/api/hooks/post-tool-use?token=tok-test')
        .send({ session_id: 'sess-123', ...body })
        .expect(200);

      const row = db
        .prepare(`SELECT current_summary, current_summary_updated_at FROM tasks WHERE id = ?`)
        .get('t1') as { current_summary: string | null; current_summary_updated_at: string | null };
      expect(row.current_summary).toBe(expected);
      expect(row.current_summary_updated_at).not.toBeNull();
    });

    it('truncates very long tool details to ≤ 100 chars with ellipsis', async () => {
      const long = 'echo ' + 'x'.repeat(500);
      await request(app)
        .post('/api/hooks/post-tool-use?token=tok-test')
        .send({ session_id: 'sess-123', tool_name: 'Bash', tool_input: { command: long } })
        .expect(200);

      const row = db.prepare(`SELECT current_summary FROM tasks WHERE id = ?`).get('t1') as {
        current_summary: string;
      };
      expect(row.current_summary.length).toBeLessThanOrEqual(100);
      expect(row.current_summary.startsWith('Bash: ')).toBe(true);
      expect(row.current_summary.endsWith('…')).toBe(true);
    });

    it('leaves current_summary unchanged when tool_name is missing', async () => {
      await request(app)
        .post('/api/hooks/post-tool-use?token=tok-test')
        .send({ session_id: 'sess-123', tool_input: { command: 'noop' } })
        .expect(200);

      const row = db.prepare(`SELECT current_summary FROM tasks WHERE id = ?`).get('t1') as {
        current_summary: string | null;
      };
      expect(row.current_summary).toBeNull();
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
        .post('/api/hooks/stop?token=tok-test')
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

  describe('hook token auth', () => {
    it('rejects requests without token (401)', async () => {
      const res = await request(app).post('/api/hooks/stop').send({ session_id: 'sess-123' });
      expect(res.status).toBe(401);
    });

    it('rejects requests with wrong token (401)', async () => {
      const res = await request(app)
        .post('/api/hooks/stop?token=wrong')
        .send({ session_id: 'sess-123' });
      expect(res.status).toBe(401);
    });

    it('accepts requests with correct token', async () => {
      const res = await request(app)
        .post('/api/hooks/stop?token=tok-test')
        .send({ session_id: 'sess-123' });
      expect(res.status).toBe(200);
    });
  });
});

describe('findAgentByTokenAndSession', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertTask(db, { id: 't1', runtime_state: 'running' });
  });

  it('exact match by (token, session)', async () => {
    insertAgent(db, {
      id: 'a1',
      task_id: 't1',
      harness_session_id: 'sess-A',
      hook_token: 'tok-1',
    } as any);
    const { findAgentByTokenAndSession } = await import('./hooks.js');
    const row = findAgentByTokenAndSession('tok-1', 'sess-A');
    expect(row).toMatchObject({ id: 'a1', task_id: 't1' });
  });

  it('binds session id on first event when row has NULL harness_session_id', async () => {
    insertAgent(db, {
      id: 'a2',
      task_id: 't1',
      harness_session_id: null,
      hook_token: 'tok-2',
    } as any);

    const { findAgentByTokenAndSession } = await import('./hooks.js');
    const row = findAgentByTokenAndSession('tok-2', 'sess-bound');
    expect(row).toMatchObject({ id: 'a2', task_id: 't1' });

    const reread = db.prepare(`SELECT harness_session_id FROM agents WHERE id = ?`).get('a2') as {
      harness_session_id: string;
    };
    expect(reread.harness_session_id).toBe('sess-bound');
  });

  it('returns null on unknown token', async () => {
    insertAgent(db, {
      id: 'a3',
      task_id: 't1',
      harness_session_id: 'sess-C',
      hook_token: 'tok-3',
    } as any);
    const { findAgentByTokenAndSession } = await import('./hooks.js');
    expect(findAgentByTokenAndSession('wrong-token', 'sess-C')).toBeNull();
  });

  it('returns null when token+session row missing and no NULL-session fallback row', async () => {
    insertAgent(db, {
      id: 'a4',
      task_id: 't1',
      harness_session_id: 'sess-D',
      hook_token: 'tok-4',
    } as any);
    const { findAgentByTokenAndSession } = await import('./hooks.js');
    expect(findAgentByTokenAndSession('tok-4', 'unrelated-session')).toBeNull();
  });
});

describe('POST /api/hooks/session-start', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    insertTask(db, { id: 't-ss', runtime_state: 'running' });
    insertAgent(db, {
      id: 'a-ss',
      task_id: 't-ss',
      harness_session_id: null,
      hook_token: 'tok-ss',
    } as any);
  });

  it('binds session id and returns 200 with empty object', async () => {
    const res = await request(app)
      .post('/api/hooks/session-start?token=tok-ss')
      .send({ conversation_id: 'chat-xyz', is_background_agent: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});

    const reread = db.prepare(`SELECT harness_session_id FROM agents WHERE id = ?`).get('a-ss') as {
      harness_session_id: string;
    };
    expect(reread.harness_session_id).toBe('chat-xyz');
  });

  it('returns 401 when token is missing', async () => {
    const res = await request(app)
      .post('/api/hooks/session-start')
      .send({ conversation_id: 'chat-xyz' });
    expect(res.status).toBe(401);
  });

  it('returns 401 when no agent matches the token', async () => {
    const res = await request(app)
      .post('/api/hooks/session-start?token=wrong-token')
      .send({ conversation_id: 'chat-xyz' });
    expect(res.status).toBe(401);
  });

  it('falls back to session_id when conversation_id is absent', async () => {
    const res = await request(app)
      .post('/api/hooks/session-start?token=tok-ss')
      .send({ session_id: 'sess-from-fallback' });
    expect(res.status).toBe(200);

    const reread = db.prepare(`SELECT harness_session_id FROM agents WHERE id = ?`).get('a-ss') as {
      harness_session_id: string;
    };
    expect(reread.harness_session_id).toBe('sess-from-fallback');
  });
});
