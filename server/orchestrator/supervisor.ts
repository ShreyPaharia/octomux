/**
 * server/orchestrator/supervisor.ts
 *
 * Supervisor for the orchestrator chat (Task 2.2 / SHR-125).
 *
 * Responsibilities (spec §6, §9.1):
 *  - Single subscriber to the durable `events` log (not one-per-conversation).
 *  - Routes each event to the *single* conversation that owns the task via
 *    `managed_tasks(conversation_id, task_id)`. Events for unowned tasks are
 *    dropped (global-monitor mode is Phase 5).
 *  - Idempotent injection: keyed by `(task_id, event_seq)` so re-delivery /
 *    restart cannot double-fire. Updates `managed_tasks.last_event_seq` after
 *    processing to maintain the replay cursor.
 *  - Serialized per-conversation injection queue: notes never interleave a
 *    streaming turn or an open card.
 *  - Replay: on `replay(convId)` call, reads `eventsSince(last_event_seq)` for
 *    all tasks managed by that conversation and processes missed events in order.
 *  - Concise notes only — never the raw event firehose.
 *
 * Architecture:
 *  - `createSupervisor()` returns a `Supervisor` instance with:
 *      `processEvent(event)` — process a single raw event
 *      `replay(convId)`      — replay missed events for a conversation
 *      `on('inject', cb)`    — subscribe to injections (for tests / ws push)
 *      `stop()`              — clean up queues / listeners
 *  - Injections are pushed to connected ws clients via `pushToConversation`
 *    from stream.ts, and the EventEmitter 'inject' event is used in tests.
 *
 * Pointers-not-contents: the supervisor injects concise text notes (task id +
 * phase/status summary), never plan/diff/file body contents.
 */

import { EventEmitter } from 'events';
import { childLogger } from '../logger.js';
import { getDb } from '../db.js';
import { eventsSince, upsertManagedTask } from './store.js';
import { pushToConversation } from './stream.js';

const logger = childLogger('orchestrator/supervisor');

// ─── Types ────────────────────────────────────────────────────────────────────

/** A raw event entry from the durable events log. */
export interface RawEvent {
  seq: number;
  task_id: string;
  type: string;
  payload: string;
}

/** An injection produced by the supervisor for a conversation. */
export interface SupervisorInjection {
  conversation_id: string;
  task_id: string;
  seq: number;
  note: string;
}

/** Public interface for a supervisor instance. */
export interface Supervisor {
  /** Process a single raw event from the events log. */
  processEvent(event: RawEvent): Promise<void>;
  /** Replay all missed events for a conversation (since its last_event_seq). */
  replay(convId: string): Promise<void>;
  /** Subscribe to injection events (used in tests). */
  on(event: 'inject', listener: (inj: SupervisorInjection) => void): this;
  /** Stop the supervisor and clean up per-conversation queues. */
  stop(): void;
}

// ─── Seen-set for idempotency ──────────────────────────────────────────────────

/**
 * In-memory set of `${task_id}:${seq}` strings that have been processed in
 * this supervisor instance. Prevents double-injection from re-delivery.
 * (last_event_seq in the DB is the durable cursor; this covers in-memory re-calls.)
 */
type SeenKey = `${string}:${number}`;

// ─── Per-conversation queue ────────────────────────────────────────────────────

/**
 * Serialise injections per conversation: each conversation has a promise chain
 * so a note never interleaves a concurrent injection for the same conversation.
 */
type ConvQueue = Promise<void>;

// ─── Note formatters ──────────────────────────────────────────────────────────

