import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './test-helpers.js';
import { getDb } from './db.js';
import { buildTriagePrompt, insertTriageTask } from './prod-log-triage-tasks.js';

describe('buildTriagePrompt', () => {
  it('pins the triage task id and embeds the log command + skill invocation', () => {
    const prompt = buildTriagePrompt({
      triageTaskId: 'triage-1',
      repoShort: 'octomux-agents',
      logCommand: 'flyctl logs -a my-app',
    });
    expect(prompt).toContain('triage-1');
    expect(prompt).toContain('flyctl logs -a my-app');
    expect(prompt).toContain('/octomux:prod-log-triage');
  });
});

describe('insertTriageTask', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('inserts a task with source=prod_log_triage', () => {
    const id = insertTriageTask({
      id: 'triage-1',
      repoPath: '/repo',
      branch: 'triage/octomux-agents-2026-07-18',
      baseBranch: 'main',
      title: 'Prod log triage: octomux-agents',
      description: 'Scheduled prod-log-triage run',
      initialPrompt: 'do the thing',
    });
    expect(id).toBe('triage-1');
    const row = getDb().prepare('SELECT source FROM tasks WHERE id = ?').get(id);
    expect(row).toEqual({ source: 'prod_log_triage' });
  });

  it('stamps schedule_id when scheduleId is provided', () => {
    const id = insertTriageTask({
      id: 'triage-2',
      repoPath: '/repo',
      branch: 'triage/octomux-agents-2026-07-18',
      baseBranch: 'main',
      title: 'Prod log triage: octomux-agents',
      description: 'Scheduled prod-log-triage run',
      initialPrompt: 'do the thing',
      scheduleId: 'sched-1',
    });
    const row = getDb().prepare('SELECT schedule_id FROM tasks WHERE id = ?').get(id);
    expect(row).toEqual({ schedule_id: 'sched-1' });
  });

  it('leaves schedule_id null when scheduleId is omitted', () => {
    const id = insertTriageTask({
      id: 'triage-3',
      repoPath: '/repo',
      branch: 'triage/octomux-agents-2026-07-18',
      baseBranch: 'main',
      title: 'Prod log triage: octomux-agents',
      description: 'Scheduled prod-log-triage run',
      initialPrompt: 'do the thing',
    });
    const row = getDb().prepare('SELECT schedule_id FROM tasks WHERE id = ?').get(id);
    expect(row).toEqual({ schedule_id: null });
  });
});
