import { describe, it, expect, beforeEach, afterEach } from '../bun-test.js';
import {
  getCompute,
  listCompute,
  registerCompute,
  resetCompute,
  freezeCoreCompute,
  unregisterCompute,
  DEFAULT_COMPUTE_KIND,
  CORE_COMPUTE_KINDS,
  localCompute,
} from './index.js';
import { getLogger, setLogger } from '../logger.js';
import pino from 'pino';
import type { ComputeProvider } from './types.js';

/** Collect pino JSON log lines into memory for assertions. */
function bufferStream() {
  const chunks: string[] = [];
  return {
    stream: {
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
    lines(): Array<Record<string, unknown>> {
      return chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
}

/** Run `fn` with the root logger swapped for a buffered one, then restore it. */
function withCapturedLogs(fn: () => void): Array<Record<string, unknown>> {
  const original = getLogger();
  const buf = bufferStream();
  setLogger(pino({ level: 'trace' }, buf.stream));
  try {
    fn();
  } finally {
    setLogger(original);
  }
  return buf.lines();
}

/** Minimal stand-in ComputeProvider for guard tests — none of its methods
 *  are exercised. */
function fakeProvider(kind: string): ComputeProvider {
  return {
    kind,
    create: async () => {
      throw new Error('not implemented');
    },
  };
}

describe('registry', () => {
  // Seed explicitly rather than relying on the barrel's import side effect —
  // another test file in this process may have called resetCompute(), and
  // ESM caches module evaluation so re-importing ./index.js would NOT
  // re-register.
  beforeEach(() => {
    registerCompute(localCompute);
  });

  it('returns local by kind', () => {
    expect(getCompute('local').kind).toBe('local');
  });

  it('returns the default when kind is null/undefined', () => {
    expect(getCompute(null).kind).toBe(DEFAULT_COMPUTE_KIND);
    expect(getCompute(undefined).kind).toBe(DEFAULT_COMPUTE_KIND);
  });

  it('throws on unknown kind', () => {
    expect(() => getCompute('nonexistent')).toThrow(/Unknown compute provider/);
  });

  it('lists registered providers', () => {
    expect(listCompute().map((p) => p.kind)).toContain('local');
  });
});

describe('registry guards', () => {
  // Every test here mutates module-level registry state. Put it back the way
  // boot leaves it so tests outside this block still see a usable registry.
  afterEach(() => {
    resetCompute();
    registerCompute(localCompute);
    freezeCoreCompute();
  });

  it('CORE_COMPUTE_KINDS names the shipped providers', () => {
    expect(CORE_COMPUTE_KINDS).toContain('local');
  });

  it('duplicate registration warns and keeps the first', () => {
    resetCompute();
    const first = fakeProvider('dup-test');
    const second = fakeProvider('dup-test');
    registerCompute(first);
    registerCompute(second);
    expect(getCompute('dup-test')).toBe(first);
  });

  it('a core kind cannot be redefined after freeze — via the specific freeze diagnostic, not the generic duplicate one', () => {
    resetCompute();
    registerCompute(localCompute);
    freezeCoreCompute();

    const lines = withCapturedLogs(() => {
      registerCompute(fakeProvider('local'));
    });

    expect(getCompute('local')).toBe(localCompute);
    const freezeLine = lines.find(
      (l) => l.msg === 'refusing to redefine core compute provider after freeze',
    );
    expect(freezeLine).toBeDefined();
    expect(freezeLine!.compute_kind).toBe('local');
    const dupLine = lines.find(
      (l) => l.msg === 'compute provider already registered, keeping first registration',
    );
    expect(dupLine).toBeUndefined();
  });

  it('freeze refuses a core kind even if it was never registered', () => {
    resetCompute();
    freezeCoreCompute();

    const lines = withCapturedLogs(() => {
      registerCompute(fakeProvider('local'));
    });

    expect(() => getCompute('local')).toThrow(/Unknown compute provider/);
    const freezeLine = lines.find(
      (l) => l.msg === 'refusing to redefine core compute provider after freeze',
    );
    expect(freezeLine).toBeDefined();
  });

  it('resetCompute restores a usable, unfrozen registry', () => {
    resetCompute();
    registerCompute(localCompute);
    freezeCoreCompute();

    resetCompute();

    expect(() => getCompute('local')).toThrow(/Unknown compute provider/);
    registerCompute(localCompute);
    expect(getCompute('local')).toBe(localCompute);
  });

  it('unregisterCompute removes a plugin-registered provider', () => {
    resetCompute();
    registerCompute(localCompute);
    registerCompute(fakeProvider('plugin:demo'));
    expect(unregisterCompute('plugin:demo')).toBe(true);
    expect(() => getCompute('plugin:demo')).toThrow(/Unknown compute provider/);
  });

  it('unregisterCompute returns false for a kind that was never registered', () => {
    resetCompute();
    expect(unregisterCompute('plugin:never-existed')).toBe(false);
  });

  it('unregisterCompute refuses local, even before freeze has run', () => {
    resetCompute();
    registerCompute(localCompute);

    const lines = withCapturedLogs(() => {
      expect(unregisterCompute('local')).toBe(false);
    });

    expect(getCompute('local')).toBe(localCompute);
    const warnLine = lines.find((l) => l.msg === 'refusing to unregister core compute provider');
    expect(warnLine).toBeDefined();
    expect(warnLine!.compute_kind).toBe('local');
  });

  it('freeze is idempotent', () => {
    freezeCoreCompute();
    freezeCoreCompute();
    expect(() => getCompute('local')).not.toThrow();
  });
});
