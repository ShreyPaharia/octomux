import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers.js';
import { getDb } from './db.js';
import { buildDocDriftPrompt, insertDocDriftTask } from './doc-drift-tasks.js';

describe('buildDocDriftPrompt', () => {
  it('pins the doc-drift task id and embeds the skill invocation', () => {
    const prompt = buildDocDriftPrompt({
      docDriftTaskId: 'drift-1',
      repoShort: 'octomux-agents',
    });
    expect(prompt).toContain('drift-1');
    expect(prompt).toContain('doc-drift');
  });
});

describe('insertDocDriftTask', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('inserts a task with source=doc_drift', () => {
    const id = insertDocDriftTask({
      id: 'drift-1',
      repoPath: '/repo',
      branch: 'doc-drift/octomux-agents-2026-07-18',
      baseBranch: 'main',
      title: 'Doc drift: octomux-agents',
      description: 'Scheduled doc-drift run',
      initialPrompt: 'do the thing',
    });
    expect(id).toBe('drift-1');
    const row = getDb().prepare('SELECT source FROM tasks WHERE id = ?').get(id);
    expect(row).toEqual({ source: 'doc_drift' });
  });

  it('stamps schedule_id when scheduleId is provided', () => {
    const id = insertDocDriftTask({
      id: 'drift-2',
      repoPath: '/repo',
      branch: 'doc-drift/octomux-agents-2026-07-18',
      baseBranch: 'main',
      title: 'Doc drift: octomux-agents',
      description: 'Scheduled doc-drift run',
      initialPrompt: 'do the thing',
      scheduleId: 'sched-1',
    });
    const row = getDb().prepare('SELECT schedule_id FROM tasks WHERE id = ?').get(id);
    expect(row).toEqual({ schedule_id: 'sched-1' });
  });

  it('leaves schedule_id null when scheduleId is omitted', () => {
    const id = insertDocDriftTask({
      id: 'drift-3',
      repoPath: '/repo',
      branch: 'doc-drift/octomux-agents-2026-07-18',
      baseBranch: 'main',
      title: 'Doc drift: octomux-agents',
      description: 'Scheduled doc-drift run',
      initialPrompt: 'do the thing',
    });
    const row = getDb().prepare('SELECT schedule_id FROM tasks WHERE id = ?').get(id);
    expect(row).toEqual({ schedule_id: null });
  });
});
