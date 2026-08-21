import { describe, it, expect, beforeEach } from '../bun-test.js';
import { createTestDb } from '../test-helpers.js';
import {
  defineCollection,
  putRecord,
  queryCollection,
  watchCollection,
  listPluginCollections,
  isCollectionDefined,
  unregisterPluginCollections,
  resetCollections,
} from './collections.js';

describe('plugins/collections', () => {
  beforeEach(() => {
    createTestDb();
    resetCollections();
  });

  it('qualifies a bare name on define and put, and reads it back qualified', async () => {
    defineCollection('coverage-bot', {
      name: 'baselines',
      schema: {
        type: 'object',
        properties: { branch: { type: 'string' }, pct: { type: 'number' } },
      },
      key: 'branch',
    });
    await putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 87 });

    const rows = await queryCollection('coverage-bot', 'baselines');
    expect(rows).toEqual([{ branch: 'main', pct: 87 }]);
  });

  it('lets two plugins exchange data knowing only the qualified collection name', async () => {
    defineCollection('coverage-bot', {
      name: 'baselines',
      schema: { type: 'object' },
      key: 'branch',
    });
    await putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 91 });

    // "reviewer-bot" never called define for coverage-bot's collection — it
    // only knows the qualified string, exactly like a real cross-plugin reader.
    const rows = await queryCollection('reviewer-bot', 'coverage-bot:baselines');
    expect(rows).toEqual([{ branch: 'main', pct: 91 }]);
  });

  it('rejects a plugin defining a core: collection name', () => {
    expect(() =>
      defineCollection('core', { name: 'diff', schema: { type: 'object' }, key: 'id' }),
    ).toThrow(/cannot define a "core:" collection/);
  });

  it('rejects defining the same name twice for the same plugin', () => {
    defineCollection('coverage-bot', { name: 'baselines', schema: { type: 'object' }, key: 'id' });
    expect(() =>
      defineCollection('coverage-bot', {
        name: 'baselines',
        schema: { type: 'object' },
        key: 'id',
      }),
    ).toThrow(/already defined/);
  });

  it.each([[''], [undefined], [null], [0], [42]])(
    'rejects defining a collection with an invalid key %p',
    (key) => {
      expect(() =>
        defineCollection('coverage-bot', {
          name: 'baselines',
          schema: { type: 'object' },
          // @ts-expect-error deliberately invalid input under test
          key,
        }),
      ).toThrow(/non-empty "key"/);
    },
  );

  it('rejects writing to an undefined collection, naming the plugin', async () => {
    await expect(putRecord('coverage-bot', 'baselines', { id: 1 })).rejects.toThrow(
      /plugin "coverage-bot".*not defined/,
    );
  });

  it('rejects a schema-violating write, naming the plugin', async () => {
    defineCollection('coverage-bot', {
      name: 'baselines',
      schema: {
        type: 'object',
        properties: { branch: { type: 'string' }, pct: { type: 'number' } },
        required: ['branch', 'pct'],
      },
      key: 'branch',
    });

    await expect(
      putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 'not-a-number' }),
    ).rejects.toThrow(/plugin "coverage-bot".*coverage-bot:baselines.*failed schema validation/);
  });

  it('rejects a record missing its key field', async () => {
    defineCollection('coverage-bot', {
      name: 'baselines',
      schema: { type: 'object' },
      key: 'branch',
    });
    await expect(putRecord('coverage-bot', 'baselines', { pct: 1 })).rejects.toThrow(
      /missing its key field "branch"/,
    );
  });

  // A dedicated, never-elsewhere-used collection name: the ajv validator cache
  // in output-contract.ts is keyed on the qualified name alone and only busts
  // on unregister, so a schema passed to a name already used by an earlier
  // test in this file would silently reuse THAT schema here. An unconstrained
  // `branch` field is what isolates "key extraction rejects a non-scalar"
  // from "schema itself rejects a non-string branch".
  it.each([[true], [{ nested: 1 }], [['array']], [NaN], [Infinity]])(
    'rejects a non-scalar key value %p',
    async (badKey) => {
      defineCollection('coverage-bot', {
        name: 'scalar-key-check',
        schema: { type: 'object' },
        key: 'branch',
      });
      await expect(
        putRecord('coverage-bot', 'scalar-key-check', { branch: badKey }),
      ).rejects.toThrow(/key field "branch" must be a string or number/);
    },
  );

  it('accepts a numeric key value, stringifying it as the storage key', async () => {
    defineCollection('coverage-bot', { name: 'runs', schema: { type: 'object' }, key: 'run' });
    await putRecord('coverage-bot', 'runs', { run: 42, ok: true });

    const rows = await queryCollection('coverage-bot', 'runs');
    expect(rows).toEqual([{ run: 42, ok: true }]);
  });

  it('rejects a qualified name passed to put as an out-of-scope cross-plugin write', async () => {
    defineCollection('coverage-bot', { name: 'baselines', schema: { type: 'object' }, key: 'id' });
    await expect(putRecord('reviewer-bot', 'coverage-bot:baselines', { id: 1 })).rejects.toThrow(
      /plugin "reviewer-bot".*bare local name/,
    );
  });

  it('upsert replaces on the same key rather than appending', async () => {
    defineCollection('coverage-bot', {
      name: 'baselines',
      schema: { type: 'object' },
      key: 'branch',
    });
    await putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 1 });
    await putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 2 });

    const rows = await queryCollection('coverage-bot', 'baselines');
    expect(rows).toEqual([{ branch: 'main', pct: 2 }]);
  });

  it('query supports where/orderBy/order/limit/offset', async () => {
    defineCollection('coverage-bot', {
      name: 'baselines',
      schema: { type: 'object' },
      key: 'branch',
    });
    await putRecord('coverage-bot', 'baselines', { branch: 'a', pct: 10, team: 'x' });
    await putRecord('coverage-bot', 'baselines', { branch: 'b', pct: 30, team: 'y' });
    await putRecord('coverage-bot', 'baselines', { branch: 'c', pct: 20, team: 'x' });

    expect(
      await queryCollection('coverage-bot', 'baselines', { where: { team: 'x' }, orderBy: 'pct' }),
    ).toEqual([
      { branch: 'a', pct: 10, team: 'x' },
      { branch: 'c', pct: 20, team: 'x' },
    ]);
    expect(
      await queryCollection('coverage-bot', 'baselines', {
        orderBy: 'pct',
        order: 'desc',
        limit: 1,
      }),
    ).toEqual([{ branch: 'b', pct: 30, team: 'y' }]);
    expect(
      await queryCollection('coverage-bot', 'baselines', { orderBy: 'pct', limit: 1, offset: 1 }),
    ).toEqual([{ branch: 'c', pct: 20, team: 'x' }]);
  });

  it('fires a watcher on write and returns a working unsubscribe', async () => {
    defineCollection('coverage-bot', {
      name: 'baselines',
      schema: { type: 'object' },
      key: 'branch',
    });
    const seen: unknown[] = [];
    const unsubscribe = watchCollection('coverage-bot:baselines', (record) => seen.push(record));

    await putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 1 });
    expect(seen).toEqual([{ branch: 'main', pct: 1 }]);

    unsubscribe();
    await putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 2 });
    expect(seen).toEqual([{ branch: 'main', pct: 1 }]);
  });

  it('tolerates a double unsubscribe', async () => {
    defineCollection('coverage-bot', {
      name: 'baselines',
      schema: { type: 'object' },
      key: 'branch',
    });
    const unsubscribe = watchCollection('coverage-bot:baselines', () => {});
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });

  it('listPluginCollections and isCollectionDefined reflect live definitions', () => {
    defineCollection('coverage-bot', { name: 'baselines', schema: { type: 'object' }, key: 'id' });
    defineCollection('coverage-bot', { name: 'runs', schema: { type: 'object' }, key: 'id' });
    defineCollection('reviewer-bot', { name: 'reviews', schema: { type: 'object' }, key: 'id' });

    expect(listPluginCollections('coverage-bot').sort()).toEqual([
      'coverage-bot:baselines',
      'coverage-bot:runs',
    ]);
    expect(isCollectionDefined('coverage-bot:baselines')).toBe(true);
    expect(isCollectionDefined('coverage-bot:missing')).toBe(false);
  });

  it('unregisterPluginCollections drops definitions but leaves stored rows readable', async () => {
    defineCollection('coverage-bot', {
      name: 'baselines',
      schema: { type: 'object' },
      key: 'branch',
    });
    await putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 1 });

    unregisterPluginCollections('coverage-bot');

    expect(isCollectionDefined('coverage-bot:baselines')).toBe(false);
    await expect(
      putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 2 }),
    ).rejects.toThrow(/not defined/);
    // Reads are unscoped and hit the DB directly, no definition required.
    const rows = await queryCollection('reviewer-bot', 'coverage-bot:baselines');
    expect(rows).toEqual([{ branch: 'main', pct: 1 }]);
  });

  it("unregisterPluginCollections leaves a sibling's watcher on the same name alive", async () => {
    defineCollection('coverage-bot', {
      name: 'baselines',
      schema: { type: 'object' },
      key: 'branch',
    });
    const seen: unknown[] = [];
    watchCollection('coverage-bot:baselines', (record) => seen.push(record));

    // Reload: unmount unregisters coverage-bot's definitions, then apply()
    // runs again and redefines the same qualified name.
    unregisterPluginCollections('coverage-bot');
    defineCollection('coverage-bot', {
      name: 'baselines',
      schema: { type: 'object' },
      key: 'branch',
    });

    await putRecord('coverage-bot', 'baselines', { branch: 'main', pct: 42 });
    expect(seen).toEqual([{ branch: 'main', pct: 42 }]);
  });

  it('unregisterPluginCollections only touches the named plugin', async () => {
    defineCollection('coverage-bot', { name: 'baselines', schema: { type: 'object' }, key: 'id' });
    defineCollection('reviewer-bot', { name: 'reviews', schema: { type: 'object' }, key: 'id' });

    unregisterPluginCollections('coverage-bot');

    await expect(putRecord('reviewer-bot', 'reviews', { id: 1 })).resolves.toBeUndefined();
  });

  it('redefining a collection after unregister validates against the NEW schema', async () => {
    defineCollection('coverage-bot', {
      name: 'baselines',
      schema: { type: 'object', properties: { pct: { type: 'number' } }, required: ['pct'] },
      key: 'pct',
    });
    await expect(putRecord('coverage-bot', 'baselines', { pct: 81 })).resolves.toBeUndefined();

    unregisterPluginCollections('coverage-bot');

    // Same qualified name, incompatible schema: pct is now a string.
    defineCollection('coverage-bot', {
      name: 'baselines',
      schema: { type: 'object', properties: { pct: { type: 'string' } }, required: ['pct'] },
      key: 'pct',
    });

    await expect(putRecord('coverage-bot', 'baselines', { pct: 'x' })).resolves.toBeUndefined();
    await expect(putRecord('coverage-bot', 'baselines', { pct: 81 })).rejects.toThrow(
      /schema validation/,
    );
  });
});
