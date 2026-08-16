import { describe, it, expect, beforeEach, afterEach } from '../bun-test.js';
import {
  registerProvider,
  getProvider,
  listProviders,
  resetProviders,
  freezeCoreProviders,
  CORE_PROVIDER_KINDS,
} from './registry.js';
import './index.js';
import { getLogger, setLogger } from '../logger.js';
import pino from 'pino';
import type { IntegrationProvider } from './types.js';

describe('integrations registry', () => {
  it('registers both jira and linear providers', () => {
    const kinds = listProviders().map((p) => p.kind);
    expect(kinds).toContain('jira');
    expect(kinds).toContain('linear');
  });
});

function fakeProvider(kind: string): IntegrationProvider {
  return {
    kind,
    displayName: kind,
    configSchema: {},
    events: [],
    validate: () => ({ ok: true }),
    handler: async () => {},
  };
}

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

describe('registerProvider guard', () => {
  // index.js's side-effect imports already registered the real core providers
  // before any test in this file runs; snapshot + restore so these tests don't
  // leak state into "registers both jira and linear providers" above or into
  // whichever test happens to run after this block.
  let snapshot: IntegrationProvider[];

  beforeEach(() => {
    snapshot = listProviders();
  });

  afterEach(() => {
    resetProviders();
    for (const p of snapshot) registerProvider(p);
  });

  it('warns and keeps the first registration on a duplicate kind', () => {
    resetProviders();
    const first = fakeProvider('dup-test');
    const second = fakeProvider('dup-test');
    registerProvider(first);

    const original = getLogger();
    const buf = bufferStream();
    setLogger(pino({ level: 'trace' }, buf.stream));
    try {
      registerProvider(second);
    } finally {
      setLogger(original);
    }

    expect(getProvider('dup-test')).toBe(first);
    const warnLine = buf
      .lines()
      .find((l) => l.msg === 'duplicate provider registration ignored, keeping first');
    expect(warnLine).toBeDefined();
    expect(warnLine!.kind).toBe('dup-test');
  });

  it('refuses a plugin registering a core provider kind after freeze', () => {
    resetProviders();
    freezeCoreProviders();
    expect(CORE_PROVIDER_KINDS).toContain('jira');

    const original = getLogger();
    const buf = bufferStream();
    setLogger(pino({ level: 'trace' }, buf.stream));
    try {
      registerProvider(fakeProvider('jira'));
    } finally {
      setLogger(original);
    }

    expect(getProvider('jira')).toBeUndefined();
    const warnLine = buf
      .lines()
      .find((l) => l.msg === 'refusing plugin registration of a reserved core provider kind');
    expect(warnLine).toBeDefined();
    expect(warnLine!.kind).toBe('jira');
  });

  it('refuses a plugin re-registering an already-registered core kind — via the specific freeze diagnostic, not the generic duplicate one', () => {
    // The real boot scenario: jira is already registered (restored from the
    // barrel's real registration by the outer afterEach) and core kinds are
    // frozen, same as `index.js`'s own boot sequence — register, then freeze.
    // A post-boot plugin trying to hijack 'jira' is simultaneously a
    // duplicate AND a frozen core kind — assert the specific freeze message
    // fired, not the generic "duplicate ... ignored" one. This is what
    // pinned the bug: the duplicate check ran first and always won, so the
    // freeze diagnostic never appeared for exactly this case.
    const realJira = getProvider('jira');
    expect(realJira).toBeDefined();
    freezeCoreProviders();

    const original = getLogger();
    const buf = bufferStream();
    setLogger(pino({ level: 'trace' }, buf.stream));
    try {
      registerProvider(fakeProvider('jira'));
    } finally {
      setLogger(original);
    }

    expect(getProvider('jira')).toBe(realJira);
    const freezeLine = buf
      .lines()
      .find((l) => l.msg === 'refusing plugin registration of a reserved core provider kind');
    expect(freezeLine).toBeDefined();
    expect(freezeLine!.kind).toBe('jira');
    const dupLine = buf
      .lines()
      .find((l) => l.msg === 'duplicate provider registration ignored, keeping first');
    expect(dupLine).toBeUndefined();
  });

  it('resetProviders clears the map and unfreezes core', () => {
    resetProviders();
    registerProvider(fakeProvider('temp'));
    expect(getProvider('temp')).toBeDefined();

    resetProviders();
    expect(getProvider('temp')).toBeUndefined();
    expect(listProviders()).toEqual([]);

    // unfrozen: a core-shaped kind can register fresh again post-reset
    registerProvider(fakeProvider('jira'));
    expect(getProvider('jira')).toBeDefined();
  });
});
