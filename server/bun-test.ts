/**
 * Vitest-shaped surface over `bun:test`, for the server suite.
 *
 * Server tests run under `bun test`, not vitest: they exercise `bun:sqlite` and
 * `Bun.Terminal`, which don't exist in Node, and vitest's `vi.mock` interception
 * doesn't work when vitest itself runs on the Bun runtime. `bun:test` mocks
 * natively, so the tests keep their vitest shape and only swap this import.
 *
 * Frontend (`src/`), `cli/`, and `packages/` tests still run on vitest under
 * Node — they touch no Bun APIs.
 *
 * Usage — replace `from 'vitest'` with this module:
 *
 *   import { describe, it, expect, vi } from './bun-test.js';
 *
 * Known gap vs vitest: `vi.mock()` maps to `mock.module()`, which does NOT hoist.
 * Declare mocks before `await import()`ing the module under test — a static
 * `import` of it evaluates first and captures the unmocked original.
 */

import {
  mock,
  jest,
  expect as bunExpect,
  afterEach as bunAfterEach,
  it as bunIt,
  test as bunTest,
  type Mock,
} from 'bun:test';

/**
 * `it`/`test` with vitest's `.each` typing: one table row per callback argument.
 *
 * bun types `.each` around array-of-arrays spreading, which infers `unknown`
 * for the object tables this suite uses throughout. Runtime behaviour is bun's
 * and unchanged — this only fixes what TypeScript infers for the row.
 */
type EachRunner = <T>(
  table: readonly T[],
) => (name: string, fn: (row: T) => unknown, timeout?: number) => void;

type VitestIt = typeof bunIt & { each: EachRunner };

export const it = bunIt as unknown as VitestIt;
export const test = bunTest as unknown as VitestIt;
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Snapshots of the node builtins this module uses.
 *
 * ESM imports are live bindings, so a test doing `vi.mock('fs')` would replace
 * the shim's own `readFileSync` too — and then export scanning silently returns
 * nothing, so partial mocks stop getting their missing exports filled. Copying
 * the values at module init (before any vi.mock can run) pins the real ones.
 */
const realReadFileSync = readFileSync;
const realCreateRequire = createRequire;

/**
 * A `require` rooted at the *calling test file*, not at this module.
 *
 * `vi.mock('./foo.js')` means "./foo.js relative to the test". bun's
 * `mock.module` resolves it that way; a bare `require()` in here would resolve
 * against `server/`, silently missing (or worse, finding the wrong) module.
 */
function callerFile(): string {
  for (const frame of (new Error().stack ?? '').split('\n').slice(1)) {
    const file = frame.match(/\(?(\/[^():]+\.(?:ts|tsx|js|mjs))[:)]/)?.[1];
    if (file && !file.endsWith('/bun-test.ts')) return file;
  }
  return fileURLToPath(import.meta.url);
}

/**
 * Resolve a specifier the way the test file's own `import` would.
 *
 * `Bun.resolveSync` first: `require.resolve` uses the `require` export
 * condition, which ESM-only workspace packages (`@octomux/*`) don't declare, so
 * it fails on them.
 */
function resolveFrom(specifier: string, from: string): string {
  try {
    return Bun.resolveSync(specifier, path.dirname(from));
  } catch {
    try {
      return realCreateRequire(from).resolve(specifier);
    } catch {
      return specifier;
    }
  }
}

/**
 * The names a module exports, read from its source without executing it.
 *
 * Needed because bun's ESM is statically checked: importing an export a mock
 * factory didn't define is a hard SyntaxError, where vitest just yielded
 * undefined. We fill those gaps with no-op mocks — but we must not `require()`
 * the real module to discover them, since evaluating it fires exactly the
 * module-level side effects (servers, pollers, timers) the mock exists to avoid.
 */
