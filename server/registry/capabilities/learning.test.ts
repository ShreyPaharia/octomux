import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { getCapability, resetRegistry } from '../index.js';
import type { CapabilityContext } from '../types.js';
import { createTestDb } from '../../test-helpers.js';
import { addLearning, getLearning, SHARED_LANE } from '../../repositories/agent-learnings.js';
import { REVIEW_LANE } from '../../routes/learnings.js';

import { registerLearningCapabilities } from './learning.js';

const ctx: CapabilityContext = { caller: 'agent' };

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  resetRegistry();
  registerLearningCapabilities();
});

afterEach(() => {
  db.close();
});

// ─── Registration + shape ──────────────────────────────────────────────────────

describe('registerLearningCapabilities', () => {
  it('registers both capabilities without throwing', () => {
    resetRegistry();
    expect(() => registerLearningCapabilities()).not.toThrow();
    for (const id of ['learning.list', 'learning.delete']) {
      expect(getCapability(id), `${id} should be registered`).toBeDefined();
    }
  });

  it.each([
    ['learning.list', 'get', '/api/repos/:repoPath/learnings', 'auto'],
    ['learning.delete', 'delete', '/api/learnings/:id', 'always-ask'],
  ] as const)('%s has the expected http/tier shape', (id, method, path, tier) => {
    const cap = getCapability(id)!;
    expect(cap.http?.method).toBe(method);
    expect(cap.http?.path).toBe(path);
    expect(cap.tier).toBe(tier);
  });

  // Neither route carried auth before migration (see learning.ts's module
  // doc) — 'any resolved caller' is what preserves that, not a new gate.
  it.each(['learning.list', 'learning.delete'] as const)(
    '%s is callable by every caller class (no auth to preserve)',
    (id) => {
      expect(getCapability(id)!.callers).toEqual(['ui', 'human', 'agent']);
    },
  );

  it('learning.delete declares 204 (matches the route it replaces)', () => {
    expect(getCapability('learning.delete')!.http?.status).toBe(204);
  });
});

// ─── Handler delegation ─────────────────────────────────────────────────────────

describe('learning.list', () => {
  it('returns review-lane learnings for the repo in the LearningsPanel shape', async () => {
    addLearning({
      repo_path: '/repo/a',
      lane: REVIEW_LANE,
      trigger: 'review',
      lesson: 'use early return',
      evidence: 'comment-123',
    });
    // Different repo — must not leak in.
    addLearning({
      repo_path: '/repo/b',
      lane: REVIEW_LANE,
      trigger: 'review',
      lesson: 'other repo lesson',
      evidence: 'comment-456',
    });

    const cap = getCapability('learning.list')!;
    const result = (await cap.handler({ repoPath: encodeURIComponent('/repo/a') }, ctx)) as Array<
      Record<string, unknown>
    >;

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      repo_path: '/repo/a',
      why: 'use early return',
      created_from_comment_id: 'comment-123',
      usage_count: 0,
    });
  });
});

describe('learning.delete', () => {
  it('hard-deletes the learning', async () => {
    const row = addLearning({
      repo_path: '/repo/a',
      lane: SHARED_LANE,
      trigger: 't',
      lesson: 'delete me',
      evidence: 'e',
    })!;

    const cap = getCapability('learning.delete')!;
    await cap.handler({ id: row.id }, ctx);

    expect(getLearning(row.id)).toBeUndefined();
  });
});
