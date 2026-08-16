import { describe, it, expect, afterEach } from '../bun-test.js';
import {
  getHarness,
  listHarnesses,
  registerHarness,
  resetHarnesses,
  freezeCoreHarnesses,
  DEFAULT_HARNESS_ID,
  CORE_HARNESS_IDS,
  claudeCodeHarness,
  cursorHarness,
} from './index.js';
import { getLogger, setLogger } from '../logger.js';
import pino from 'pino';
import type { Harness } from './types.js';

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

describe('registry', () => {
  it('returns claude-code by id', () => {
    const h = getHarness('claude-code');
    expect(h.id).toBe('claude-code');
  });

  it('returns the default when id is null/undefined', () => {
    expect(getHarness(null).id).toBe(DEFAULT_HARNESS_ID);
    expect(getHarness(undefined).id).toBe(DEFAULT_HARNESS_ID);
  });

  it('throws on unknown id', () => {
    expect(() => getHarness('nonexistent')).toThrow(/Unknown harness/);
  });

  it('returns cursor by id', () => {
    const h = getHarness('cursor');
    expect(h.id).toBe('cursor');
    expect(h.sessionIdMode).toBe('harness-issued');
  });

  it('lists registered harnesses', () => {
    const ids = listHarnesses().map((h) => h.id);
    expect(ids).toContain('claude-code');
    expect(ids).toContain('cursor');
  });
});

/** Minimal stand-in Harness for guard tests — none of its methods are exercised. */
function fakeHarness(id: string): Harness {
  return {
    id,
    displayName: id,
    sessionIdMode: 'orchestrator-assigned',
    newSessionId: () => 'x',
    buildLaunchCommand: () => '',
    buildResumeCommand: () => '',
    buildContinueCommand: () => null,
    installHooks: async () => {},
    uninstallHooks: async () => {},
    resolveFlags: () => '',
    validateSettings: () => ({}),
    validateAgentName: (name: string) => name,
  };
}

describe('registry guards', () => {
  // Every test here mutates module-level registry state. Put it back the way
  // boot leaves it so tests outside this block (and later ones in it) still
  // see a normal, usable registry regardless of run order.
  afterEach(() => {
    resetHarnesses();
    registerHarness(claudeCodeHarness);
    registerHarness(cursorHarness);
    freezeCoreHarnesses();
  });

  it('CORE_HARNESS_IDS names the shipped harnesses', () => {
    expect(CORE_HARNESS_IDS).toContain('claude-code');
    expect(CORE_HARNESS_IDS).toContain('cursor');
  });

  it('duplicate registration warns and keeps the first', () => {
    resetHarnesses();
    const first = fakeHarness('dup-test');
    const second = fakeHarness('dup-test');
    registerHarness(first);
    registerHarness(second);
    expect(getHarness('dup-test')).toBe(first);
  });

  it('a core id cannot be redefined after freeze — via the specific freeze diagnostic, not the generic duplicate one', () => {
    resetHarnesses();
    registerHarness(claudeCodeHarness);
    registerHarness(cursorHarness);
    freezeCoreHarnesses();

    // The real boot scenario: a post-boot plugin tries to hijack an already-
    // registered core id. Both guards could technically catch this (it's a
    // duplicate AND a frozen core id) — assert the specific freeze message
    // fired, not the generic "already registered" one. This is what pinned
    // the bug: the duplicate check ran first and always won, so the freeze
    // diagnostic never appeared for exactly this case.
    const lines = withCapturedLogs(() => {
      registerHarness(fakeHarness('claude-code'));
    });

    expect(getHarness('claude-code')).toBe(claudeCodeHarness);
    const freezeLine = lines.find(
      (l) => l.msg === 'refusing to redefine core harness after freeze',
    );
    expect(freezeLine).toBeDefined();
    expect(freezeLine!.harness_id).toBe('claude-code');
    const dupLine = lines.find(
      (l) => l.msg === 'harness already registered, keeping first registration',
    );
    expect(dupLine).toBeUndefined();
  });

  it('freeze refuses a core id even if it was never registered', () => {
    resetHarnesses();
    freezeCoreHarnesses();

    // Simulates a core module that failed to import at boot (e.g. cursor.ts
    // throws): the id is absent from the map, so the duplicate check alone
    // would let a plugin claim it. Only the freeze branch stops this.
    const lines = withCapturedLogs(() => {
      registerHarness(fakeHarness('claude-code'));
    });

    expect(() => getHarness('claude-code')).toThrow(/Unknown harness/);
    const freezeLine = lines.find(
      (l) => l.msg === 'refusing to redefine core harness after freeze',
    );
    expect(freezeLine).toBeDefined();
    expect(freezeLine!.harness_id).toBe('claude-code');
  });

  it('resetHarnesses restores a usable, unfrozen registry', () => {
    resetHarnesses();
    registerHarness(claudeCodeHarness);
    freezeCoreHarnesses();

    resetHarnesses();

    expect(() => getHarness('claude-code')).toThrow(/Unknown harness/);
    registerHarness(claudeCodeHarness);
    expect(getHarness('claude-code')).toBe(claudeCodeHarness);
  });

  it('freeze is idempotent', () => {
    resetHarnesses();
    registerHarness(claudeCodeHarness);
    freezeCoreHarnesses();
    freezeCoreHarnesses();

    const lines = withCapturedLogs(() => {
      registerHarness(fakeHarness('claude-code'));
    });

    expect(getHarness('claude-code')).toBe(claudeCodeHarness);
    const freezeLine = lines.find(
      (l) => l.msg === 'refusing to redefine core harness after freeze',
    );
    expect(freezeLine).toBeDefined();
  });
});
