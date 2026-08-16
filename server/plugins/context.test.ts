import { describe, it, expect, beforeEach, vi } from '../bun-test.js';
import type { Harness } from '../harnesses/types.js';

// In-memory stand-in for settings.json. `undefined` == "file doesn't exist yet"
// (ENOENT), matching getSettings()'s own default-on-missing-file behavior.
// Declared before vi.mock() so the closures below can read/write it.
let fileContent: string | undefined;

vi.mock('fs', (importOriginal) => {
  const actual = importOriginal<typeof import('fs')>();
  const promises = {
    ...actual.promises,
    readFile: vi.fn(async () => {
      if (fileContent === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return fileContent;
    }),
    writeFile: vi.fn(async (_path: string, data: string) => {
      fileContent = data;
    }),
    mkdir: vi.fn(async () => undefined),
  };
  return { ...actual, default: { ...actual, promises }, promises };
});

// settings.ts dynamically imports this for harness-blob validation on every
// getSettings()/updateSettings() call. Plugin settings never touch it, so an
// empty registry is enough — this just keeps the real settings.ts from
// exploding on the `await import('./harnesses/index.js')` inside it.
vi.mock('../harnesses/index.js', () => ({
  listHarnesses: vi.fn(() => []),
  getHarness: vi.fn(() => {
    throw new Error('unexpected getHarness call in context.test.ts');
  }),
}));

// context.ts imports settings.js and harnesses/index.js statically — both
// mocks above must be registered before it (or the real one it evaluated)
// gets pulled in. bun's mock.module doesn't hoist, so this must be a dynamic
// import, not a static one at the top of the file.
const { createPluginContext } = await import('./context.js');
const { qualify } = await import('./qualify.js');
const { getLogger, setLogger } = await import('../logger.js');
const { default: pino } = await import('pino');
const { registerWorkflow, getWorkflow } = await import('../workflows/registry.js');
const { registerProvider, getProvider, resetProviders, freezeCoreProviders } =
  await import('../integrations/registry.js');
const { registerHarness, getHarness, listHarnesses, resetHarnesses, freezeCoreHarnesses } =
  await import('../harnesses/registry.js');

/** Pipe pino output into an in-memory buffer of parsed JSON lines. */
function captureLogs() {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string) {
      chunks.push(chunk);
    },
  };
  const original = getLogger();
  setLogger(pino({ level: 'trace' }, stream));
  return {
    lines: (): Array<Record<string, unknown>> =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    restore: () => setLogger(original),
  };
}

beforeEach(() => {
  fileContent = undefined;
  resetProviders();
  resetHarnesses();
});

describe('ctx.logger', () => {
  it('is bound to plugin:<id>, not the raw module logger', () => {
    const logs = captureLogs();
    try {
      const ctx = createPluginContext('demo-plugin');
      ctx.logger.info({ foo: 'bar' }, 'hello from plugin');
    } finally {
      logs.restore();
    }
    const line = logs.lines().find((l) => l.msg === 'hello from plugin');
    expect(line?.module).toBe('plugin:demo-plugin');
    expect(line?.foo).toBe('bar');
  });

  it('exposes no other logging path (only debug/info/warn/error)', () => {
    const ctx = createPluginContext('demo-plugin');
    expect(typeof ctx.logger.debug).toBe('function');
    expect(typeof ctx.logger.info).toBe('function');
    expect(typeof ctx.logger.warn).toBe('function');
    expect(typeof ctx.logger.error).toBe('function');
  });
});

describe('ctx.settings', () => {
  it('round-trips a get/update through the real accessors for this plugin id', async () => {
    const ctx = createPluginContext('settings-plugin-a');

    expect(await ctx.settings.get()).toEqual({});

    await ctx.settings.update({ enabled: true });
    expect(await ctx.settings.get()).toEqual({ enabled: true });

    // shallow-merge, matching updatePluginSettings' own contract
    await ctx.settings.update({ level: 2 });
    expect(await ctx.settings.get()).toEqual({ enabled: true, level: 2 });
  });

  it('is isolated per plugin id', async () => {
    const ctxA = createPluginContext('settings-plugin-b');
    const ctxB = createPluginContext('settings-plugin-c');

    await ctxA.settings.update({ mine: true });

    expect(await ctxA.settings.get()).toEqual({ mine: true });
    expect(await ctxB.settings.get()).toEqual({});
  });
});

