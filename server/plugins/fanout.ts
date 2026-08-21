/**
 * `ctx.fanout` — run a step per item, not per schedule fire. See the doc
 * comment on `FanOutApi` in `@octomux/plugin-api` for the full pitch; this is
 * the implementation.
 *
 * ## The global semaphore
 *
 * The host concurrency cap (`settings.fanout.maxConcurrency`, default
 * `DEFAULT_FANOUT_CONCURRENCY`) is enforced by ONE module-level counting
 * semaphore (`hostSemaphore` below), shared across every plugin's every
 * fan-out run in this process. A per-run `concurrency` only ever narrows how
 * many of a single run's workers may hold the semaphore at once — it never
 * grants the run its own budget. Three plugins each running `concurrency: 4`
 * against a host cap of 4 still produce at most 4 concurrent `each()` calls
 * total, not 12. Acquire happens right before `each()`, release in a
 * `finally`, waiters served FIFO.
 */
import { createHash } from 'node:crypto';
import type {
  FanOutApi,
  FanOutItemStatus,
  FanOutRunState,
  FanOutRunStatus,
  FanOutRunSummary,
  FanOutSource,
  FanOutSpec,
} from '@octomux/plugin-api';
import { childLogger } from '../logger.js';
import { getSettings } from '../settings.js';
import { qualify } from './qualify.js';
import {
  countFanOutItems,
  createFanOutRun,
  getFanOutRun,
  listFanOutItems,
  listFanOutRuns,
  pendingFanOutItems,
  resetDeadFanOutItems,
  resetRunningFanOutItems,
  setFanOutItemStatus,
  setFanOutRunStatus,
  setFanOutRunTotal,
  upsertFanOutItems,
  type FanOutItemRecord,
  type FanOutRunRecord,
} from '../repositories/fanout.js';

const logger = childLogger('plugins/fanout');

export const DEFAULT_FANOUT_CONCURRENCY = 4;

/** Resolves a `{ collection, query }` source. Set by ctx.collections (SHR-275) when it lands. */
export type CollectionResolver = (
  pluginId: string,
  collection: string,
  query?: Record<string, unknown>,
) => Promise<unknown[]>;

let collectionResolver: CollectionResolver | undefined;

export function setCollectionResolver(fn?: CollectionResolver): void {
  collectionResolver = fn;
}

/**
 * A FIFO counting semaphore whose capacity can change at runtime —
 * `setLimit` is called at the top of every `run()` with the freshly-read
 * host cap, so a settings change takes effect for every run sharing this
 * instance, not just the next one created. Growing wakes queued waiters
 * immediately; shrinking is enforced gradually (existing holders finish
 * normally, the tighter cap only throttles future `acquire()`s).
 */
class Semaphore {
  private capacity: number;
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.capacity = limit;
    this.available = limit;
  }

  setLimit(limit: number): void {
    this.available += limit - this.capacity;
    this.capacity = limit;
    while (this.available > 0 && this.waiters.length > 0) {
      this.available -= 1;
      this.waiters.shift()!();
    }
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }

  /** Test-only: full reinitialize, discarding any queued waiters. */
  reset(limit: number): void {
    this.capacity = limit;
    this.available = limit;
    this.waiters.length = 0;
  }
}

