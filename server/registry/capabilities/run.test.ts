import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { getCapability, resetRegistry } from '../index.js';
import type { CapabilityContext } from '../types.js';
import { createTestDb, insertTask, insertAgent } from '../../test-helpers.js';
import { insertRun } from '../../repositories/runs.js';
import { createLoopRun } from '../../repositories/loop-runs.js';
import { createLoopGroup } from '../../repositories/loop-groups.js';

import { registerRunCapabilities } from './run.js';

const ctx: CapabilityContext = { caller: 'agent' };

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  resetRegistry();
  registerRunCapabilities();
});

afterEach(() => {
  db.close();
});

// ─── Registration + shape ──────────────────────────────────────────────────────

describe('registerRunCapabilities', () => {
  it('registers run.emit without throwing', () => {
    resetRegistry();
    expect(() => registerRunCapabilities()).not.toThrow();
    expect(getCapability('run.emit')).toBeDefined();
  });

  it('run.emit declares POST /api/runs/:id/emit, auth: bearer-hook-token, callers: [agent] only', () => {
    const cap = getCapability('run.emit')!;
    expect(cap.http?.method).toBe('post');
    expect(cap.http?.path).toBe('/api/runs/:id/emit');
    expect(cap.http?.auth).toBe('bearer-hook-token');
    expect(cap.callers).toEqual(['agent']);
    expect(cap.tier).toBe('auto');
  });
});

// ─── Handler behavior ───────────────────────────────────────────────────────────

describe('run.emit handler', () => {
  it('404s for an unknown run id', async () => {
    const cap = getCapability('run.emit')!;
    await expect(
      cap.handler({ id: 'does-not-exist', status: 'done', reason: 'x' }, ctx),
    ).rejects.toMatchObject({ status: 404 });
  });

  describe('loop-backed run (workflow_kind: loop)', () => {
    it('records the emit and returns the polymorphic detail with `loop` populated', async () => {
      insertTask(db, { id: 't1' });
      insertAgent(db, { id: 'a1', task_id: 't1', hook_token: 'tok-1' } as any);
      const loopRun = createLoopRun({ task_id: 't1', spec_json: '{}' });
      const run = insertRun({
        workflowKind: 'loop',
        trigger: 'manual',
        taskId: 't1',
        loopRunId: loopRun.id,
      });

      const cap = getCapability('run.emit')!;
      const result = (await cap.handler(
        { id: run.id, status: 'done', reason: 'Fixed the bug.' },
        ctx,
      )) as any;

      expect(result.loop.status).toBe('done');
      expect(result.loop.termination_reason).toBe('Fixed the bug.');
      expect(result.loopGroup).toBeNull();
    });

    it('rejects an invalid status enum', async () => {
      insertTask(db, { id: 't1' });
      const loopRun = createLoopRun({ task_id: 't1', spec_json: '{}' });
      const run = insertRun({
        workflowKind: 'loop',
        trigger: 'manual',
        taskId: 't1',
        loopRunId: loopRun.id,
      });

      const cap = getCapability('run.emit')!;
      await expect(
        cap.handler({ id: run.id, status: 'finished', reason: 'x' }, ctx),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects a missing reason', async () => {
      insertTask(db, { id: 't1' });
      const loopRun = createLoopRun({ task_id: 't1', spec_json: '{}' });
      const run = insertRun({
        workflowKind: 'loop',
        trigger: 'manual',
        taskId: 't1',
        loopRunId: loopRun.id,
      });

      const cap = getCapability('run.emit')!;
      await expect(cap.handler({ id: run.id, status: 'done' }, ctx)).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  describe('loop-group run (workflow_kind: loop-group)', () => {
    it('records the judge verdict, finishes the group run, and returns `loopGroup` populated', async () => {
      const groupRun = insertRun({ workflowKind: 'loop-group', trigger: 'manual' });
      const group = createLoopGroup({
        spec_json: '{}',
        n: 2,
        repo_path: '/repo',
        base_branch: 'main',
        run_id: groupRun.id,
      });
      insertTask(db, { id: 'cand-a' });
      insertTask(db, { id: 'cand-b' });
      const candA = createLoopRun({ task_id: 'cand-a', spec_json: '{}', group_id: group.id });
      createLoopRun({ task_id: 'cand-b', spec_json: '{}', group_id: group.id });

      const cap = getCapability('run.emit')!;
      const result = (await cap.handler(
        { id: groupRun.id, winnerLoopRunId: candA.id, rationale: 'Cleaner diff.' },
        ctx,
      )) as any;

      expect(result.loopGroup.judge_status).toBe('done');
      expect(result.loopGroup.winner_loop_run_id).toBe(candA.id);
      expect(result.status).toBe('done');
      expect(result.loop).toBeNull();
    });

    it('rejects a winnerLoopRunId that is not a group member', async () => {
      const groupRun = insertRun({ workflowKind: 'loop-group', trigger: 'manual' });
      createLoopGroup({
        spec_json: '{}',
        n: 2,
        repo_path: '/repo',
        base_branch: 'main',
        run_id: groupRun.id,
      });

      const cap = getCapability('run.emit')!;
      await expect(
        cap.handler({ id: groupRun.id, winnerLoopRunId: 'not-a-member', rationale: 'x' }, ctx),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects a missing rationale', async () => {
      const groupRun = insertRun({ workflowKind: 'loop-group', trigger: 'manual' });
      createLoopGroup({
        spec_json: '{}',
        n: 2,
        repo_path: '/repo',
        base_branch: 'main',
        run_id: groupRun.id,
      });

      const cap = getCapability('run.emit')!;
      await expect(
        cap.handler({ id: groupRun.id, winnerLoopRunId: 'x' }, ctx),
      ).rejects.toMatchObject({ status: 400 });
    });
  });
});