function exportNamesOf(file: string): string[] {
  const candidates = [file, file.replace(/\.js$/, '.ts'), file.replace(/\.js$/, '.tsx')];
  for (const candidate of candidates) {
    try {
      const source = realReadFileSync(candidate, 'utf8');
      const loader = candidate.endsWith('.tsx') ? 'tsx' : candidate.endsWith('.ts') ? 'ts' : 'js';
      return new Bun.Transpiler({ loader }).scan(source).exports;
    } catch {
      continue;
    }
  }
  return [];
}

// ─── Auto-restore real timers ─────────────────────────────────────────────────
// vitest resets the timer environment between files; bun does not. Left
// installed, fake timers also fake bun's own per-test timeout timer, so a test
// that never settles hangs the whole file forever instead of failing. Restoring
// after each test keeps a missing `vi.useRealTimers()` from being fatal.
bunAfterEach(() => {
  if (jest.isFakeTimers()) jest.useRealTimers();
});

// ─── Matchers vitest has and bun:test doesn't ─────────────────────────────────

bunExpect.extend({
  toHaveBeenCalledOnce(received: unknown) {
    const calls = (received as Mock<(...args: never[]) => unknown>).mock?.calls?.length ?? 0;
    return {
      pass: calls === 1,
      message: () => `expected mock to have been called once, but it was called ${calls} times`,
    };
  },
});

declare module 'bun:test' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- must mirror bun's Matchers<T> to merge
  interface Matchers<T = unknown> {
    toHaveBeenCalledOnce(): void;
    /**
     * bun binds `toEqual`'s argument to the received type; vitest's accepts
     * anything. Keep the looser signature so structural comparisons against a
     * literal (a plain `{ id }` vs a full `Task`) still type-check.
     */
    toEqual(expected: unknown): void;
    toMatchObject(expected: unknown): void;
    toStrictEqual(expected: unknown): void;
    toBe(expected: unknown): void;
    toContain(expected: unknown): void;
  }
}

export {
  describe,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  spyOn,
  mock,
  jest,
} from 'bun:test';

/**
 * vitest's `Mocked<T>` — recursive, so `vi.mocked(fs.promises).readFile` carries
 * the mock methods too, not just the top-level value.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- mirrors vitest's own loose Mocked<T> */
type Mocked<T> = T extends (...args: any[]) => any
  ? T & Mock<(...args: any[]) => any>
  : T extends object
    ? { [K in keyof T]: Mocked<T[K]> }
    : T;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── Global / env stubbing ────────────────────────────────────────────────────
// bun:test has no stubGlobal/stubEnv; track originals so they can be restored.

/**
 * Real modules captured before `mock.module()` replaced them.
 *
 * A factory that calls `importOriginal()`/`vi.importActual()` for the module it
 * is mocking would otherwise re-enter the half-built mock. We only take the
 * snapshot when the factory actually asks — evaluating a local module has side
 * effects, which is exactly what mocking is meant to avoid.
 */
const preMockSnapshots = new Map<string, Record<string, unknown>>();

/**
 * The mocked epoch set via `vi.setSystemTime`.
 *
 * bun's `advanceTimersByTime` resets the clock installed by `setSystemTime`
 * *while* it fires callbacks, so a timer that reads `Date.now()` sees real time
 * mid-advance. Owning `Date.now` here keeps it consistent throughout — the
 * closure reads this variable, so bumping it before an advance is enough.
 */
let fakeNow: number | null = null;
const realDateNow = Date.now;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

/** Ticker backing vitest's `shouldAdvanceTime` option, which bun has no equivalent for. */
let autoAdvance: ReturnType<typeof setInterval> | null = null;

const stubbedGlobals = new Map<string, unknown>();
const stubbedEnv = new Map<string, string | undefined>();

/**
 * Mocks created through `vi.fn(impl)`, with the implementation they started with.
 *
 * vitest's `mockReset()`/`restoreAllMocks()` put back the implementation passed
 * to `vi.fn(impl)`; bun's clear it entirely. Tests that define mocks in a
 * `vi.mock` factory and call `vi.restoreAllMocks()` in `beforeEach` would
 * otherwise find them dead from the second test onwards.
 */
