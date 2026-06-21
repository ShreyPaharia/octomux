import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, insertTask } from '../test-helpers.js';
import { getDb } from '../db.js';
import {
  createConversation,
  appendMessage,
  getConversation,
  createCard,
  resolveCard,
  getCard,
  upsertManagedTask,
  appendEvent,
  eventsSince,
  getManagedTask,
  setGlobalMonitor,
  clearGlobalMonitor,
  getGlobalMonitorConversation,
} from './store.js';

describe('orchestrator store', () => {
  beforeEach(() => {
    createTestDb();
  });

  describe('createConversation / getConversation', () => {
    it('creates and retrieves a conversation', () => {
      const id = createConversation({ title: 'Test convo' });
      const conv = getConversation(id);
      expect(conv).toBeDefined();
      expect(conv!.id).toBe(id);
      expect(conv!.title).toBe('Test convo');
      expect(conv!.status).toBe('active');
      expect(conv!.created_at).toBeTruthy();
    });

    it('stores optional fields', () => {
      const id = createConversation({
        title: 'With session',
        tmux_window: 'octomux:2',
        claude_session_id: 'sess-abc123',
      });
      const conv = getConversation(id);
      expect(conv!.tmux_window).toBe('octomux:2');
      expect(conv!.claude_session_id).toBe('sess-abc123');
    });

    it('returns undefined for unknown id', () => {
      expect(getConversation('nonexistent')).toBeUndefined();
    });
  });

  describe('appendMessage', () => {
    it('inserts a message linked to a conversation', () => {
      const convId = createConversation({ title: 'Msg test' });
      const msgId = appendMessage({
        conversation_id: convId,
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: 'Hello' }]),
      });
      expect(msgId).toBeTruthy();
    });

    it('stores multiple messages in order', () => {
      const convId = createConversation({ title: 'Multi' });
      appendMessage({ conversation_id: convId, role: 'user', content: '"hi"' });
      appendMessage({ conversation_id: convId, role: 'assistant', content: '"hello"' });

      // Verify via raw DB that both messages exist and are correctly linked.
      const rows = getDb()
        .prepare(
          'SELECT * FROM orchestrator_messages WHERE conversation_id = ? ORDER BY created_at',
        )
        .all(convId) as Array<{ role: string; content: string }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].role).toBe('user');
      expect(rows[1].role).toBe('assistant');
    });
  });

  describe('action_cards — createCard / getCard / resolveCard', () => {
    it.each([
      ['pending', undefined],
      ['approved', '{"task_id":"t1"}'],
    ] as const)('creates a card with status %s', (_status, _result) => {
      const convId = createConversation({ title: 'Card test' });
      const cardId = createCard({
        conversation_id: convId,
        tool_use_id: 'tu-001',
        tool_name: 'Bash',
        input: JSON.stringify({ command: 'octomux create-task' }),
      });
      expect(cardId).toBeTruthy();
      const card = getCard(cardId);
      expect(card).toBeDefined();
      expect(card!.status).toBe('pending');
      expect(card!.tool_name).toBe('Bash');
    });

    it('resolves a card to approved', () => {
      const convId = createConversation({ title: 'Resolve test' });
      const cardId = createCard({
        conversation_id: convId,
        tool_use_id: 'tu-002',
        tool_name: 'Bash',
        input: '{}',
      });
      resolveCard(cardId, 'approved', '{"ok":true}');
      const card = getCard(cardId);
      expect(card!.status).toBe('approved');
      expect(card!.result).toBe('{"ok":true}');
      expect(card!.decided_at).toBeTruthy();
    });

    it.each(['approved', 'edited', 'rejected', 'executed'] as const)(
      'accepts resolution status %s',
      (status) => {
        const convId = createConversation({ title: `Res-${status}` });
        const cardId = createCard({
          conversation_id: convId,
          tool_use_id: `tu-${status}`,
          tool_name: 'Bash',
          input: '{}',
        });
        resolveCard(cardId, status, null);
        const card = getCard(cardId);
        expect(card!.status).toBe(status);
      },
    );

    it('returns undefined for unknown card id', () => {
      expect(getCard('unknown-card')).toBeUndefined();
    });
  });

  describe('upsertManagedTask / getManagedTask', () => {
    it('inserts a managed task row', () => {
      const db = getDb();
      const task = insertTask(db, { id: 'task-abc-mt1', worktree: null });
      const convId = createConversation({ title: 'MT test' });
      upsertManagedTask({ conversation_id: convId, task_id: task.id });
      const mt = getManagedTask(task.id);
      expect(mt).toBeDefined();
      expect(mt!.conversation_id).toBe(convId);
      expect(mt!.phase).toBe('planning');
      expect(mt!.last_event_seq).toBe(0);
      expect(mt!.attempts).toBe(0);
    });

    it('upserts phase and artifacts', () => {
      const db = getDb();
      const task = insertTask(db, { id: 'task-xyz-mt2', worktree: null });
      const convId = createConversation({ title: 'MT upsert' });
      upsertManagedTask({ conversation_id: convId, task_id: task.id });
      upsertManagedTask({
        conversation_id: convId,
        task_id: task.id,
        phase: 'awaiting_approval',
        artifacts: JSON.stringify({ plan: 'PLAN.md' }),
      });
      const mt = getManagedTask(task.id);
      expect(mt!.phase).toBe('awaiting_approval');
      expect(mt!.artifacts).toBe(JSON.stringify({ plan: 'PLAN.md' }));
    });

    it('preserves phase when a later upsert omits it (supervisor seq bump)', () => {
      const db = getDb();
      const task = insertTask(db, { id: 'task-mt3-seqbump', worktree: null });
      const convId = createConversation({ title: 'MT seq bump' });
      // Task registered directly in the implement phase (plain managed task).
      upsertManagedTask({ conversation_id: convId, task_id: task.id, phase: 'implementing' });
      // The supervisor routes events by bumping last_event_seq WITHOUT a phase —
      // this must NOT clobber the phase back to the 'planning' default.
      upsertManagedTask({ conversation_id: convId, task_id: task.id, last_event_seq: 42 });
      const mt = getManagedTask(task.id);
      expect(mt!.phase).toBe('implementing');
      expect(mt!.last_event_seq).toBe(42);
    });

    it('preserves attempts/last_event_seq when a later upsert omits them', () => {
      const db = getDb();
      const task = insertTask(db, { id: 'task-mt4-counters', worktree: null });
      const convId = createConversation({ title: 'MT counters' });
      upsertManagedTask({
        conversation_id: convId,
        task_id: task.id,
        attempts: 3,
        last_event_seq: 99,
      });
      // A phase-only update must leave the counters intact.
      upsertManagedTask({ conversation_id: convId, task_id: task.id, phase: 'done' });
      const mt = getManagedTask(task.id);
      expect(mt!.phase).toBe('done');
      expect(mt!.attempts).toBe(3);
      expect(mt!.last_event_seq).toBe(99);
    });
  });

  describe('appendEvent / eventsSince', () => {
    it('assigns autoincrement seq and returns events since a given seq', () => {
      const seq1 = appendEvent({ task_id: 'task-1', type: 'task:updated', payload: '{}' });
      const seq2 = appendEvent({ task_id: 'task-2', type: 'task:created', payload: '{}' });
      const seq3 = appendEvent({
        task_id: 'task-1',
        type: 'task:phase_complete',
        payload: '{"phase":"planning"}',
      });

      expect(seq1).toBeGreaterThan(0);
      expect(seq2).toBeGreaterThan(seq1);
      expect(seq3).toBeGreaterThan(seq2);

      const all = eventsSince(0);
      expect(all.length).toBeGreaterThanOrEqual(3);

      const since2 = eventsSince(seq2);
      expect(since2.every((e) => e.seq > seq2)).toBe(true);
    });

    it('seq autoincrements (monotone increasing)', () => {
      const seqs: number[] = [];
      for (let i = 0; i < 5; i++) {
        seqs.push(appendEvent({ task_id: `t-${i}`, type: 'task:updated', payload: '{}' }));
      }
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      }
    });

    it('returns empty array when no events after seq', () => {
      const seq = appendEvent({ task_id: 'only', type: 'task:updated', payload: '{}' });
      expect(eventsSince(seq)).toHaveLength(0);
    });

    it('supports new event types task:phase_complete and task:stuck', () => {
      const s1 = appendEvent({ task_id: 'pc', type: 'task:phase_complete', payload: '{}' });
      appendEvent({ task_id: 'st', type: 'task:stuck', payload: '{}' });
      const events = eventsSince(s1 - 1);
      expect(events.some((e) => e.type === 'task:phase_complete')).toBe(true);
      expect(events.some((e) => e.type === 'task:stuck')).toBe(true);
    });
  });

  describe('global-monitor mode (SHR-136)', () => {
    it('getGlobalMonitorConversation returns null when none is set', () => {
      expect(getGlobalMonitorConversation()).toBeNull();
    });

    it('setGlobalMonitor sets the global-monitor conversation', () => {
      const id = createConversation({ title: 'Monitor' });
      setGlobalMonitor(id);
      expect(getGlobalMonitorConversation()).toBe(id);
    });

    it('setGlobalMonitor clears any previous global-monitor', () => {
      const id1 = createConversation({ title: 'Monitor 1' });
      const id2 = createConversation({ title: 'Monitor 2' });
      setGlobalMonitor(id1);
      setGlobalMonitor(id2);
      expect(getGlobalMonitorConversation()).toBe(id2);
    });

    it('clearGlobalMonitor removes the global-monitor designation', () => {
      const id = createConversation({ title: 'Monitor To Clear' });
      setGlobalMonitor(id);
      clearGlobalMonitor();
      expect(getGlobalMonitorConversation()).toBeNull();
    });

    it('getConversation reflects is_global_monitor field', () => {
      const id = createConversation({ title: 'GM Conv' });
      setGlobalMonitor(id);
      const conv = getConversation(id);
      expect(conv!.is_global_monitor).toBe(1);
      clearGlobalMonitor();
      const conv2 = getConversation(id);
      expect(conv2!.is_global_monitor).toBe(0);
    });
  });
});
