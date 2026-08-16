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
import type { Harness } from './types.js';

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
    syncAgents: async () => {},
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

  it('a core id cannot be redefined after freeze', () => {
    resetHarnesses();
    registerHarness(claudeCodeHarness);
    registerHarness(cursorHarness);
    freezeCoreHarnesses();

    registerHarness(fakeHarness('claude-code'));

    expect(getHarness('claude-code')).toBe(claudeCodeHarness);
  });

  it('freeze refuses a core id even if it was never registered', () => {
    resetHarnesses();
    freezeCoreHarnesses();

    registerHarness(fakeHarness('claude-code'));

    expect(() => getHarness('claude-code')).toThrow(/Unknown harness/);
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

    registerHarness(fakeHarness('claude-code'));

    expect(getHarness('claude-code')).toBe(claudeCodeHarness);
  });
});
