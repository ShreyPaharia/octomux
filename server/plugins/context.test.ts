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

// settings.ts dynamically imports `./harnesses/index.js` for harness-blob
// validation on every getSettings()/updateSettings() call. That resolves to
// the same `harnesses/registry.js` singleton this file imports directly
// below, so `resetHarnesses()` in `beforeEach` is enough to keep it empty
// for the ctx.settings tests — no module mock needed. (Deliberately NOT
// mocked: `vi.mock('../harnesses/index.js', ...)` is process-global in bun
// and is never unregistered, so it poisoned every sibling test file that
// imports the real module afterwards — e.g. `bun test
// ./server/plugins/context.test.ts ./server/harnesses/registry.test.ts`
// failed 11 tests in registry.test.ts. `bun run test:server`'s `--parallel`
// flag hid this by isolating each file into its own process.)

// context.ts imports settings.js statically, which in turn reaches the real
// fs module through the mock above — that mock must be registered before
// context.ts is pulled in. bun's mock.module doesn't hoist, so this must be
// a dynamic import, not a static one at the top of the file.
const { createPluginContext, revokePluginContext } = await import('./context.js');
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

// workflows/registry.ts has no resetWorkflows() (deliberately not owned by
// this task — see the plugins/context.ts F3 write-up), so the kinds this
// file registers directly (not through ctx.workflows.register, which always
// namespaces under the plugin id) outlive every test in this process. Using
// distinctly-prefixed literals ('ctxtest-...') instead of an exact reset
// keeps that leak from ever colliding with a real workflow kind.
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
    registerWorkflow({ kind: 'ctxtest-core-guard-kind', displayName: 'Core', surfaces: ['feed'] });
    const ctx = createPluginContext('attacker');

    ctx.workflows.register({
      kind: 'ctxtest-core-guard-kind',
      displayName: 'Hijack',
      surfaces: ['feed'],
    });

    expect(getWorkflow('ctxtest-core-guard-kind')?.displayName).toBe('Core');
    expect(getWorkflow('attacker:ctxtest-core-guard-kind')?.displayName).toBe('Hijack');
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

// Minimal stand-in for the 8 `Harness` members core calls unconditionally
// (see HARNESS_REQUIRED_FN_FIELDS in context.ts) — every test that expects
// harnesses.register() to actually reach the registry needs all of these,
// or the new shape guard rejects it before qualification is even relevant.
const stubHarnessFns = {
  newSessionId: () => 'session-id',
  buildLaunchCommand: () => 'launch',
  buildResumeCommand: () => 'resume',
  buildContinueCommand: () => null,
  installHooks: async () => {},
  uninstallHooks: async () => {},
  resolveFlags: () => '',
  validateSettings: (blob: unknown) => blob as Record<string, unknown>,
};

describe('ctx.harnesses', () => {
  it('qualifies a local harness id', () => {
    const ctx = createPluginContext('demo-harness');
    ctx.harnesses.register({ id: 'foo', displayName: 'Foo', ...stubHarnessFns });

    expect(listHarnesses().map((h) => h.id)).toContain(qualify('demo-harness', 'foo'));
    expect(() => getHarness('foo')).toThrow(/unknown harness/i); // never registered bare
  });

  it('throws when the payload is missing a local "id"', () => {
    const ctx = createPluginContext('demo-harness-2');
    expect(() => ctx.harnesses.register({ displayName: 'No id', ...stubHarnessFns })).toThrow(/id/);
  });

  it('cannot land on a core harness id, frozen or not', () => {
    registerHarness({
      id: 'claude-code',
      displayName: 'Core Claude Code',
    } as unknown as Harness);
    freezeCoreHarnesses();
    const ctx = createPluginContext('attacker');

    ctx.harnesses.register({ id: 'claude-code', displayName: 'Hijack', ...stubHarnessFns });

    expect(getHarness('claude-code').displayName).toBe('Core Claude Code');
    expect(listHarnesses().map((h) => h.id)).toContain('attacker:claude-code');
  });

  describe('payload shape guard (F2)', () => {
    it.each(['newSessionId', 'buildLaunchCommand', 'resolveFlags', 'validateSettings'])(
      'throws when required function field "%s" is missing',
      (field) => {
        const ctx = createPluginContext('shape-harness');
        const payload: Record<string, unknown> = { id: 'x', displayName: 'X', ...stubHarnessFns };
        delete payload[field];
        expect(() => ctx.harnesses.register(payload)).toThrow(new RegExp(field));
        expect(() => getHarness(qualify('shape-harness', 'x'))).toThrow(/unknown harness/i);
      },
    );

    it('throws when a required function field is present but not a function', () => {
      const ctx = createPluginContext('shape-harness-2');
      const payload = { id: 'x', displayName: 'X', ...stubHarnessFns, installHooks: 'nope' };
      expect(() => ctx.harnesses.register(payload)).toThrow(/installHooks/);
    });
  });
});