// This ONE instance is shared by every plugin's every fan-out run in the
// process — that sharing is the whole point of the ticket (see the header
// comment above).
const hostSemaphore = new Semaphore(DEFAULT_FANOUT_CONCURRENCY);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Sorts object keys recursively so key order never affects the hash. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map(
      (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function defaultKeyFor(item: unknown): string {
  return createHash('sha1').update(stableStringify(item)).digest('hex').slice(0, 16);
}

/** Live runs per plugin, for `abortPluginFanOuts`. */
const liveRuns = new Map<string, Set<AbortController>>();

function trackRun(pluginId: string, controller: AbortController): void {
  let set = liveRuns.get(pluginId);
  if (!set) {
    set = new Set();
    liveRuns.set(pluginId, set);
  }
  set.add(controller);
}

function untrackRun(pluginId: string, controller: AbortController): void {
  liveRuns.get(pluginId)?.delete(controller);
}

/** Aborts every in-flight fan-out run for a plugin. Called on unmount. */
export function abortPluginFanOuts(pluginId: string): void {
  const set = liveRuns.get(pluginId);
  if (!set) return;
  for (const controller of set) controller.abort();
  liveRuns.delete(pluginId);
}

/** Resolves the run + item source, per `FanOutSource`. Always leaves the run
 *  in a state where `pendingFanOutItems` reflects what needs to run. */
async function resolveRun<T>(
  pluginId: string,
  spec: FanOutSpec<T>,
  keyFor: (item: T) => string,
): Promise<FanOutRunRecord> {
  const source = spec.source;

  if ('resume' in source) {
    const run = getFanOutRun(source.resume);
    if (!run) throw new Error(`fanout.run: no run "${source.resume}" to resume`);
    if (run.pluginId !== pluginId) {
      throw new Error(
        `fanout.run: run "${source.resume}" belongs to a different plugin; a plugin may only redrive its own runs`,
      );
    }
    resetDeadFanOutItems(run.id);
    setFanOutRunStatus(run.id, 'running');
    return run;
  }

  if (typeof spec.name !== 'string' || spec.name.trim().length === 0) {
    throw new Error('fanout.run: spec.name is required unless resuming a run');
  }
  const qualifiedName = qualify(pluginId, spec.name);

  let items: readonly T[];
  if ('items' in source) {
    items = source.items;
  } else {
    if (!collectionResolver) {
      throw new Error(
        'fanout.run: collection sources need ctx.collections (SHR-275), which has not landed yet — pass { items } in the meantime',
      );
    }
    items = (await collectionResolver(pluginId, source.collection, source.query)) as T[];
  }

  const run = createFanOutRun(pluginId, qualifiedName);
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(keyFor(item), item);
  upsertFanOutItems(
    run.id,
    Array.from(byKey, ([key, item]) => ({ key, item })),
  );
  return run;
}

function summarize(run: FanOutRunRecord, status: FanOutRunState): FanOutRunSummary {
  const counts = countFanOutItems(run.id);
  return {
    runId: run.id,
    name: run.name,
    status,
    total: run.total,
    succeeded: counts.done,
    dead: counts.dead,
    pending: counts.pending + counts.running,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

/** Aborts early when `signal` fires instead of sleeping the full duration. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createFanOutApi(pluginId: string): FanOutApi {
  async function run<T = unknown, R = unknown>(spec: FanOutSpec<T, R>): Promise<FanOutRunSummary> {
    if (typeof spec.each !== 'function') {
      throw new Error('fanout.run: spec.each must be a function');
    }
    const source: FanOutSource<T> | undefined = spec.source;
    if (!source || !('items' in source || 'collection' in source || 'resume' in source)) {
      throw new Error('fanout.run: spec.source must be { items }, { collection }, or { resume }');
    }

    const keyFor: (item: T) => string = spec.key
      ? (item: T) => {
          const key = spec.key!(item);
          if (typeof key !== 'string' || key.length === 0) {
            throw new Error('fanout.run: spec.key must return a non-empty string');
          }
          return key;
        }
      : defaultKeyFor;

    const runRecord = await resolveRun(pluginId, spec, keyFor);
    resetRunningFanOutItems(runRecord.id);
    const total = listFanOutItems(runRecord.id).length;
    setFanOutRunTotal(runRecord.id, total);

    const hostLimit = Math.max(
      1,
      (await getSettings()).fanout?.maxConcurrency ?? DEFAULT_FANOUT_CONCURRENCY,
    );
    hostSemaphore.setLimit(hostLimit);
    const concurrency = clamp(spec.concurrency ?? hostLimit, 1, hostLimit);
    const maxAttempts = Math.max(1, spec.maxAttempts ?? 3);
    const backoffMs = spec.backoffMs ?? 1000;

    const controller = new AbortController();
    const signal = controller.signal;
    trackRun(pluginId, controller);

    const startedAt = Date.now();
    logger.info(
      {
        plugin_id: pluginId,
        run_id: runRecord.id,
        name: runRecord.name,
        total,
        concurrency,
        host_limit: hostLimit,
      },
      'fanout run starting',
    );

    async function runItem(record: FanOutItemRecord): Promise<void> {
      let attempt = record.attempts + 1;
      for (;;) {
        if (signal.aborted) return;
        await hostSemaphore.acquire();
        try {
          if (signal.aborted) return;
          setFanOutItemStatus(runRecord.id, record.key, { status: 'running', attempts: attempt });
          try {
            const result = await spec.each(record.item as T, {
              runId: runRecord.id,
              key: record.key,
              attempt,
              signal,
            });
            if (signal.aborted) return;
            setFanOutItemStatus(runRecord.id, record.key, {
              status: 'done',
              attempts: attempt,
              result,
              error: null,
            });
            return;
          } catch (err) {
            if (signal.aborted) return;
            const message = err instanceof Error ? err.message : String(err);
            if (attempt >= maxAttempts) {
              logger.warn(
                {
                  plugin_id: pluginId,
                  run_id: runRecord.id,
                  key: record.key,
                  attempt,
                  err: message,
                },
                'fanout item dead-lettered',
              );
              setFanOutItemStatus(runRecord.id, record.key, {
                status: 'dead',
                attempts: attempt,
                error: message,
              });
              return;
            }
            setFanOutItemStatus(runRecord.id, record.key, {
              status: 'pending',
              attempts: attempt,
              error: message,
            });
          }
        } finally {
          hostSemaphore.release();
        }

        if (signal.aborted) return;
        await abortableSleep(backoffMs * 2 ** (attempt - 1), signal);
        attempt += 1;
      }
    }

    const queue = pendingFanOutItems(runRecord.id);
    let cursor = 0;
    async function worker(): Promise<void> {
      for (;;) {
        if (signal.aborted) return;
        const record = queue[cursor];
        if (!record) return;
        cursor += 1;
        await runItem(record).catch((err) => {
          logger.warn(
            { plugin_id: pluginId, run_id: runRecord.id, key: record.key, err },
            'fanout item worker threw unexpectedly',
          );
        });
      }
    }

    const workerCount = Math.min(concurrency, Math.max(queue.length, 1));
    // Fire the pool, but do NOT await it directly — on abort, `run()` must
    // resolve without waiting for whatever `each()` call is currently
    // in-flight (it may be a five-minute agent session). `.catch(() => {})`
    // keeps the still-running pool from producing an unhandled rejection;
    // late results are discarded by the `signal.aborted` guards in `runItem`.
    const poolDone = Promise.all(Array.from({ length: workerCount }, () => worker())).catch(
      () => {},
    );
    const aborted = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    await Promise.race([poolDone, aborted]);

    untrackRun(pluginId, controller);

    let finalStatus: FanOutRunState;
    if (signal.aborted) {
      resetRunningFanOutItems(runRecord.id);
      finalStatus = 'canceled';
    } else {
      const counts = countFanOutItems(runRecord.id);
      finalStatus = counts.dead > 0 ? 'failed' : 'done';
    }
    setFanOutRunStatus(runRecord.id, finalStatus);

    const finished = getFanOutRun(runRecord.id) ?? runRecord;
    const summary = summarize(finished, finalStatus);
    logger.info(
      {
        plugin_id: pluginId,
        run_id: runRecord.id,
        status: finalStatus,
        succeeded: summary.succeeded,
        dead: summary.dead,
        pending: summary.pending,
        duration_ms: Date.now() - startedAt,
      },
      'fanout run finished',
    );
    return summary;
  }

  async function status(runId: string): Promise<FanOutRunStatus | undefined> {
    const record = getFanOutRun(runId);
    if (!record || record.pluginId !== pluginId) return undefined;
    const items: FanOutItemStatus[] = listFanOutItems(runId).map((item) => ({
      key: item.key,
      status: item.status,
      attempts: item.attempts,
      item: item.item,
      ...(item.result !== undefined ? { result: item.result } : {}),
      ...(item.error !== undefined ? { error: item.error } : {}),
      updatedAt: item.updatedAt,
    }));
    return { ...summarize(record, record.status), items };
  }

  async function list(name?: string): Promise<FanOutRunSummary[]> {
    const qualifiedName = name !== undefined ? qualify(pluginId, name) : undefined;
    const runs = listFanOutRuns({ pluginId, name: qualifiedName });
    return runs.map((r) => summarize(r, r.status));
  }

  return { run, status, list };
}

/** Test-only: clears in-memory run tracking and the collection resolver. */
export function resetFanOutState(): void {
  for (const set of liveRuns.values()) {
    for (const controller of set) controller.abort();
  }
  liveRuns.clear();
  collectionResolver = undefined;
  hostSemaphore.reset(DEFAULT_FANOUT_CONCURRENCY);
}