/** Parse the event payload, returning an empty object on failure. */
function parsePayload(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Produce a concise human-readable note for an event.
 * Notes must never contain plan/diff/file contents — only task id + summary.
 */
function formatNote(event: RawEvent): string {
  const payload = parsePayload(event.payload);

  switch (event.type) {
    case 'task:phase_complete': {
      const phase = typeof payload.phase === 'string' ? payload.phase : 'unknown';
      return `[supervisor] task \`${event.task_id}\` completed phase: ${phase}`;
    }
    case 'task:stuck': {
      const reason = typeof payload.reason === 'string' ? ` (${payload.reason})` : '';
      return `[supervisor] task \`${event.task_id}\` appears stuck${reason}`;
    }
    case 'task:updated': {
      return `[supervisor] task \`${event.task_id}\` updated`;
    }
    case 'task:created': {
      return `[supervisor] task \`${event.task_id}\` created`;
    }
    case 'task:deleted': {
      return `[supervisor] task \`${event.task_id}\` deleted`;
    }
    default: {
      return `[supervisor] task \`${event.task_id}\` event: ${event.type}`;
    }
  }
}

// ─── findConversationForTask ───────────────────────────────────────────────────

/**
 * Look up the conversation that owns a task via managed_tasks.
 * Returns the conversation_id, or null if the task is unowned.
 */
function findConversationForTask(taskId: string): string | null {
  const row = getDb()
    .prepare(`SELECT conversation_id FROM managed_tasks WHERE task_id = ? LIMIT 1`)
    .get(taskId) as { conversation_id: string } | undefined;
  return row?.conversation_id ?? null;
}

// ─── createSupervisor ─────────────────────────────────────────────────────────

/** Create a new Supervisor instance. */
export function createSupervisor(): Supervisor {
  const emitter = new EventEmitter();
  const seen = new Set<SeenKey>();
  const convQueues = new Map<string, ConvQueue>();

  /** Enqueue work for a conversation's serialized queue. */
  function enqueue(convId: string, work: () => Promise<void>): void {
    const prev = convQueues.get(convId) ?? Promise.resolve();
    const next = prev.then(work).catch((err) => {
      logger.warn({ conversation_id: convId, err }, 'supervisor: injection queue error');
    });
    convQueues.set(convId, next);
  }

  /**
   * Actually perform the injection: format the note, persist + push to ws,
   * update last_event_seq in managed_tasks, and emit the 'inject' event.
   */
  async function inject(convId: string, event: RawEvent): Promise<void> {
    const note = formatNote(event);
    const injection: SupervisorInjection = {
      conversation_id: convId,
      task_id: event.task_id,
      seq: event.seq,
      note,
    };

    logger.info(
      {
        conversation_id: convId,
        task_id: event.task_id,
        event_type: event.type,
        seq: event.seq,
      },
      'supervisor: injecting note',
    );

    // Push to connected ws clients (also persists as a message)
    const wsMessage = JSON.stringify({ type: 'message', role: 'assistant', text: note });
    pushToConversation(convId, wsMessage);

    // Update the durable replay cursor
    upsertManagedTask({
      conversation_id: convId,
      task_id: event.task_id,
      last_event_seq: event.seq,
    });

    // Notify test listeners
    emitter.emit('inject', injection);
  }

  /**
   * Process a single raw event.
   * - Route to the owning conversation (drop if unowned).
   * - Idempotency: skip if (task_id, seq) already seen.
   * - Enqueue in the per-conversation serialized queue.
   */
  async function processEvent(event: RawEvent): Promise<void> {
    const key: SeenKey = `${event.task_id}:${event.seq}`;
    if (seen.has(key)) {
      logger.debug(
        { task_id: event.task_id, seq: event.seq },
        'supervisor: duplicate event, skipping',
      );
      return;
    }

    const convId = findConversationForTask(event.task_id);
    if (!convId) {
      logger.debug(
        { task_id: event.task_id, type: event.type },
        'supervisor: unowned task, dropping event',
      );
      return;
    }

    seen.add(key);

    enqueue(convId, () => inject(convId, event));

    // Wait for the queue item to settle (so callers can await processEvent in tests)
    await convQueues.get(convId);
  }

  /**
   * Replay missed events for a conversation.
   * Reads all tasks managed by convId from managed_tasks, finds the minimum
   * last_event_seq across them, and replays events since that cursor.
   * Each event is passed through processEvent (idempotency applies).
   */
  async function replay(convId: string): Promise<void> {
    // Find all tasks managed by this conversation and their last_event_seq values
    const rows = getDb()
      .prepare(`SELECT task_id, last_event_seq FROM managed_tasks WHERE conversation_id = ?`)
      .all(convId) as Array<{ task_id: string; last_event_seq: number }>;

    if (rows.length === 0) {
      logger.debug({ conversation_id: convId }, 'supervisor: no managed tasks to replay');
      return;
    }

    // Replay per-task from its own cursor
    for (const row of rows) {
      const missed = eventsSince(row.last_event_seq).filter((e) => e.task_id === row.task_id);
      for (const ev of missed) {
        await processEvent({
          seq: ev.seq,
          task_id: ev.task_id,
          type: ev.type,
          payload: ev.payload,
        });
      }
    }
  }

  function on(event: 'inject', listener: (inj: SupervisorInjection) => void): Supervisor {
    emitter.on(event, listener);
    return supervisor;
  }

  function stop(): void {
    emitter.removeAllListeners();
    convQueues.clear();
    seen.clear();
  }

  const supervisor: Supervisor = {
    processEvent,
    replay,
    on,
    stop,
  };

  return supervisor;
}