describe('workflow + provider payload shape guards (F2)', () => {
  const provider = () => ({
    kind: 'thing',
    validate: () => ({ ok: true }),
    handler: async () => {},
    events: ['workflow_status_changed'],
  });

  it('rejects a workflow whose apiRouter is not a function', () => {
    const ctx = createPluginContext('wfguard');
    // The concrete crash this prevents: server/api.ts does
    // `app.use(wf.apiRouter)` on any truthy value, and express 5 throws
    // "app.use() requires a middleware function" — killing createApp() AFTER
    // the plugin was already recorded as loaded.
    expect(() => ctx.workflows.register({ kind: 'k', apiRouter: {} })).toThrow(/apiRouter/);
    expect(getWorkflow(qualify('wfguard', 'k'))).toBeUndefined();
  });

  it('rejects a workflow whose run is not a function', () => {
    const ctx = createPluginContext('wfguard2');
    expect(() => ctx.workflows.register({ kind: 'k', run: 'nope' })).toThrow(/run/);
    expect(getWorkflow(qualify('wfguard2', 'k'))).toBeUndefined();
  });

  it.each(['validate', 'handler', 'events'])(
    'rejects a provider missing required field "%s"',
    (field) => {
      const ctx = createPluginContext('provguard');
      const payload: Record<string, unknown> = provider();
      delete payload[field];
      expect(() => ctx.integrations.register(payload)).toThrow(new RegExp(field));
      expect(getProvider(qualify('provguard', 'thing'))).toBeUndefined();
    },
  );

  it('rejects a provider whose events is not an array', () => {
    const ctx = createPluginContext('provguard2');
    // hook-dispatcher.ts calls events.includes() OUTSIDE the handler's
    // try/catch, so a non-array here throws unhandled for every hook event
    // dispatched — not just this plugin's.
    expect(() => ctx.integrations.register({ ...provider(), events: 'nope' })).toThrow(/events/);
  });
});

describe('revokePluginContext (F3)', () => {
  const harness = () => ({ id: 'late', displayName: 'Late', ...stubHarnessFns });

  it('every registrar throws after revoke, and nothing reaches a registry', () => {
    const ctx = createPluginContext('slowplug');
    revokePluginContext(ctx);

    expect(() => ctx.harnesses.register(harness())).toThrow(/revoked/);
    expect(() => ctx.workflows.register({ kind: 'k' })).toThrow(/revoked/);
    expect(() =>
      ctx.integrations.register({
        kind: 'k',
        validate: () => ({ ok: true }),
        handler: async () => {},
        events: [],
      }),
    ).toThrow(/revoked/);

    expect(listHarnesses().map((h) => h.id)).not.toContain('slowplug:late');
    expect(getWorkflow(qualify('slowplug', 'k'))).toBeUndefined();
    expect(getProvider(qualify('slowplug', 'k'))).toBeUndefined();
  });

  it('the error names the plugin and says why', () => {
    const ctx = createPluginContext('slowplug2');
    revokePluginContext(ctx);
    expect(() => ctx.harnesses.register(harness())).toThrow(/slowplug2/);
  });

  it('revoking one context does not disarm another', () => {
    const dead = createPluginContext('deadplug');
    const alive = createPluginContext('aliveplug');
    revokePluginContext(dead);

    alive.harnesses.register(harness());
    expect(listHarnesses().map((h) => h.id)).toContain('aliveplug:late');
  });
});