const initialImpls = new Map<object, ((...args: never[]) => unknown) | undefined>();

function restoreInitialImpls(): void {
  for (const [mocked, impl] of initialImpls) {
    const m = mocked as Mock<(...args: never[]) => unknown>;
    m.mockReset();
    if (impl) m.mockImplementation(impl);
  }
}

export const vi = {
  ...jest,

  fn: ((impl?: (...args: never[]) => unknown) => {
    const m = impl ? jest.fn(impl) : jest.fn();
    initialImpls.set(m as unknown as object, impl);
    return m;
  }) as typeof jest.fn,

  spyOn: jest.spyOn,

  /**
   * `shouldAdvanceTime` has no bun equivalent, so drive the fake clock from a
   * real interval. Only when a test asks for it — auto-advancing everywhere
   * would break tests that assert a timer has *not* fired yet.
   */
  useFakeTimers: (options?: {
    now?: number | Date;
    shouldAdvanceTime?: boolean;
    advanceTimeDelta?: number;
  }): void => {
    const { now, shouldAdvanceTime, advanceTimeDelta = 20 } = options ?? {};
    jest.useFakeTimers(now === undefined ? undefined : { now });
    if (now !== undefined) vi.setSystemTime(now);
    if (autoAdvance) realClearInterval(autoAdvance);
    autoAdvance = shouldAdvanceTime
      ? realSetInterval(() => vi.advanceTimersByTime(advanceTimeDelta), advanceTimeDelta)
      : null;
  },

  useRealTimers: (): void => {
    if (autoAdvance) realClearInterval(autoAdvance);
    autoAdvance = null;
    fakeNow = null;
    Date.now = realDateNow;
    jest.useRealTimers();
  },

  restoreAllMocks: (): void => {
    jest.restoreAllMocks();
    restoreInitialImpls();
  },

  resetAllMocks: (): void => {
    jest.resetAllMocks();
    restoreInitialImpls();
  },

  /**
   * vitest's `vi.mock(path, factory)` → bun's `mock.module`. Does not hoist.
   *
   * vitest hands the factory an `importOriginal()` helper for partial mocks;
   * bun calls it with no arguments. We snapshot the real module *before*
   * registering the mock (afterwards, importing it would return the mock) and
   * hand that snapshot to the factory.
   */
  mock(specifier: string, factory?: (importOriginal: <T>() => T) => unknown): void {
    // `require`, not `import`: tests call vi.mock() without awaiting it, and an
    // async mock.module factory deadlocks a synchronous import of the mocked
    // module. Resolving the original synchronously keeps the factory sync too.
    //
    // It can still legitimately fail — modules with top-level await can't be
    // require()d. Then we skip the auto-mock fill and run the bare factory.
    // bun resolves mock.module()'s specifier against whoever called it — which
    // is this wrapper, not the test. Resolve relative specifiers to absolute
    // paths from the test's own location so they name the intended module.
    const from = callerFile();
    const req = realCreateRequire(from);
    const resolved = resolveFrom(specifier, from);

    // Only relative specifiers need rewriting — they'd otherwise resolve against
    // this file. Bare package names are unambiguous, and registering one under
    // its resolved dist path deadlocks bun's module registry.
    const mockKey = specifier.startsWith('.') ? resolved : specifier;

    // A node builtin is cheap and side-effect-free to require, and it must be
    // captured NOW — after mock.module registers, requiring it returns the mock
    // and re-enters the factory being built. Everything else is read from disk
    // instead: requiring a real package here both evaluates its side effects and
    // can deadlock on ESM with top-level await.
    const isNodeBuiltin = !resolved.startsWith('/');
    let builtin: Record<string, unknown> | null = null;
    if (isNodeBuiltin) {
      try {
        builtin = req(resolved) as Record<string, unknown>;
      } catch {
        builtin = null;
      }
    }

    // Snapshot the real module only when the factory asks for *this* module —
    // via the importOriginal parameter, or a vi.importActual naming this same
    // specifier. A factory that importActuals something else (a mock of
    // ./task-engine that pulls getDb from ./db.js, say) must not drag the whole
    // module graph in early: doing so evaluates modules that capture
    // `promisify(execFile)` before a later vi.mock('child_process') registers.
    const factorySource = factory ? factory.toString() : '';
    const wantsOriginal =
      !!factory &&
      (factory.length > 0 ||
        (factorySource.includes('importActual') && factorySource.includes(specifier)));
    if (wantsOriginal && !builtin) {
      try {
        // Shallow-copy: require() hands back a *live* ESM namespace, so once
        // mock.module replaces the module the snapshot's own bindings would flip
        // to the mock — and a factory doing `actual.getHarness(id)` would call
        // itself. Copying pins the real implementations.
        const original = { ...(req(resolved) as Record<string, unknown>) };
        // Keyed by both forms: a factory calling vi.importActual() for the module
        // it is mocking resolves the specifier from a different caller frame, and
        // a miss here would fall through to require() — which returns the
        // half-built mock.
        preMockSnapshots.set(resolved, original);
        preMockSnapshots.set(specifier, original);
      } catch {
        /* unresolvable or top-level-await module — factory copes without it */
      }
    }

    /** The real module, for factories that asked via importOriginal. */
    const loadOriginal = (): Record<string, unknown> | null =>
      builtin ?? preMockSnapshots.get(resolved) ?? null;

    /**
     * Placeholders for exports a partial factory didn't define.
     *
     * bun's ESM is statically checked, so importing an export the mock omits is
     * a hard SyntaxError; vitest simply yielded `undefined`. Declaring them as
     * `undefined` reproduces vitest exactly — a test that never touched them
     * still passes, and one that calls them fails the same way it would have.
     */
    const autoMock = (): Record<string, unknown> => {
      const names = isNodeBuiltin ? Object.keys(builtin ?? {}) : exportNamesOf(resolved);
      const auto: Record<string, unknown> = {};
      for (const name of names) auto[name] = undefined;
      return auto;
    };

    if (!factory) {
      // vitest auto-mocks when no factory is given: every export becomes a spy
      // (not `undefined` — tests then drive them with mockReturnValue &c.).
      // bun has no automock, so synthesise one.
      const names = isNodeBuiltin ? Object.keys(builtin ?? {}) : exportNamesOf(resolved);
      const auto: Record<string, unknown> = {};
      for (const name of names) auto[name] = jest.fn();
      // CJS/builtin interop: `import os from 'os'` needs a default, and it must
      // be the same object so named and default access share one mock each.
      if (!('default' in auto)) auto.default = auto;
      mock.module(mockKey, () => auto);
      return;
    }

    /**
     * bun's ESM is statically checked: importing an export the mock doesn't
     * define is a hard SyntaxError, where vitest just yielded undefined. Fill
     * the gaps with auto-mocks so partial factories keep working — mocks, not
     * the real implementations, so nothing unexpectedly shells out.
     */
    const fill = (result: unknown): unknown => {
      if (typeof result !== 'object' || result === null) return result;
      const merged = { ...autoMock(), ...(result as Record<string, unknown>) };
      if (!('default' in merged)) merged.default = merged;
      return merged;
    };

    if (factory.length === 0) {
      const f = factory as () => unknown;
      mock.module(mockKey, () => {
        const result = f();
        return result instanceof Promise ? result.then(fill) : fill(result);
      });
      return;
    }

    mock.module(mockKey, () => {
      const result = factory(() => loadOriginal() as never);
      return result instanceof Promise ? result.then(fill) : fill(result);
    });
  },

  /**
   * Identity. A module mocked via `mock.module` yields real mock functions on
   * import, so the binding already carries `.mockReturnValue` &c. `vi.mocked()`
   * exists only to re-type it for TypeScript.
   */
  mocked: <T>(value: T): Mocked<T> => value as Mocked<T>,

  /** vitest runs the callback eagerly and returns its value; no hoisting here. */
  hoisted: <T>(factory: () => T): T => factory(),

  /**
   * No-op. vitest resets its module registry so the next import re-evaluates;
   * bun has no equivalent. Tests that truly need a fresh module graph must use
   * a distinct import specifier instead.
   */
  resetModules: (): void => {},

  /**
   * Synchronous, unlike vitest's promise-returning version — `await` on a plain
   * value is harmless, and a mock factory that must stay synchronous (bun
   * deadlocks on an async one) can then use it directly.
   */
  importActual: <T>(specifier: string): T => {
    const from = callerFile();
    const req = realCreateRequire(from);
    const resolved = resolveFrom(specifier, from);

    // Prefer the pre-mock snapshot: requiring a module that vi.mock() already
    // replaced would hand back the mock (or re-enter the factory building it).
    return (preMockSnapshots.get(specifier) ??
      preMockSnapshots.get(resolved) ??
      req(resolved)) as T;
  },

  stubGlobal(name: string, value: unknown): void {
    if (!stubbedGlobals.has(name)) {
      stubbedGlobals.set(name, (globalThis as Record<string, unknown>)[name]);
    }
    (globalThis as Record<string, unknown>)[name] = value;
  },

  unstubAllGlobals(): void {
    for (const [name, original] of stubbedGlobals) {
      (globalThis as Record<string, unknown>)[name] = original;
    }
    stubbedGlobals.clear();
  },

  stubEnv(name: string, value: string): void {
    if (!stubbedEnv.has(name)) stubbedEnv.set(name, process.env[name]);
    process.env[name] = value;
  },

  unstubAllEnvs(): void {
    for (const [name, original] of stubbedEnv) {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    stubbedEnv.clear();
  },

  /**
   * Keep the mocked system clock in step with fake-timer advancement.
   *
   * vitest advances `Date.now()` along with its timers; bun's
   * `advanceTimersByTime` drops the clock set by `setSystemTime` back to real
   * time, so anything rendering an elapsed duration jumps to "now".
   */
  setSystemTime: (time?: Date | number): void => {
    fakeNow = time === undefined ? null : time instanceof Date ? time.getTime() : time;
    jest.setSystemTime(time as Date);
    Date.now = fakeNow === null ? realDateNow : () => fakeNow as number;
  },

  advanceTimersByTime: (ms: number): void => {
    if (fakeNow !== null) fakeNow += ms;
    jest.advanceTimersByTime(ms);
    if (fakeNow !== null) jest.setSystemTime(new Date(fakeNow));
  },

  /**
   * Fake-timer helpers vitest exposes in async form; bun's are synchronous.
   *
   * Advance in small steps, draining microtasks between each. Code under test
   * typically chains `await something` → `setTimeout` → `await` → `setTimeout`,
   * so a single jump fires only the timers that existed at the start; the next
   * one is scheduled afterwards and never runs. Since fake timers also fake
   * bun's own per-test timeout, that stalls the test forever instead of failing.
   */
  advanceTimersByTimeAsync: async (ms: number): Promise<void> => {
    const step = 10;
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      for (let i = 0; i < 5; i++) await Promise.resolve();
      vi.advanceTimersByTime(Math.min(step, ms - elapsed));
    }
    for (let i = 0; i < 10; i++) await Promise.resolve();
  },

  runAllTimersAsync: async (): Promise<void> => {
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 5; i++) await Promise.resolve();
      if (jest.getTimerCount() === 0) break;
      jest.runOnlyPendingTimers();
    }
    for (let i = 0; i < 10; i++) await Promise.resolve();
  },

  /** Poll `fn` until it stops throwing, mirroring vitest's `vi.waitFor`. */
  async waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 1000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        await Bun.sleep(10);
      }
    }
    throw lastError ?? new Error('vi.waitFor timed out');
  },
};