describe('ctx.kv', () => {
  it('get throws a clear "not available" error', () => {
    const ctx = createPluginContext('kv-plugin');
    expect(() => ctx.kv.get('key')).toThrow(/not available/i);
    expect(() => ctx.kv.get('key')).toThrow(/kv-plugin/);
  });

  it('set throws a clear "not available" error', () => {
    const ctx = createPluginContext('kv-plugin');
    expect(() => ctx.kv.set('key', 1)).toThrow(/not available/i);
  });

  it('del throws a clear "not available" error', () => {
    const ctx = createPluginContext('kv-plugin');
    expect(() => ctx.kv.del('key')).toThrow(/not available/i);
  });

  it('list throws a clear "not available" error', () => {
    const ctx = createPluginContext('kv-plugin');
    expect(() => ctx.kv.list()).toThrow(/not available/i);
  });
});

describe('ctx.workflows', () => {
  it('qualifies a local kind under <id>:<kind>; the plugin never sees the qualified form', () => {
    const ctx = createPluginContext('demo-wf');
    ctx.workflows.register({ kind: 'changelog', displayName: 'Changelog', surfaces: ['feed'] });

    expect(getWorkflow(qualify('demo-wf', 'changelog'))?.displayName).toBe('Changelog');
    expect(getWorkflow('changelog')).toBeUndefined();
  });

  it('throws when the payload is missing a local "kind"', () => {
    const ctx = createPluginContext('demo-wf-2');
    expect(() => ctx.workflows.register({ displayName: 'No kind' })).toThrow(/kind/);
  });

  it('cannot land on a bare (unqualified) core kind through the registrar', () => {
    registerWorkflow({ kind: 'core-guard-kind', displayName: 'Core', surfaces: ['feed'] });
    const ctx = createPluginContext('attacker');

    ctx.workflows.register({ kind: 'core-guard-kind', displayName: 'Hijack', surfaces: ['feed'] });

    expect(getWorkflow('core-guard-kind')?.displayName).toBe('Core');
    expect(getWorkflow('attacker:core-guard-kind')?.displayName).toBe('Hijack');
  });
});

describe('ctx.integrations', () => {
  it('qualifies a local provider kind', () => {
    const ctx = createPluginContext('demo-int');
    ctx.integrations.register({
      kind: 'foo',
      displayName: 'Foo',
      configSchema: {},
      events: [],
      validate: () => ({ ok: true }),
      handler: async () => {},
    });

    expect(getProvider(qualify('demo-int', 'foo'))).toBeDefined();
    expect(getProvider('foo')).toBeUndefined();
  });

  it('throws when the payload is missing a local "kind"', () => {
    const ctx = createPluginContext('demo-int-2');
    expect(() => ctx.integrations.register({ displayName: 'No kind' })).toThrow(/kind/);
  });

  it('cannot land on a core provider kind, frozen or not', () => {
    registerProvider({
      kind: 'jira',
      displayName: 'Jira',
      configSchema: {},
      events: [],
      validate: () => ({ ok: true }),
      handler: async () => {},
    });
    freezeCoreProviders();
    const ctx = createPluginContext('attacker');

    ctx.integrations.register({
      kind: 'jira',
      displayName: 'Hijack',
      configSchema: {},
      events: [],
      validate: () => ({ ok: true }),
      handler: async () => {},
    });

    expect(getProvider('jira')?.displayName).toBe('Jira');
    expect(getProvider('attacker:jira')?.displayName).toBe('Hijack');
  });
});

describe('ctx.harnesses', () => {
  it('qualifies a local harness id', () => {
    const ctx = createPluginContext('demo-harness');
    ctx.harnesses.register({ id: 'foo', displayName: 'Foo' });

    expect(listHarnesses().map((h) => h.id)).toContain(qualify('demo-harness', 'foo'));
    expect(() => getHarness('foo')).toThrow(/unknown harness/i); // never registered bare
  });

  it('throws when the payload is missing a local "id"', () => {
    const ctx = createPluginContext('demo-harness-2');
    expect(() => ctx.harnesses.register({ displayName: 'No id' })).toThrow(/id/);
  });

  it('cannot land on a core harness id, frozen or not', () => {
    registerHarness({
      id: 'claude-code',
      displayName: 'Core Claude Code',
    } as unknown as Harness);
    freezeCoreHarnesses();
    const ctx = createPluginContext('attacker');

    ctx.harnesses.register({ id: 'claude-code', displayName: 'Hijack' });

    expect(getHarness('claude-code').displayName).toBe('Core Claude Code');
    expect(listHarnesses().map((h) => h.id)).toContain('attacker:claude-code');
  });
});
