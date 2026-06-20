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
import {
  getManagedTask,
  upsertManagedTask,
  eventsSince,
  createConversation,
} from './orchestrator/store.js';

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

    it('no-ops (200) when session_id is missing — valid token, nothing to attribute', async () => {
      db.prepare(`UPDATE agents SET hook_activity = 'idle' WHERE id = ?`).run('a1');

      await request(app).post('/api/hooks/user-prompt-submit?token=tok-test').send({}).expect(200);

      expect(getAgentActivity(db, 'a1').hook_activity).toBe('idle');
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

    it('no-ops (200) when required fields are missing — valid token', async () => {
      await request(app).post('/api/hooks/permission-request?token=tok-test').send({}).expect(200);

      expect(getPermissionPrompts(db, 't1')).toHaveLength(0);
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
      {
        name: 'Cursor edit_file → target_file',
        body: {
          tool_name: 'edit_file',
          tool_input: {
            target_file: 'src/server/foo.ts',
            code_edit: 'export {}',
            instructions: 'add',
          },
        },
        expected: 'edit_file: src/server/foo.ts',
      },
      {
        name: 'Cursor read_file → target_file',
        body: {
          tool_name: 'read_file',
          tool_input: { target_file: 'README.md', should_read_entire_file: true },
        },
        expected: 'read_file: README.md',
      },
      {
        name: 'Cursor run_terminal_cmd → command',
        body: {
          tool_name: 'run_terminal_cmd',
          tool_input: { command: 'bun run test', is_background: false },
        },
        expected: 'run_terminal_cmd: bun run test',
      },
      {
        name: 'Cursor web_search → search_term',
        body: {
          tool_name: 'web_search',
          tool_input: { search_term: 'octomux hook bridge' },
        },
        expected: 'web_search: octomux hook bridge',
      },
      {
        name: 'synthesized afterFileEdit → tool_name=Edit, file_path',
        body: { tool_name: 'Edit', tool_input: { file_path: '/tmp/cursor-edit.ts' } },
        expected: 'Edit: /tmp/cursor-edit.ts',
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

  describe('session-id drift recovery', () => {
    // a1 was recorded as sess-123 but the live Claude session drifts to sess-NEW
    // (resume / compaction / manual relaunch). Hooks then arrive with a session
    // id we never recorded.
    it('reattaches a drifted session to the sole agent and rebinds harness_session_id', async () => {
      db.prepare(`UPDATE agents SET hook_activity = 'idle' WHERE id = ?`).run('a1');

      await request(app)
        .post('/api/hooks/user-prompt-submit?token=tok-test')
        .send({ session_id: 'sess-NEW' })
        .expect(200);

      // Rebound so subsequent hooks exact-match…
      const row = db.prepare(`SELECT harness_session_id FROM agents WHERE id = ?`).get('a1') as {
        harness_session_id: string;
      };
      expect(row.harness_session_id).toBe('sess-NEW');
      // …and telemetry resumed.
      expect(getAgentActivity(db, 'a1').hook_activity).toBe('active');
    });

    it('does not reattach when the token maps to multiple live agents (ambiguous)', async () => {
      insertAgent(db, {
        id: 'a2',
        task_id: 't1',
        harness_session_id: 'sess-456',
        hook_token: 'tok-test',
        hook_activity: 'idle',
      } as any);
      db.prepare(`UPDATE agents SET hook_activity = 'idle' WHERE id = ?`).run('a1');

      await request(app)
        .post('/api/hooks/user-prompt-submit?token=tok-test')
        .send({ session_id: 'sess-NEW' })
        .expect(200);

      const a1 = db.prepare(`SELECT harness_session_id FROM agents WHERE id = 'a1'`).get() as {
        harness_session_id: string;
      };
      const a2 = db.prepare(`SELECT harness_session_id FROM agents WHERE id = 'a2'`).get() as {
        harness_session_id: string;
      };
      expect(a1.harness_session_id).toBe('sess-123');
      expect(a2.harness_session_id).toBe('sess-456');
      expect(getAgentActivity(db, 'a1').hook_activity).toBe('idle');
      expect(getAgentActivity(db, 'a2').hook_activity).toBe('idle');
    });

    it('does not resurrect a stopped agent (no live match for the token)', async () => {
      db.prepare(`UPDATE agents SET status = 'stopped' WHERE id = 'a1'`).run();

      await request(app)
        .post('/api/hooks/user-prompt-submit?token=tok-test')
        .send({ session_id: 'sess-NEW' })
        .expect(200);

      const a1 = db.prepare(`SELECT harness_session_id FROM agents WHERE id = 'a1'`).get() as {
        harness_session_id: string;
      };
      expect(a1.harness_session_id).toBe('sess-123');
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

// ─── Task 2.1: phase-complete hook + Stop reconciliation ───────────────────────

describe('POST /api/hooks/phase-complete', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    // Task + agent with a valid hook_token
    insertTask(db, { id: 'task-pc', runtime_state: 'running', workflow_status: 'in_progress' });
    insertAgent(db, {
      id: 'agent-pc',
      task_id: 'task-pc',
      harness_session_id: 'sess-pc',
      hook_token: 'tok-pc',
    } as any);
  });

  it('returns 401 when hook_token is missing', async () => {
    await request(app).post('/api/hooks/phase-complete').send({ task_id: 'task-pc' }).expect(401);
  });

  it('returns 401 when hook_token is not recognized', async () => {
    await request(app)
      .post('/api/hooks/phase-complete?token=bad-token')
      .send({ task_id: 'task-pc' })
      .expect(401);
  });

  it('advances managed_tasks.phase and emits task:phase_complete event', async () => {
    // Register task as orchestrator-managed with initial phase 'planning'
    const convId = createConversation({ title: 'test-conv-1' });
    upsertManagedTask({ conversation_id: convId, task_id: 'task-pc', phase: 'planning' });

    const beforeSeq = eventsSince(0).length;

    await request(app)
      .post('/api/hooks/phase-complete?token=tok-pc')
      .send({ task_id: 'task-pc', phase: 'awaiting_approval', artifacts: [] })
      .expect(200);

    // Phase advanced in managed_tasks
    const mt = getManagedTask('task-pc');
    expect(mt).toBeDefined();
    expect(mt!.phase).toBe('awaiting_approval');

    // task:phase_complete event persisted
    const allEvents = eventsSince(0);
    const newEvents = allEvents.slice(beforeSeq);
    const phaseEvent = newEvents.find((e) => e.type === 'task:phase_complete');
    expect(phaseEvent).toBeDefined();
    expect(phaseEvent!.task_id).toBe('task-pc');
    const payload = JSON.parse(phaseEvent!.payload);
    expect(payload.phase).toBe('awaiting_approval');
  });

  it('returns 200 for tasks not in managed_tasks (non-managed, no error)', async () => {
    await request(app)
      .post('/api/hooks/phase-complete?token=tok-pc')
      .send({ task_id: 'task-pc', phase: 'done' })
      .expect(200);
  });

  it('stores artifacts pointer in managed_tasks', async () => {
    const convId2 = createConversation({ title: 'test-conv-2' });
    upsertManagedTask({ conversation_id: convId2, task_id: 'task-pc', phase: 'planning' });

    await request(app)
      .post('/api/hooks/phase-complete?token=tok-pc')
      .send({
        task_id: 'task-pc',
        phase: 'awaiting_approval',
        artifacts: [{ path: 'plan.json', kind: 'plan' }],
      })
      .expect(200);

    const mt = getManagedTask('task-pc');
    expect(mt!.phase).toBe('awaiting_approval');
    // artifacts stored as JSON
    const arts = JSON.parse(mt!.artifacts ?? '[]');
    expect(arts).toHaveLength(1);
    expect(arts[0].path).toBe('plan.json');
  });
});

describe('Stop hook suppression for orchestrator-managed tasks', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    insertTask(db, { id: 'task-m', runtime_state: 'running', workflow_status: 'in_progress' });
    insertAgent(db, {
      id: 'agent-m',
      task_id: 'task-m',
      harness_session_id: 'sess-m',
      hook_token: 'tok-m',
    } as any);
  });

  it('auto-transitions in_progress → human_review for UN-managed tasks (existing behavior)', async () => {
    // task-m is NOT in managed_tasks → existing B4 behavior applies
    await request(app)
      .post('/api/hooks/stop?token=tok-m')
      .send({ session_id: 'sess-m' })
      .expect(200);

    const row = db.prepare(`SELECT workflow_status FROM tasks WHERE id = ?`).get('task-m') as {
      workflow_status: string;
    };
    expect(row.workflow_status).toBe('human_review');
  });

  it('SUPPRESSES in_progress → human_review auto-transition for orchestrator-managed tasks', async () => {
    // Register task as orchestrator-managed
    const convIdM = createConversation({ title: 'test-conv-m' });
    upsertManagedTask({ conversation_id: convIdM, task_id: 'task-m', phase: 'planning' });

    await request(app)
      .post('/api/hooks/stop?token=tok-m')
      .send({ session_id: 'sess-m' })
      .expect(200);

    // workflow_status must remain in_progress for managed tasks
    const row = db.prepare(`SELECT workflow_status FROM tasks WHERE id = ?`).get('task-m') as {
      workflow_status: string;
    };
    expect(row.workflow_status).toBe('in_progress');

    // Agent is still set idle (prompt resolution still happens)
    expect(getAgentActivity(db, 'agent-m').hook_activity).toBe('idle');
  });
});

describe('phase-complete + Stop ordering contract (§6.5, R3-I1)', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    insertTask(db, { id: 'task-ord', runtime_state: 'running', workflow_status: 'in_progress' });
    insertAgent(db, {
      id: 'agent-ord',
      task_id: 'task-ord',
      harness_session_id: 'sess-ord',
      hook_token: 'tok-ord',
    } as any);
    const convIdOrd = createConversation({ title: 'test-conv-ord' });
    upsertManagedTask({ conversation_id: convIdOrd, task_id: 'task-ord', phase: 'planning' });
  });

  it('phase-complete then Stop → phase advanced once, workflow_status unchanged', async () => {
    // Signal phase complete first
    await request(app)
      .post('/api/hooks/phase-complete?token=tok-ord')
      .send({ task_id: 'task-ord', phase: 'awaiting_approval', artifacts: [] })
      .expect(200);

    // Then agent stops (normal pause at phase boundary)
    await request(app)
      .post('/api/hooks/stop?token=tok-ord')
      .send({ session_id: 'sess-ord' })
      .expect(200);

    const mt = getManagedTask('task-ord');
    expect(mt!.phase).toBe('awaiting_approval');

    const row = db.prepare(`SELECT workflow_status FROM tasks WHERE id = ?`).get('task-ord') as {
      workflow_status: string;
    };
    expect(row.workflow_status).toBe('in_progress');

    const allEvents = eventsSince(0);
    const phaseEvents = allEvents.filter((e) => e.type === 'task:phase_complete');
    expect(phaseEvents).toHaveLength(1);
    expect(phaseEvents[0].task_id).toBe('task-ord');
  });

  it('Stop then phase-complete (race) → phase still advanced once, workflow_status unchanged', async () => {
    // Stop arrives first (before phase-complete)
    await request(app)
      .post('/api/hooks/stop?token=tok-ord')
      .send({ session_id: 'sess-ord' })
      .expect(200);

    // Phase-complete arrives after Stop
    await request(app)
      .post('/api/hooks/phase-complete?token=tok-ord')
      .send({ task_id: 'task-ord', phase: 'awaiting_approval', artifacts: [] })
      .expect(200);

    const mt = getManagedTask('task-ord');
    expect(mt!.phase).toBe('awaiting_approval');

    const row = db.prepare(`SELECT workflow_status FROM tasks WHERE id = ?`).get('task-ord') as {
      workflow_status: string;
    };
    expect(row.workflow_status).toBe('in_progress');

    const allEvents = eventsSince(0);
    const phaseEvents = allEvents.filter(
      (e) => e.type === 'task:phase_complete' && e.task_id === 'task-ord',
    );
    expect(phaseEvents).toHaveLength(1);
  });
});
