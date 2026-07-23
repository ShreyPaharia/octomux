import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, insertTask, DEFAULTS } from '../../test-helpers.js';
import { addLearning, SHARED_LANE } from '../../repositories/agent-learnings.js';
import { seedLearnings, LEARN_INSTRUCTION } from './learn-prompt.js';
import type { Task } from '../../types.js';

describe('seedLearnings', () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
  });

  it('prefixes each seeded line with the learning id', () => {
    const task = insertTask(db, { ...DEFAULTS.runningTask, id: 't1' }) as Task;
    const l = addLearning({
      repo_path: task.repo_path,
      lane: SHARED_LANE,
      trigger: 't',
      lesson: 'use default: mocked',
      evidence: 'setup.ts',
    })!;

    const seeded = seedLearnings(task);

    expect(seeded).toEqual([`[${l.id}] use default: mocked (setup.ts)`]);
  });
});

describe('LEARN_INSTRUCTION', () => {
  it('tells the agent to unlearn a seeded note that is now false', () => {
    expect(LEARN_INSTRUCTION).toContain('octomux unlearn <id>');
  });
});
