/**
 * server/orchestrator/mcp/write.test.ts
 *
 * Tests for the MCP write-client idempotency key (SHR-163): the key is a stable
 * content hash of (action + input), independent of object key order, so a
 * retried RPC produces the same key and the server replays instead of re-running.
 */

import { describe, it, expect } from 'vitest';
import { actionIdempotencyKey } from './write.js';

describe('actionIdempotencyKey (SHR-163)', () => {
  it('is deterministic for the same action + input', () => {
    const a = actionIdempotencyKey('create-task', { title: 'T', repo_path: '/r' });
    const b = actionIdempotencyKey('create-task', { title: 'T', repo_path: '/r' });
    expect(a).toBe(b);
  });

  it('is independent of object key order', () => {
    const a = actionIdempotencyKey('create-task', { title: 'T', repo_path: '/r' });
    const b = actionIdempotencyKey('create-task', { repo_path: '/r', title: 'T' });
    expect(a).toBe(b);
  });

  it('differs when the action differs', () => {
    expect(actionIdempotencyKey('create-task', { task_id: 't1' })).not.toBe(
      actionIdempotencyKey('delete-task', { task_id: 't1' }),
    );
  });

  it('differs when the input differs', () => {
    expect(actionIdempotencyKey('create-task', { title: 'A' })).not.toBe(
      actionIdempotencyKey('create-task', { title: 'B' }),
    );
  });

  it('handles nested objects and arrays stably', () => {
    const a = actionIdempotencyKey('create-task', { nested: { b: 2, a: 1 }, list: [1, 2] });
    const b = actionIdempotencyKey('create-task', { list: [1, 2], nested: { a: 1, b: 2 } });
    expect(a).toBe(b);
  });
});
