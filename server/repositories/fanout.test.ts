import { describe, it, expect, beforeEach } from '../bun-test.js';
import type Database from '../sqlite.js';
import { createTestDb } from '../test-helpers.js';
import {
  createFanOutRun,
  getFanOutRun,
  listFanOutRuns,
  setFanOutRunStatus,
  setFanOutRunTotal,
  upsertFanOutItems,
  listFanOutItems,
  pendingFanOutItems,
  setFanOutItemStatus,
  resetDeadFanOutItems,
  resetRunningFanOutItems,
  countFanOutItems,
} from './fanout.js';

describe('fanout repository', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('creates a run and reads it back', () => {
    const run = createFanOutRun('coverage-bot', 'coverage-bot:sweep');
    expect(run.id).toBeTruthy();
    expect(run.pluginId).toBe('coverage-bot');
    expect(run.name).toBe('coverage-bot:sweep');
    expect(run.status).toBe('running');
    expect(run.total).toBe(0);
    expect(getFanOutRun(run.id)).toEqual(run);
  });

  it('returns undefined for an unknown run id', () => {
    expect(getFanOutRun('nope')).toBeUndefined();
  });

  it.each([
    ['pluginId', { pluginId: 'plugin-a' }],
    ['name', { name: 'plugin-a:sweep' }],
  ] as const)('listFanOutRuns filters by %s', (_label, filter) => {
    createFanOutRun('plugin-a', 'plugin-a:sweep');
    createFanOutRun('plugin-b', 'plugin-b:sweep');

    const rows = listFanOutRuns(filter);
    expect(rows).toHaveLength(1);
    expect(rows[0].pluginId).toBe('plugin-a');
  });

  it('listFanOutRuns orders newest first', () => {
    const first = createFanOutRun('plugin-a', 'plugin-a:sweep');
    db.prepare(`UPDATE fanout_runs SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?`).run(
      first.id,
    );
    const second = createFanOutRun('plugin-a', 'plugin-a:sweep');
    db.prepare(`UPDATE fanout_runs SET created_at = '2020-01-02T00:00:00Z' WHERE id = ?`).run(
      second.id,
    );

    const rows = listFanOutRuns({ pluginId: 'plugin-a' });
    expect(rows.map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it('setFanOutRunStatus and setFanOutRunTotal update the row and bump updated_at', () => {
    const run = createFanOutRun('plugin-a', 'plugin-a:sweep');
    setFanOutRunStatus(run.id, 'done');
    setFanOutRunTotal(run.id, 5);

    const updated = getFanOutRun(run.id)!;
    expect(updated.status).toBe('done');
    expect(updated.total).toBe(5);
  });

  it('upsertFanOutItems inserts new rows and preserves already-completed rows', () => {
    const run = createFanOutRun('plugin-a', 'plugin-a:sweep');
    upsertFanOutItems(run.id, [
      { key: 'a', item: { n: 1 } },
      { key: 'b', item: { n: 2 } },
    ]);
    setFanOutItemStatus(run.id, 'a', { status: 'done', attempts: 1, result: { ok: true } });

    // Re-run over the same source, plus one new item.
    upsertFanOutItems(run.id, [
      { key: 'a', item: { n: 1 } },
      { key: 'b', item: { n: 2 } },
      { key: 'c', item: { n: 3 } },
    ]);

    const items = listFanOutItems(run.id);
    expect(items.map((i) => i.key)).toEqual(['a', 'b', 'c']);
    const a = items.find((i) => i.key === 'a')!;
    expect(a.status).toBe('done');
    expect(a.attempts).toBe(1);
    expect(a.result).toEqual({ ok: true });
    const c = items.find((i) => i.key === 'c')!;
    expect(c.status).toBe('pending');
    expect(c.attempts).toBe(0);
  });

  it('item JSON round-trips a non-trivial object', () => {
    const run = createFanOutRun('plugin-a', 'plugin-a:sweep');
    const item = { id: 'x-1', tags: ['a', 'b'], nested: { count: 3, ok: null } };
    upsertFanOutItems(run.id, [{ key: 'x-1', item }]);

    expect(listFanOutItems(run.id)[0].item).toEqual(item);
  });

  it('pendingFanOutItems returns only pending rows in insertion order', () => {
    const run = createFanOutRun('plugin-a', 'plugin-a:sweep');
    upsertFanOutItems(run.id, [
      { key: 'a', item: 1 },
      { key: 'b', item: 2 },
      { key: 'c', item: 3 },
    ]);
    setFanOutItemStatus(run.id, 'b', { status: 'done' });

    expect(pendingFanOutItems(run.id).map((i) => i.key)).toEqual(['a', 'c']);
  });

  it('setFanOutItemStatus writes result and error and bumps updated_at', () => {
    const run = createFanOutRun('plugin-a', 'plugin-a:sweep');
    upsertFanOutItems(run.id, [{ key: 'a', item: 1 }]);
    const before = listFanOutItems(run.id)[0].updatedAt;

    setFanOutItemStatus(run.id, 'a', {
      status: 'dead',
      attempts: 3,
      error: 'boom',
    });

    const after = listFanOutItems(run.id)[0];
    expect(after.status).toBe('dead');
    expect(after.attempts).toBe(3);
    expect(after.error).toBe('boom');
    expect(after.updatedAt >= before).toBe(true);
  });

  it('resetDeadFanOutItems only touches dead rows and zeroes attempts', () => {
    const run = createFanOutRun('plugin-a', 'plugin-a:sweep');
    upsertFanOutItems(run.id, [
      { key: 'a', item: 1 },
      { key: 'b', item: 2 },
      { key: 'c', item: 3 },
    ]);
    setFanOutItemStatus(run.id, 'a', { status: 'dead', attempts: 3, error: 'boom' });
    setFanOutItemStatus(run.id, 'b', { status: 'running', attempts: 1 });
    setFanOutItemStatus(run.id, 'c', { status: 'done', attempts: 1, result: { ok: true } });

    const count = resetDeadFanOutItems(run.id);
    expect(count).toBe(1);

    const items = listFanOutItems(run.id);
    const a = items.find((i) => i.key === 'a')!;
    expect(a.status).toBe('pending');
    expect(a.attempts).toBe(0);
    expect(a.error).toBeUndefined();
    expect(items.find((i) => i.key === 'b')!.status).toBe('running');
    expect(items.find((i) => i.key === 'c')!.status).toBe('done');
  });

  it('resetRunningFanOutItems only touches running rows and keeps attempts', () => {
    const run = createFanOutRun('plugin-a', 'plugin-a:sweep');
    upsertFanOutItems(run.id, [
      { key: 'a', item: 1 },
      { key: 'b', item: 2 },
    ]);
    setFanOutItemStatus(run.id, 'a', { status: 'running', attempts: 2 });
    setFanOutItemStatus(run.id, 'b', { status: 'dead', attempts: 5 });

    const count = resetRunningFanOutItems(run.id);
    expect(count).toBe(1);

    const items = listFanOutItems(run.id);
    const a = items.find((i) => i.key === 'a')!;
    expect(a.status).toBe('pending');
    expect(a.attempts).toBe(2);
    expect(items.find((i) => i.key === 'b')!.status).toBe('dead');
  });

  it('countFanOutItems returns all four keys, zero when absent', () => {
    const run = createFanOutRun('plugin-a', 'plugin-a:sweep');
    expect(countFanOutItems(run.id)).toEqual({ pending: 0, running: 0, done: 0, dead: 0 });

    upsertFanOutItems(run.id, [
      { key: 'a', item: 1 },
      { key: 'b', item: 2 },
      { key: 'c', item: 3 },
    ]);
    setFanOutItemStatus(run.id, 'b', { status: 'done' });
    setFanOutItemStatus(run.id, 'c', { status: 'dead' });

    expect(countFanOutItems(run.id)).toEqual({ pending: 1, running: 0, done: 1, dead: 1 });
  });
});
