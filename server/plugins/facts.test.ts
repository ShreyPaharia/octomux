import { describe, it, expect, beforeEach } from '../bun-test.js';
import { createTestDb, insertTask } from '../test-helpers.js';
import {
  defineFactType,
  putFact,
  readFacts,
  watchFacts,
  putCoreFact,
  unregisterPluginFacts,
  resetFacts,
  CORE_FACT_TYPES,
} from './facts.js';

describe('plugins/facts', () => {
  beforeEach(() => {
    const db = createTestDb();
    insertTask(db, { id: 'task-1' });
    resetFacts();
  });

  it('qualifies a bare type on define and put, and reads it back qualified', async () => {
    defineFactType('coverage-bot', {
      type: 'coverage',
      schema: { type: 'object', properties: { pct: { type: 'number' } } },
    });
    await putFact('coverage-bot', 'task-1', 'coverage', { pct: 87 });

    const facts = await readFacts('task-1');
    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe('coverage-bot:coverage');
    expect(facts[0].payload).toEqual({ pct: 87 });
  });

  it('lets two plugins exchange data knowing only the qualified fact type', async () => {
    defineFactType('coverage-bot', {
      type: 'coverage',
      schema: { type: 'object' },
    });
    await putFact('coverage-bot', 'task-1', 'coverage', { pct: 91 });

    // "reviewer-bot" never called define for coverage-bot's type — it only
    // knows the qualified string, exactly like a real cross-plugin consumer.
    const seenByOtherPlugin = await readFacts('task-1', { type: 'coverage-bot:coverage' });
    expect(seenByOtherPlugin).toHaveLength(1);
    expect(seenByOtherPlugin[0].payload).toEqual({ pct: 91 });
  });

  it('rejects a plugin defining a core: fact type', () => {
    expect(() => defineFactType('core', { type: 'diff', schema: { type: 'object' } })).toThrow(
      /cannot define a "core:" fact type/,
    );
  });

  it('rejects writing to an undefined type, naming the plugin', async () => {
    await expect(putFact('coverage-bot', 'task-1', 'coverage', {})).rejects.toThrow(
      /plugin "coverage-bot".*not defined/,
    );
  });

  it('rejects a schema-violating write, naming the plugin and the failing field', async () => {
    defineFactType('coverage-bot', {
      type: 'coverage',
      schema: {
        type: 'object',
        properties: { pct: { type: 'number' } },
        required: ['pct'],
      },
    });

    await expect(
      putFact('coverage-bot', 'task-1', 'coverage', { pct: 'not-a-number' }),
    ).rejects.toThrow(/plugin "coverage-bot".*coverage-bot:coverage.*failed schema validation/);
  });

  it('rejects defining the same type twice for the same plugin', () => {
    defineFactType('coverage-bot', { type: 'coverage', schema: { type: 'object' } });
    expect(() =>
      defineFactType('coverage-bot', { type: 'coverage', schema: { type: 'object' } }),
    ).toThrow(/already defined/);
  });

  it('fires a watcher on write and returns a working unsubscribe', async () => {
    defineFactType('coverage-bot', { type: 'coverage', schema: { type: 'object' } });
    const seen: unknown[] = [];
    const unsubscribe = watchFacts('coverage-bot:coverage', (fact) => seen.push(fact.payload));

    await putFact('coverage-bot', 'task-1', 'coverage', { pct: 1 });
    expect(seen).toEqual([{ pct: 1 }]);

    unsubscribe();
    await putFact('coverage-bot', 'task-1', 'coverage', { pct: 2 });
    expect(seen).toEqual([{ pct: 1 }]);
  });

  it("fires a plugin's watch on a core fact", async () => {
    const seen: unknown[] = [];
    watchFacts('core:diff', (fact) => seen.push(fact.payload));

    await putCoreFact('task-1', 'core:diff', { files: 3 });
    expect(seen).toEqual([{ files: 3 }]);
  });

  it('rejects putCoreFact for a type outside CORE_FACT_TYPES', async () => {
    await expect(putCoreFact('task-1', 'not-a-core-type', {})).rejects.toThrow(
      /not a registered core fact type/,
    );
  });

  it('putCoreFact accepts every declared CORE_FACT_TYPES entry', async () => {
    for (const type of CORE_FACT_TYPES) {
      await expect(putCoreFact('task-1', type, {})).resolves.toBeUndefined();
    }
  });

  it('unregisterPluginFacts drops definitions so a later put is rejected as undefined', async () => {
    defineFactType('coverage-bot', { type: 'coverage', schema: { type: 'object' } });
    await putFact('coverage-bot', 'task-1', 'coverage', { pct: 1 });

    unregisterPluginFacts('coverage-bot');

    await expect(putFact('coverage-bot', 'task-1', 'coverage', { pct: 2 })).rejects.toThrow(
      /not defined/,
    );
  });

  it('unregisterPluginFacts does not delete already-written facts', async () => {
    defineFactType('coverage-bot', { type: 'coverage', schema: { type: 'object' } });
    await putFact('coverage-bot', 'task-1', 'coverage', { pct: 1 });

    unregisterPluginFacts('coverage-bot');

    const facts = await readFacts('task-1', { type: 'coverage-bot:coverage' });
    expect(facts).toHaveLength(1);
  });

  it('unregisterPluginFacts only touches the named plugin', async () => {
    defineFactType('coverage-bot', { type: 'coverage', schema: { type: 'object' } });
    defineFactType('reviewer-bot', { type: 'review', schema: { type: 'object' } });

    unregisterPluginFacts('coverage-bot');

    await expect(putFact('reviewer-bot', 'task-1', 'review', {})).resolves.toBeUndefined();
  });
});
