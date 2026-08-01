import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../../server/test-helpers.js';
import { runLearning } from './learning.js';
import { getDb } from '../../server/db.js';

let stdoutBuf = '';

beforeEach(() => {
  stdoutBuf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdoutBuf += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  createTestDb();
});

describe('octomux review learning add', () => {
  it('inserts a row into agent_learnings (review lane) and prints the new id', async () => {
    await runLearning(['add', '--repo-path', '/r', '--why', "don't memoize"]);
    const out = JSON.parse(stdoutBuf);
    expect(out.id).toBeTruthy();
    const row = getDb().prepare(`SELECT * FROM agent_learnings WHERE id = ?`).get(out.id) as Record<
      string,
      unknown
    >;
    expect(row.repo_path).toBe('/r');
    expect(row.lesson).toBe("don't memoize");
    expect(row.lane).toBe('review');
  });
});

describe('octomux review learning touch', () => {
  it('increments usage_count and sets last_used_at', async () => {
    await runLearning(['add', '--repo-path', '/r', '--why', 'w']);
    const id = JSON.parse(stdoutBuf).id as string;
    stdoutBuf = '';
    await runLearning(['touch', '--id', id]);
    const row = getDb().prepare(`SELECT * FROM agent_learnings WHERE id = ?`).get(id) as Record<
      string,
      unknown
    >;
    expect(row.usage_count).toBe(1);
    expect(row.last_used_at).not.toBeNull();
  });
});
