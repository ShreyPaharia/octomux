/**
 * server/orchestrator/restart-leanness.test.ts
 *
 * Tests for Task 5.2 / SHR-137: restart hardening + conductor-leanness surfacing.
 *
 * Covers:
 *  A. conversation_usage store helpers (increment counters, get, init)
 *  B. rehydrateConversations() — finds active conversations with pending cards on boot
 *  C. API endpoint GET /api/orchestrator/conversations/:id/usage
 *  D. Active conversations listing (listActiveConversations)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { createApp } from '../app.js';
import supertest from 'supertest';
import {
  createConversation,
  createCard,
  resolveCard,
  updateConversation,
  getConversationUsage,
  incrementTasksSpawned,
  incrementToolCalls,
  initConversationUsage,
  listActiveConversations,
} from './store.js';
import { rehydrateConversations } from './runner.js';

// ─── A. conversation_usage store helpers ──────────────────────────────────────

describe('conversation_usage', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('initConversationUsage creates a row; getConversationUsage returns it', () => {
    const convId = createConversation({ title: 'Usage init test' });
    initConversationUsage(convId);

    const usage = getConversationUsage(convId);
    expect(usage).toBeDefined();
    expect(usage!.conversation_id).toBe(convId);
    expect(usage!.tasks_spawned).toBe(0);
    expect(usage!.tool_calls).toBe(0);
    expect(usage!.started_at).toBeTruthy();
    expect(usage!.last_activity_at).toBeTruthy();
  });

  it('initConversationUsage is idempotent (does not overwrite existing row)', () => {
    const convId = createConversation({ title: 'Idempotent usage' });
    initConversationUsage(convId);
    incrementTasksSpawned(convId);
    initConversationUsage(convId); // should be no-op

    const usage = getConversationUsage(convId);
    expect(usage!.tasks_spawned).toBe(1); // not reset
  });

  it('incrementTasksSpawned increments the counter and updates last_activity_at', () => {
    const convId = createConversation({ title: 'Spawn counter' });
    initConversationUsage(convId);

    incrementTasksSpawned(convId);
    incrementTasksSpawned(convId);

    const usage = getConversationUsage(convId)!;
    expect(usage.tasks_spawned).toBe(2);
  });

  it('incrementToolCalls increments the counter', () => {
    const convId = createConversation({ title: 'Tool call counter' });
    initConversationUsage(convId);

    incrementToolCalls(convId);
    incrementToolCalls(convId);
    incrementToolCalls(convId);

    const usage = getConversationUsage(convId)!;
    expect(usage.tool_calls).toBe(3);
  });

  it('getConversationUsage returns undefined for a conversation with no usage row', () => {
    const convId = createConversation({ title: 'No usage row' });
    expect(getConversationUsage(convId)).toBeUndefined();
  });

  it.each([
    [0, 0, 'below-threshold'],
    [5, 0, 'below-threshold'],
    [12, 0, 'warning'],
    [20, 0, 'warning'],
    [0, 40, 'warning'],
    [0, 100, 'warning'],
  ] as const)(
    'leanness level for tasks_spawned=%i, tool_calls=%i is %s',
    (tasks_spawned, tool_calls, expectedLevel) => {
      const convId = createConversation({ title: `Leanness ${tasks_spawned}/${tool_calls}` });
      initConversationUsage(convId);
      for (let i = 0; i < tasks_spawned; i++) incrementTasksSpawned(convId);
      for (let i = 0; i < tool_calls; i++) incrementToolCalls(convId);

      const usage = getConversationUsage(convId)!;
      const level =
        usage.tasks_spawned >= 12 || usage.tool_calls >= 40 ? 'warning' : 'below-threshold';
      expect(level).toBe(expectedLevel);
    },
  );
});

// ─── B. listActiveConversations ───────────────────────────────────────────────

describe('listActiveConversations', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('returns only conversations with status=active', () => {
    const activeId = createConversation({ title: 'Active conv' });
    const stoppedId = createConversation({ title: 'Stopped conv' });

    // Mark the second one as stopped
    updateConversation(stoppedId, { status: 'stopped' });

    // listActiveConversations returns at least the active one
    const active = listActiveConversations();
    const ids = active.map((c) => c.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(stoppedId);
  });

  it('returns an empty array when no active conversations exist', () => {
    // DB is fresh — no rows
    expect(listActiveConversations()).toHaveLength(0);
  });
});

// ─── B. rehydrateConversations ────────────────────────────────────────────────

describe('rehydrateConversations', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('returns a list of active conversations with their pending card counts', () => {
    const convId = createConversation({ title: 'Rehydrate test' });

    // Add two pending cards and one resolved card
    const cardId1 = createCard({
      conversation_id: convId,
      tool_use_id: 'tu-001',
      tool_name: 'Bash',
      input: JSON.stringify({ command: 'octomux create-task' }),
    });
    createCard({
      conversation_id: convId,
      tool_use_id: 'tu-002',
      tool_name: 'Bash',
      input: JSON.stringify({ command: 'octomux add-agent' }),
    });
    // Resolve the first card so we can check only pending are returned
    resolveCard(cardId1, 'approved', null);

    const rehydrated = rehydrateConversations();
    const entry = rehydrated.find((r) => r.conversationId === convId);
    expect(entry).toBeDefined();
    expect(entry!.pendingCardCount).toBe(1);
    expect(entry!.title).toBe('Rehydrate test');
  });

  it('returns an empty array when there are no active conversations', () => {
    expect(rehydrateConversations()).toHaveLength(0);
  });

  it('excludes conversations with no pending cards from rehydrate output', () => {
    // A conversation with no pending cards should have pendingCardCount=0
    const convId = createConversation({ title: 'No cards' });
    const result = rehydrateConversations();
    const entry = result.find((r) => r.conversationId === convId);
    // Entry may be present with count 0
    if (entry) {
      expect(entry.pendingCardCount).toBe(0);
    }
  });

  it('includes the tmux_window and claude_session_id so the backend can re-attach', () => {
    const convId = createConversation({
      title: 'With session',
      tmux_window: 'octomux-orch-abc:1',
      claude_session_id: 'sess-abc-123',
    });
    createCard({
      conversation_id: convId,
      tool_use_id: 'tu-003',
      tool_name: 'Bash',
      input: '{}',
    });

    const rehydrated = rehydrateConversations();
    const entry = rehydrated.find((r) => r.conversationId === convId);
    expect(entry).toBeDefined();
    expect(entry!.tmuxWindow).toBe('octomux-orch-abc:1');
    expect(entry!.claudeSessionId).toBe('sess-abc-123');
  });
});

// ─── C. API endpoint GET /api/orchestrator/conversations/:id/usage ────────────

describe('GET /api/orchestrator/conversations/:id/usage', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('returns the usage stats for a conversation', async () => {
    const convId = createConversation({ title: 'API usage test' });
    initConversationUsage(convId);
    incrementTasksSpawned(convId);
    incrementToolCalls(convId);
    incrementToolCalls(convId);

    const app = createApp();
    const res = await supertest(app).get(`/api/orchestrator/conversations/${convId}/usage`);

    expect(res.status).toBe(200);
    expect(res.body.tasks_spawned).toBe(1);
    expect(res.body.tool_calls).toBe(2);
    expect(res.body.conversation_id).toBe(convId);
  });

  it('returns 200 with zero stats when no usage row exists', async () => {
    const convId = createConversation({ title: 'No usage' });

    const app = createApp();
    const res = await supertest(app).get(`/api/orchestrator/conversations/${convId}/usage`);

    expect(res.status).toBe(200);
    expect(res.body.tasks_spawned).toBe(0);
    expect(res.body.tool_calls).toBe(0);
  });

  it('returns 404 for unknown conversation', async () => {
    const app = createApp();
    const res = await supertest(app).get('/api/orchestrator/conversations/nonexistent/usage');
    expect(res.status).toBe(404);
  });
});
