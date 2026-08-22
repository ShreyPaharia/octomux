import { describe, it, expect, beforeEach } from '../bun-test.js';
import { createTestDb } from '../test-helpers.js';
import {
  defineStore,
  putRecord,
  watchStore,
  unregisterTaskScopedStores,
  beginCheckpoint,
  endCheckpoint,
  interruptedFor,
  resetRecords,
} from './records.js';
import type { RecordEnvelope } from '@octomux/plugin-api';

describe('plugins/records', () => {
  beforeEach(() => {
    createTestDb();
    resetRecords();
  });

  it('redefining a store after unregister validates against the NEW schema', async () => {
    // ports facts.test.ts:177 + collections.test.ts:270 — the ajv validator cache
    // is keyed by qualified name and MUST be busted on redefine
    defineStore('p', {
      name: 's',
      scope: 'task',
      mode: 'append',
      schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
    });
    unregisterTaskScopedStores('p');
    defineStore('p', {
      name: 's',
      scope: 'task',
      mode: 'append',
      schema: { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
    });
    await expect(putRecord('p', 's', { b: 'ok' }, 't1')).resolves.toBeUndefined();
    await expect(putRecord('p', 's', { a: 1 }, 't1')).rejects.toThrow(/schema/i);
  });

  it("reloading the defining plugin does not kill another plugin's watcher", async () => {
    // ports facts.test.ts:206 + collections.test.ts:248 — watcher lifetime belongs
    // to the WATCHING plugin, not the defining one
    defineStore('owner', { name: 's', scope: 'task', mode: 'append' });
    const seen: RecordEnvelope[] = [];
    watchStore('observer', 'owner:s', (r) => seen.push(r));
    unregisterTaskScopedStores('owner');
    defineStore('owner', { name: 's', scope: 'task', mode: 'append' });
    await putRecord('owner', 's', { n: 1 }, 't1');
    expect(seen).toHaveLength(1);
  });

  it('rejects a non-scalar key value and stringifies a numeric one', async () => {
    // ports collections.test.ts:65-129
    defineStore('p', { name: 'c', scope: 'durable', mode: 'upsert', key: 'id' });
    await expect(putRecord('p', 'c', { id: 7 })).resolves.toBeUndefined();
    await expect(putRecord('p', 'c', { id: { nested: true } })).rejects.toThrow(/string or number/);
  });

  it('rejects a qualified name passed to put — cross-plugin writes are out of scope', async () => {
    // ports collections.test.ts:139
    defineStore('p', { name: 'c', scope: 'durable', mode: 'upsert', key: 'id' });
    await expect(putRecord('p', 'other:c', { id: '1' })).rejects.toThrow(/bare local name/);
  });

  it('rejects append+key and upsert-without-key at define time', () => {
    expect(() => defineStore('p', { name: 'a', scope: 'task', mode: 'append', key: 'id' })).toThrow(
      /append/,
    );
    expect(() => defineStore('p', { name: 'b', scope: 'durable', mode: 'upsert' })).toThrow(/key/);
  });

  it('rejects a taskId on a durable store and a missing one on a task store', async () => {
    defineStore('p', { name: 'd', scope: 'durable', mode: 'upsert', key: 'id' });
    defineStore('p', { name: 't', scope: 'task', mode: 'append' });
    await expect(putRecord('p', 'd', { id: '1' }, 'task-1')).rejects.toThrow(/durable/);
    await expect(putRecord('p', 't', { n: 1 })).rejects.toThrow(/taskId/);
  });

  it('two stores owned by one plugin do not collide on a checkpoint key', () => {
    defineStore('p', { name: 'x', scope: 'durable', mode: 'upsert', key: 'id' });
    defineStore('p', { name: 'y', scope: 'durable', mode: 'upsert', key: 'id' });
    beginCheckpoint('p', 'x', 'job', { a: 1 }, 'mount-A');
    beginCheckpoint('p', 'y', 'job', { b: 2 }, 'mount-A');
    const left = interruptedFor('p', 'mount-B');
    expect(left.map((r) => r.store).sort()).toEqual(['p:x', 'p:y']);
    endCheckpoint('p', 'x', 'job');
    expect(interruptedFor('p', 'mount-B').map((r) => r.store)).toEqual(['p:y']);
  });
});
