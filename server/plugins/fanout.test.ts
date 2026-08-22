import { describe, it, expect, vi, beforeEach } from '../bun-test.js';

// Mock factories must be synchronous and registered BEFORE the module under
// test is imported — vi.mock() maps to bun's mock.module(), which does not
// hoist (unlike vitest's).
const mockGetSettings = vi.fn<() => Promise<{ fanout?: { maxConcurrency?: number } }>>();
vi.mock('../settings.js', () => ({
  getSettings: () => mockGetSettings(),
}));

const { createTestDb } = await import('../test-helpers.js');
const { createFanOutApi, setCollectionResolver, abortPluginFanOuts, resetFanOutState } =
  await import('./fanout.js');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sets the mocked host cap. Omit to fall back to the module default. */
function setHostLimit(maxConcurrency?: number): void {
  mockGetSettings.mockResolvedValue(
    maxConcurrency === undefined ? {} : { fanout: { maxConcurrency } },
  );
}

describe('plugins/fanout', () => {
  beforeEach(() => {
    createTestDb();
    resetFanOutState();
    mockGetSettings.mockReset();
    setHostLimit();
  });

  it('happy path: every item runs once, sees the right item, rows land done with the result', async () => {
    const api = createFanOutApi('demo');
    const seen: number[] = [];

    const summary = await api.run<{ n: number }, number>({
      name: 'step',
      source: { items: [{ n: 1 }, { n: 2 }, { n: 3 }] },
      each: async (item) => {
        seen.push(item.n);
        return item.n * 10;
      },
    });

    expect(summary.status).toBe('done');
    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(3);
    expect(summary.dead).toBe(0);
    expect(summary.pending).toBe(0);
    expect(seen.slice().sort()).toEqual([1, 2, 3]);

    const status = await api.status(summary.runId);
    expect(status).toBeDefined();
    expect(
      status!.items
        .map((i) => i.result)
        .slice()
        .sort(),
    ).toEqual([10, 20, 30]);
    for (const item of status!.items) {
      expect(item.status).toBe('done');
      expect(item.attempts).toBe(1);
    }
  });

  it('retry: a handler failing twice then succeeding ends done with attempts === 3', async () => {
    const api = createFanOutApi('demo');
    let calls = 0;

    const summary = await api.run({
      name: 'retry-step',
      source: { items: [{ id: 'x' }] },
      backoffMs: 1,
      each: async () => {
        calls += 1;
        if (calls < 3) throw new Error('nope');
        return 'ok';
      },
    });

    expect(summary.status).toBe('done');
    expect(calls).toBe(3);
    const status = await api.status(summary.runId);
    expect(status!.items[0].status).toBe('done');
    expect(status!.items[0].attempts).toBe(3);
  });

  it('dead-letter: an always-throwing handler ends dead after maxAttempts; other items still complete', async () => {
    const api = createFanOutApi('demo');

    const summary = await api.run({
      name: 'dead-step',
      source: { items: [{ id: 'bad' }, { id: 'good' }] },
      backoffMs: 1,
      maxAttempts: 2,
      each: async (item: { id: string }) => {
        if (item.id === 'bad') throw new Error('always fails');
        return 'fine';
      },
    });

    expect(summary.status).toBe('failed');
    expect(summary.dead).toBe(1);
    expect(summary.succeeded).toBe(1);

    const status = await api.status(summary.runId);
    const bad = status!.items.find((i) => (i.item as { id: string }).id === 'bad')!;
    const good = status!.items.find((i) => (i.item as { id: string }).id === 'good')!;
    expect(bad.status).toBe('dead');
    expect(bad.attempts).toBe(2);
    expect(good.status).toBe('done');
  });

  it('redrive: { resume } re-runs only dead items, leaves done items untouched', async () => {
    const api = createFanOutApi('demo');
    let failBad = true;

    const first = await api.run({
      name: 'redrive-step',
      source: { items: [{ id: 'bad' }, { id: 'good' }] },
      backoffMs: 1,
      maxAttempts: 1,
      each: async (item: { id: string }) => {
        if (item.id === 'bad' && failBad) throw new Error('fails first time');
        return 'ok';
      },
    });
    expect(first.status).toBe('failed');
    expect(first.dead).toBe(1);

    failBad = false;
    const calledFor: string[] = [];
    const second = await api.run({
      name: 'irrelevant-name-ignored-on-resume',
      source: { resume: first.runId },
      backoffMs: 1,
      each: async (item: { id: string }) => {
        calledFor.push(item.id);
        return 'ok-redrive';
      },
    });

    expect(second.status).toBe('done');
    expect(calledFor).toEqual(['bad']);
  });

  it('global concurrency cap: two simultaneous runs from different plugins share ONE host budget', async () => {
    setHostLimit(2);
    const apiA = createFanOutApi('plugin-a');
    const apiB = createFanOutApi('plugin-b');

    let inFlight = 0;
    let peak = 0;
    const handler = async (): Promise<string> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(15);
      inFlight -= 1;
      return 'ok';
    };

    const [summaryA, summaryB] = await Promise.all([
      apiA.run({
        name: 'a-step',
        source: { items: Array.from({ length: 5 }, (_, i) => ({ n: i })) },
        concurrency: 5,
        each: handler,
      }),
      apiB.run({
        name: 'b-step',
        source: { items: Array.from({ length: 5 }, (_, i) => ({ n: i })) },
        concurrency: 5,
        each: handler,
      }),
    ]);

    expect(summaryA.status).toBe('done');
    expect(summaryB.status).toBe('done');
    expect(inFlight).toBe(0);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
  }, 10000);

  it.each([
    { hostLimit: 2, requested: 5, expectedPeak: 2 },
    { hostLimit: 5, requested: 2, expectedPeak: 2 },
  ])(
    'per-run concurrency $requested against host limit $hostLimit peaks at $expectedPeak',
    async ({ hostLimit, requested, expectedPeak }) => {
      setHostLimit(hostLimit);
      const api = createFanOutApi('demo');
      let inFlight = 0;
      let peak = 0;

      const summary = await api.run({
        name: 'clamp-step',
        source: { items: Array.from({ length: 6 }, (_, i) => ({ n: i })) },
        concurrency: requested,
        each: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await sleep(10);
          inFlight -= 1;
          return 'ok';
        },
      });

      expect(summary.status).toBe('done');
      expect(peak).toBe(expectedPeak);
    },
  );

  it('abort: abortPluginFanOuts resolves canceled, stops scheduling, leaves nothing running', async () => {
    setHostLimit(1);
    const api = createFanOutApi('demo');
    const called: number[] = [];

    const summary = await api.run({
      name: 'abort-step',
      source: { items: Array.from({ length: 5 }, (_, i) => ({ n: i })) },
      concurrency: 1,
      each: async (item: { n: number }) => {
        called.push(item.n);
        if (item.n === 1) abortPluginFanOuts('demo');
        await sleep(20);
        return 'ok';
      },
    });

    expect(summary.status).toBe('canceled');
    expect(called).toEqual([0, 1]);

    const status = await api.status(summary.runId);
    for (const item of status!.items) {
      expect(item.status).not.toBe('running');
    }

    // Drain the abandoned item-1 handler's sleep before the next test's
    // beforeEach resets the shared host semaphore — otherwise its late
    // `finally { release() }` could land mid the next test and skew its
    // concurrency count.
    await sleep(30);
  });

  it('collection source with no resolver throws naming ctx.records', async () => {
    const api = createFanOutApi('demo');
    await expect(
      api.run({
        name: 'coll-step',
        source: { collection: 'widgets' },
        each: async () => 'ok',
      }),
    ).rejects.toThrow(/ctx\.records/);
  });

  it('collection source with a resolver fans out its returned array', async () => {
    setCollectionResolver(async (pluginId, collection) => {
      expect(pluginId).toBe('demo');
      expect(collection).toBe('widgets');
      return [{ n: 1 }, { n: 2 }];
    });
    const api = createFanOutApi('demo');
    const seen: number[] = [];

    const summary = await api.run({
      name: 'coll-step',
      source: { collection: 'widgets' },
      each: async (item: { n: number }) => {
        seen.push(item.n);
        return 'ok';
      },
    });

    expect(summary.status).toBe('done');
    expect(summary.total).toBe(2);
    expect(seen.slice().sort()).toEqual([1, 2]);
  });

  it('default key dedupes identical items and is order-insensitive over object keys', async () => {
    const api = createFanOutApi('demo');
    const seen: unknown[] = [];

    const summary = await api.run({
      name: 'dedupe-step',
      source: {
        items: [
          { a: 1, b: 2 },
          { b: 2, a: 1 },
          { a: 1, b: 2 },
        ],
      },
      each: async (item) => {
        seen.push(item);
        return 'ok';
      },
    });

    expect(summary.total).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it("status() and list() never return another plugin's runs", async () => {
    const apiA = createFanOutApi('plugin-a');
    const apiB = createFanOutApi('plugin-b');

    const summaryA = await apiA.run({
      name: 'shared-name',
      source: { items: [{ n: 1 }] },
      each: async () => 'ok',
    });
    await apiB.run({
      name: 'shared-name',
      source: { items: [{ n: 1 }] },
      each: async () => 'ok',
    });

    expect(await apiB.status(summaryA.runId)).toBeUndefined();

    const listA = await apiA.list();
    expect(listA).toHaveLength(1);
    expect(listA[0].runId).toBe(summaryA.runId);

    const listANamed = await apiA.list('shared-name');
    expect(listANamed).toHaveLength(1);
  });
});
