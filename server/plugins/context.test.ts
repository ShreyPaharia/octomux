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

// context.ts imports ../artifact-task.js statically (for ctx.artifacts), so
// this mock must also be registered before context.ts is pulled in — same
// reason as the fs mock above. Mocking the direct dependency (not the DB
// layer it wraps) mirrors how the ctx.facts tests below would mock ./facts.js.
// `toArtifactEntry` is NOT stubbed — it's the pure record->wire-shape mapper
// that owns the url format these tests assert. Stubbing it would leave them
// asserting the mock instead of the real thing.
vi.mock('../artifact-task.js', (importOriginal) => ({
  ...(importOriginal() as Record<string, unknown>),
  writeTaskArtifact: vi.fn(),
  listTaskArtifacts: vi.fn(),
}));

// policy.ts is owned by a sibling task and its body currently throws
// ('not implemented') — see server/plugins/policy.ts. This file tests
// context.ts's grant-check + validation wiring around `ctx.policy.intercept`,
// not policy.ts's own (not-yet-built) behavior, so it mocks the registration
// call rather than depending on the real implementation. Must be registered
// (synchronously — mock factories cannot be async) before context.ts is
// pulled in, same reasoning as the `fs` mock above.
const registeredPolicyHooks: Array<{ pluginId: string; point: string; hook: unknown }> = [];
vi.mock('./policy.js', () => ({
  registerPolicyHook: vi.fn((pluginId: string, point: string, hook: unknown) => {
    registeredPolicyHooks.push({ pluginId, point, hook });
  }),
}));

// fanout.ts owns the scheduler, the global concurrency semaphore and the
// retry/dead-letter loop; its own tests cover all of that. This file tests
// context.ts's wiring around it — the grant check on `run`, the ungated
// reads, and the abort-on-unmount effect — so it mocks the engine rather
// than driving a real fan-out through SQLite. Registered before context.ts
// is pulled in, same reasoning as the `fs` mock above.
const fanoutCalls: Array<{ pluginId: string; method: string; arg: unknown }> = [];
const abortedFanOutPlugins: string[] = [];
vi.mock('./fanout.js', () => ({
  createFanOutApi: vi.fn((pluginId: string) => ({
    run: vi.fn(async (spec: unknown) => {
      fanoutCalls.push({ pluginId, method: 'run', arg: spec });
      return { runId: 'run-1' };
    }),
    status: vi.fn(async (runId: unknown) => {
      fanoutCalls.push({ pluginId, method: 'status', arg: runId });
      return undefined;
    }),
    list: vi.fn(async (name: unknown) => {
      fanoutCalls.push({ pluginId, method: 'list', arg: name });
      return [];
    }),
  })),
  abortPluginFanOuts: vi.fn((pluginId: string) => {
    abortedFanOutPlugins.push(pluginId);
  }),
}));

// context.ts imports settings.js statically, which in turn reaches the real
// fs module through the mock above — that mock must be registered before
// context.ts is pulled in. bun's mock.module doesn't hoist, so this must be
// a dynamic import, not a static one at the top of the file.
const { createPluginContext, revokePluginContext, disposePluginContext } =
  await import('./context.js');
const { qualify } = await import('./qualify.js');
const { getLogger, setLogger } = await import('../logger.js');
const { default: pino } = await import('pino');
const { registerWorkflow, getWorkflow } = await import('../workflows/registry.js');
const { registerProvider, getProvider, resetProviders, freezeCoreProviders } =
  await import('../integrations/registry.js');
const { registerHarness, getHarness, listHarnesses, resetHarnesses, freezeCoreHarnesses } =
  await import('../harnesses/registry.js');
const { writeTaskArtifact: mockWriteTaskArtifact, listTaskArtifacts: mockListTaskArtifacts } =
  await import('../artifact-task.js');
const { registerCompute, getCompute, listCompute, resetCompute, freezeCoreCompute } =
  await import('../compute/registry.js');
const { listSurfaces, resetSurfaces, registerCoreSurfaces } = await import('../surfaces/index.js');
const { resetPluginGrants } = await import('./grants.js');
const { resetCollections } = await import('./collections.js');
const { createTestDb } = await import('../test-helpers.js');
const { putSecret } = await import('../secrets/store.js');
const { resetSecretKey } = await import('../secrets/crypto.js');

// A fixed base64 32-byte key so putSecret()/resolveSecrets() never touch a
// real key file on disk — see the SHR-277 spec's test-setup note.
const TEST_SECRET_KEY = 'ORG65/smQdAz8xkOi4nXC1uOwmHVRhSpuT4n8W5M+SQ=';

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
  vi.mocked(mockWriteTaskArtifact).mockReset();
  vi.mocked(mockListTaskArtifacts).mockReset();
  resetCompute();
  // context.ts imports `../surfaces/index.js`, whose module scope registers
  // + freezes the four core surfaces as a side effect the first time
  // anything in this process imports it — reset then re-register so each
  // test starts from that same clean, core-only state instead of
  // accumulating plugin surfaces test-to-test.
  resetSurfaces();
  registerCoreSurfaces();
  resetPluginGrants();
  resetCollections();
  createTestDb();
  process.env.OCTOMUX_SECRET_KEY = TEST_SECRET_KEY;
  resetSecretKey();
  registeredPolicyHooks.length = 0;
  fanoutCalls.length = 0;
  abortedFanOutPlugins.length = 0;
});

/** Every capability a gated registrar might need, for tests that aren't
 *  themselves exercising the grant check. */
const ALL_CAPS = [
  'workflows.register',
  'integrations.register',
  'harnesses.register',
  'http.route',
  'facts.define',
  'facts.put',
  'collections.define',
  'collections.write',
  'ui.panel',
  'policy.intercept',
] as const;

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
    const ctx = createPluginContext('demo-wf', ['workflows.register']);
    ctx.workflows.register({ kind: 'changelog', displayName: 'Changelog', surfaces: ['feed'] });

    expect(getWorkflow(qualify('demo-wf', 'changelog'))?.displayName).toBe('Changelog');
    expect(getWorkflow('changelog')).toBeUndefined();
  });

  it('throws when the payload is missing a local "kind"', () => {
    const ctx = createPluginContext('demo-wf-2', ['workflows.register']);
    expect(() => ctx.workflows.register({ displayName: 'No kind' })).toThrow(/kind/);
  });

  it('cannot land on a bare (unqualified) core kind through the registrar', () => {
    registerWorkflow({ kind: 'ctxtest-core-guard-kind', displayName: 'Core', surfaces: ['feed'] });
    const ctx = createPluginContext('attacker', ['workflows.register']);

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
    const ctx = createPluginContext('demo-int', ['integrations.register']);
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
    const ctx = createPluginContext('demo-int-2', ['integrations.register']);
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
    const ctx = createPluginContext('attacker', ['integrations.register']);

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
    const ctx = createPluginContext('demo-harness', ['harnesses.register']);
    ctx.harnesses.register({ id: 'foo', displayName: 'Foo', ...stubHarnessFns });

    expect(listHarnesses().map((h) => h.id)).toContain(qualify('demo-harness', 'foo'));
    expect(() => getHarness('foo')).toThrow(/unknown harness/i); // never registered bare
  });

  it('throws when the payload is missing a local "id"', () => {
    const ctx = createPluginContext('demo-harness-2', ['harnesses.register']);
    expect(() => ctx.harnesses.register({ displayName: 'No id', ...stubHarnessFns })).toThrow(/id/);
  });

  it('cannot land on a core harness id, frozen or not', () => {
    registerHarness({
      id: 'claude-code',
      displayName: 'Core Claude Code',
    } as unknown as Harness);
    freezeCoreHarnesses();
    const ctx = createPluginContext('attacker', ['harnesses.register']);

    ctx.harnesses.register({ id: 'claude-code', displayName: 'Hijack', ...stubHarnessFns });

    expect(getHarness('claude-code').displayName).toBe('Core Claude Code');
    expect(listHarnesses().map((h) => h.id)).toContain('attacker:claude-code');
  });

  describe('payload shape guard (F2)', () => {
    it.each(['newSessionId', 'buildLaunchCommand', 'resolveFlags', 'validateSettings'])(
      'throws when required function field "%s" is missing',
      (field) => {
        const ctx = createPluginContext('shape-harness', ['harnesses.register']);
        const payload: Record<string, unknown> = { id: 'x', displayName: 'X', ...stubHarnessFns };
        delete payload[field];
        expect(() => ctx.harnesses.register(payload)).toThrow(new RegExp(field));
        expect(() => getHarness(qualify('shape-harness', 'x'))).toThrow(/unknown harness/i);
      },
    );

    it('throws when a required function field is present but not a function', () => {
      const ctx = createPluginContext('shape-harness-2', ['harnesses.register']);
      const payload = { id: 'x', displayName: 'X', ...stubHarnessFns, installHooks: 'nope' };
      expect(() => ctx.harnesses.register(payload)).toThrow(/installHooks/);
    });
  });
});

describe('ctx.compute', () => {
  it('qualifies a local compute kind', () => {
    const ctx = createPluginContext('demo-compute', ['compute.register']);
    ctx.compute.register({ kind: 'foo', create: async () => ({}) as unknown });

    expect(listCompute().map((p) => p.kind)).toContain(qualify('demo-compute', 'foo'));
    expect(() => getCompute('foo')).toThrow(/unknown compute/i); // never registered bare
  });

  it('throws when the payload is missing a local "kind"', () => {
    const ctx = createPluginContext('demo-compute-2', ['compute.register']);
    expect(() => ctx.compute.register({ create: async () => ({}) as unknown })).toThrow(/kind/);
  });

  it('cannot land on a core compute kind, frozen or not', () => {
    registerCompute({
      kind: 'local',
      create: async () => ({}) as unknown,
    } as never);
    freezeCoreCompute();
    const ctx = createPluginContext('attacker', ['compute.register']);

    ctx.compute.register({ kind: 'local', create: async () => ({}) as unknown });

    expect(listCompute().map((p) => p.kind)).toContain('attacker:local');
    expect(listCompute().filter((p) => p.kind === 'local')).toHaveLength(1);
  });

  it('throws when required function field "create" is missing', () => {
    const ctx = createPluginContext('shape-compute', ['compute.register']);
    expect(() => ctx.compute.register({ kind: 'x' })).toThrow(/create/);
    expect(() => getCompute(qualify('shape-compute', 'x'))).toThrow(/unknown compute/i);
  });

  it('throws when "create" is present but not a function', () => {
    const ctx = createPluginContext('shape-compute-2', ['compute.register']);
    expect(() => ctx.compute.register({ kind: 'x', create: 'nope' })).toThrow(/create/);
  });

  it('allows omitting the optional "resume" field', () => {
    const ctx = createPluginContext('shape-compute-3', ['compute.register']);
    ctx.compute.register({ kind: 'x', create: async () => ({}) as unknown });
    expect(getCompute(qualify('shape-compute-3', 'x'))).toBeDefined();
  });

  it('throws when "resume" is present but not a function', () => {
    const ctx = createPluginContext('shape-compute-4', ['compute.register']);
    expect(() =>
      ctx.compute.register({ kind: 'x', create: async () => ({}) as unknown, resume: 'nope' }),
    ).toThrow(/resume/);
  });
});

describe('ctx.surfaces', () => {
  it('qualifies a local surface kind', () => {
    const ctx = createPluginContext('demo-surface', ['surfaces.register']);
    ctx.surfaces.register({ kind: 'discord', renderers: ['stat'], render: () => undefined });

    expect(listSurfaces().map((s) => s.kind)).toContain(qualify('demo-surface', 'discord'));
  });

  it('throws without the surfaces.register grant, naming the plugin and the capability', () => {
    const ctx = createPluginContext('demo-surface-nogrant');
    expect(() =>
      ctx.surfaces.register({ kind: 'discord', renderers: [], render: () => undefined }),
    ).toThrow(/"demo-surface-nogrant"/);
    expect(() =>
      ctx.surfaces.register({ kind: 'discord', renderers: [], render: () => undefined }),
    ).toThrow(/"surfaces\.register"/);
    expect(listSurfaces().map((s) => s.kind)).not.toContain(
      qualify('demo-surface-nogrant', 'discord'),
    );
  });

  it('throws when the payload is missing a local "kind"', () => {
    const ctx = createPluginContext('demo-surface-2', ['surfaces.register']);
    expect(() =>
      ctx.surfaces.register({ renderers: [], render: () => undefined } as never),
    ).toThrow(/kind/);
  });

  it('throws when "renderers" is missing or not an array', () => {
    const ctx = createPluginContext('shape-surface', ['surfaces.register']);
    expect(() => ctx.surfaces.register({ kind: 'x', render: () => undefined } as never)).toThrow(
      /renderers/,
    );
    expect(() =>
      ctx.surfaces.register({ kind: 'x', renderers: 'nope', render: () => undefined } as never),
    ).toThrow(/renderers/);
    expect(listSurfaces().map((s) => s.kind)).not.toContain(qualify('shape-surface', 'x'));
  });

  it('throws when "render" is missing — required for a plugin surface, unlike core web', () => {
    const ctx = createPluginContext('shape-surface-2', ['surfaces.register']);
    expect(() => ctx.surfaces.register({ kind: 'x', renderers: [] } as never)).toThrow(/render/);
    expect(listSurfaces().map((s) => s.kind)).not.toContain(qualify('shape-surface-2', 'x'));
  });

  it('throws when "render" is present but not a function', () => {
    const ctx = createPluginContext('shape-surface-3', ['surfaces.register']);
    expect(() =>
      ctx.surfaces.register({ kind: 'x', renderers: [], render: 'nope' } as never),
    ).toThrow(/render/);
  });

  it('accepts a surface with no "prompt" — absent means read-only', () => {
    const ctx = createPluginContext('shape-surface-4', ['surfaces.register']);
    ctx.surfaces.register({ kind: 'x', renderers: [], render: () => undefined });
    expect(listSurfaces().map((s) => s.kind)).toContain(qualify('shape-surface-4', 'x'));
  });

  it('throws when "prompt" is present but not a function', () => {
    const ctx = createPluginContext('shape-surface-5', ['surfaces.register']);
    expect(() =>
      ctx.surfaces.register({
        kind: 'x',
        renderers: [],
        render: () => undefined,
        prompt: 'nope',
      } as never),
    ).toThrow(/prompt/);
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
    const ctx = createPluginContext('wfguard', ['workflows.register']);
    // The concrete crash this prevents: server/api.ts does
    // `app.use(wf.apiRouter)` on any truthy value, and express 5 throws
    // "app.use() requires a middleware function" — killing createApp() AFTER
    // the plugin was already recorded as loaded.
    expect(() => ctx.workflows.register({ kind: 'k', apiRouter: {} })).toThrow(/apiRouter/);
    expect(getWorkflow(qualify('wfguard', 'k'))).toBeUndefined();
  });

  it('rejects a workflow whose run is not a function', () => {
    const ctx = createPluginContext('wfguard2', ['workflows.register']);
    expect(() => ctx.workflows.register({ kind: 'k', run: 'nope' })).toThrow(/run/);
    expect(getWorkflow(qualify('wfguard2', 'k'))).toBeUndefined();
  });

  it.each(['validate', 'handler', 'events'])(
    'rejects a provider missing required field "%s"',
    (field) => {
      const ctx = createPluginContext('provguard', ['integrations.register']);
      const payload: Record<string, unknown> = provider();
      delete payload[field];
      expect(() => ctx.integrations.register(payload)).toThrow(new RegExp(field));
      expect(getProvider(qualify('provguard', 'thing'))).toBeUndefined();
    },
  );

  it('rejects a provider whose events is not an array', () => {
    const ctx = createPluginContext('provguard2', ['integrations.register']);
    // hook-dispatcher.ts calls events.includes() OUTSIDE the handler's
    // try/catch, so a non-array here throws unhandled for every hook event
    // dispatched — not just this plugin's.
    expect(() => ctx.integrations.register({ ...provider(), events: 'nope' })).toThrow(/events/);
  });
});

describe('ctx.catalog', () => {
  it('list() returns entries, and still works after revokePluginContext (it is a read, not a registration)', () => {
    // `createPluginContext` here never goes through the loader's mount flow
    // (`loader.test.ts` / `catalog.test.ts` cover a real mounted-plugin
    // entry), so this context's own plugin id won't appear in the catalog —
    // only the always-present `core` entry is guaranteed. What this test
    // pins is that `list()` is a plain read: it returns data both before and
    // after the context is revoked, unlike every other registrar.
    const ctx = createPluginContext('catalog-demo');

    const before = ctx.catalog.list();
    expect(Array.isArray(before)).toBe(true);
    expect(before.some((e) => e.id === 'core' && e.kind === 'core')).toBe(true);

    revokePluginContext(ctx);

    const after = ctx.catalog.list();
    expect(after.some((e) => e.id === 'core' && e.kind === 'core')).toBe(true);
  });
});

describe('revokePluginContext (F3)', () => {
  const harness = () => ({ id: 'late', displayName: 'Late', ...stubHarnessFns });

  it('every registrar throws after revoke, and nothing reaches a registry', () => {
    const ctx = createPluginContext('slowplug', ALL_CAPS);
    revokePluginContext(ctx);

    expect(() => ctx.harnesses.register(harness())).toThrow(/revoked/);
    expect(() => ctx.compute.register({ kind: 'k', create: async () => ({}) as unknown })).toThrow(
      /revoked/,
    );
    expect(() =>
      ctx.surfaces.register({ kind: 'k', renderers: [], render: () => undefined }),
    ).toThrow(/revoked/);
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
    expect(listCompute().map((p) => p.kind)).not.toContain('slowplug:k');
    expect(listSurfaces().map((s) => s.kind)).not.toContain('slowplug:k');
    expect(getWorkflow(qualify('slowplug', 'k'))).toBeUndefined();
    expect(getProvider(qualify('slowplug', 'k'))).toBeUndefined();
  });

  it('the error names the plugin and says why', () => {
    const ctx = createPluginContext('slowplug2', ALL_CAPS);
    revokePluginContext(ctx);
    expect(() => ctx.harnesses.register(harness())).toThrow(/slowplug2/);
  });

  it('revoking one context does not disarm another', () => {
    const dead = createPluginContext('deadplug', ALL_CAPS);
    const alive = createPluginContext('aliveplug', ['harnesses.register']);
    revokePluginContext(dead);

    alive.harnesses.register(harness());
    expect(listHarnesses().map((h) => h.id)).toContain('aliveplug:late');
  });
});

describe('ctx.artifacts', () => {
  it("write() forwards to writeTaskArtifact with the plugin's OWN id, not a caller-supplied one", async () => {
    vi.mocked(mockWriteTaskArtifact).mockReturnValue({
      pluginId: 'artifact-plugin',
      name: 'report.md',
      mime: 'text/markdown',
      size: 5,
      updatedAt: '2026-08-21 00:00:00',
    });
    const ctx = createPluginContext('artifact-plugin', ['artifacts.write']);

    const entry = await ctx.artifacts.write('task-1', {
      // Nothing on ArtifactInput lets a caller name a plugin id, but even a
      // stray extra field must not leak through as one.
      pluginId: 'someone-else',
      name: 'report.md',
      mime: 'text/markdown',
      body: 'hello',
    } as never);

    expect(mockWriteTaskArtifact).toHaveBeenCalledWith(
      'task-1',
      'artifact-plugin',
      expect.objectContaining({ name: 'report.md', mime: 'text/markdown', body: 'hello' }),
    );
    expect(entry).toEqual({
      pluginId: 'artifact-plugin',
      name: 'report.md',
      mime: 'text/markdown',
      size: 5,
      updatedAt: '2026-08-21 00:00:00',
      url: '/api/tasks/task-1/artifacts/artifact-plugin/report.md',
    });
  });

  it('builds the url with percent-encoding for a taskId/name needing it', async () => {
    vi.mocked(mockWriteTaskArtifact).mockReturnValue({
      pluginId: 'artifact-plugin',
      name: 'my report.md',
      mime: 'text/markdown',
      size: 5,
      updatedAt: '2026-08-21 00:00:00',
    });
    const ctx = createPluginContext('artifact-plugin', ['artifacts.write']);

    const entry = await ctx.artifacts.write('task/1', {
      name: 'my report.md',
      mime: 'text/markdown',
      body: 'hello',
    });

    expect(entry.url).toBe('/api/tasks/task%2F1/artifacts/artifact-plugin/my%20report.md');
  });

  it('list() forwards to listTaskArtifacts and maps every record to an entry with a url', async () => {
    vi.mocked(mockListTaskArtifacts).mockReturnValue([
      {
        pluginId: 'plugin-a',
        name: 'a.json',
        mime: 'application/json',
        size: 2,
        updatedAt: '2026-08-21 00:00:00',
      },
      {
        pluginId: 'plugin-b',
        name: 'b.md',
        mime: 'text/markdown',
        size: 3,
        updatedAt: '2026-08-21 00:01:00',
      },
    ]);
    const ctx = createPluginContext('reader-plugin', ['artifacts.write']);

    const entries = await ctx.artifacts.list('task-2');

    expect(mockListTaskArtifacts).toHaveBeenCalledWith('task-2');
    // Unscoped: both plugin-a's and plugin-b's artifacts come back, not just
    // this context's own plugin id.
    expect(entries).toEqual([
      {
        pluginId: 'plugin-a',
        name: 'a.json',
        mime: 'application/json',
        size: 2,
        updatedAt: '2026-08-21 00:00:00',
        url: '/api/tasks/task-2/artifacts/plugin-a/a.json',
      },
      {
        pluginId: 'plugin-b',
        name: 'b.md',
        mime: 'text/markdown',
        size: 3,
        updatedAt: '2026-08-21 00:01:00',
        url: '/api/tasks/task-2/artifacts/plugin-b/b.md',
      },
    ]);
  });

  it('write() still works on a REVOKED context — deliberate, not a bug: same reasoning as facts.put, do not gate this on assertLive', async () => {
    vi.mocked(mockWriteTaskArtifact).mockReturnValue({
      pluginId: 'revoked-plugin',
      name: 'report.md',
      mime: 'text/markdown',
      size: 5,
      updatedAt: '2026-08-21 00:00:00',
    });
    const ctx = createPluginContext('revoked-plugin', ['artifacts.write']);
    revokePluginContext(ctx);

    const entry = await ctx.artifacts.write('task-3', {
      name: 'report.md',
      mime: 'text/markdown',
      body: 'hello',
    });

    expect(entry.pluginId).toBe('revoked-plugin');
    expect(mockWriteTaskArtifact).toHaveBeenCalled();
  });

  it('propagates a writeTaskArtifact rejection (no worktree) as a rejected promise, not a swallowed no-op', async () => {
    vi.mocked(mockWriteTaskArtifact).mockImplementation(() => {
      throw new Error('task "task-4" has no worktree — cannot write artifact');
    });
    const ctx = createPluginContext('artifact-plugin-2', ['artifacts.write']);

    await expect(
      ctx.artifacts.write('task-4', { name: 'report.md', mime: 'text/markdown', body: 'hello' }),
    ).rejects.toThrow(/no worktree/);
  });
});

describe('grant checks (SHR-259)', () => {
  it('a plugin with no recorded grants is denied every gated registrar', async () => {
    const ctx = createPluginContext('nogrants');

    expect(() => ctx.workflows.register({ kind: 'k' })).toThrow(/not granted/);
    expect(() =>
      ctx.integrations.register({
        kind: 'k',
        validate: () => ({ ok: true }),
        handler: async () => {},
        events: [],
      }),
    ).toThrow(/not granted/);
    expect(() => ctx.harnesses.register({ id: 'x', displayName: 'X', ...stubHarnessFns })).toThrow(
      /not granted/,
    );
    expect(() => ctx.http.route('GET', '/x', async () => {})).toThrow(/not granted/);
    expect(() => ctx.facts.define({ type: 'x', schema: {} })).toThrow(/not granted/);
    expect(() => ctx.facts.put('task-1', 'x', {})).toThrow(/not granted/);
    expect(() => ctx.collections.define({ name: 'x', key: 'id', schema: {} })).toThrow(
      /not granted/,
    );
    expect(() => ctx.collections.put('x', { id: '1' })).toThrow(/not granted/);
    expect(() => ctx.ui.panel({ slot: 'task.panel', fact: 'x', as: 'stat' })).toThrow(
      /not granted/,
    );
    // SHR-257: ctx.ui.action() is gated on ui.action, separately from ui.panel.
    expect(() => ctx.ui.action({ id: 'x', label: 'X', run: async () => {} })).toThrow(
      /not granted/,
    );
    expect(() => ctx.policy.intercept('task.launch', () => undefined)).toThrow(/not granted/);
    // SHR-273: compute + artifacts landed after the capability list was
    // written and were ungated for a while. Pin them so that cannot recur.
    expect(() => ctx.compute.register({ kind: 'c', create: async () => ({}) } as never)).toThrow(
      /not granted/,
    );
    await expect(
      ctx.artifacts.write('task-1', { name: 'r.md', mime: 'text/markdown', body: 'x' }),
    ).rejects.toThrow(/not granted/);
    // SHR-272: ctx.agents.run() is gated on agents.run same as the above.
    await expect(ctx.agents.run({ input: 'x', outputSchema: {} })).rejects.toThrow(/not granted/);
  });

  it('the ungranted error names the plugin and the missing capability', () => {
    const ctx = createPluginContext('nogrants2');
    expect(() => ctx.http.route('GET', '/x', async () => {})).toThrow(/"nogrants2"/);
    expect(() => ctx.http.route('GET', '/x', async () => {})).toThrow(/"http\.route"/);
  });

  it('artifacts.list stays ungated — reads are ungated by design, same as facts.read (SHR-273)', async () => {
    const ctx = createPluginContext('nogrants3');
    // Asserts the grant check specifically, not success: the mocked
    // listTaskArtifacts returns undefined here, so this call rejects either
    // way. What must never happen is rejecting for lack of a grant.
    await expect(ctx.artifacts.list('task-1')).rejects.not.toThrow(/not granted/);
  });

  it('reads (facts.read, facts.watch, collections.query, collections.watch) and self-owned members (settings, kv, logger, effect) stay ungated', () => {
    const ctx = createPluginContext('nogrants3');
    expect(() => ctx.facts.read('task-1')).not.toThrow();
    expect(() => ctx.facts.watch('other:type', () => {})).not.toThrow();
    expect(() => ctx.collections.query('other:things')).not.toThrow();
    expect(() => ctx.collections.watch('other:things', () => {})).not.toThrow();
    expect(() => ctx.effect(() => {})).not.toThrow();
    expect(typeof ctx.settings.get).toBe('function');
    expect(typeof ctx.kv.get).toBe('function'); // throws for its own "not available" reason, not a grant
  });

  it.each([
    [
      'workflows.register',
      (ctx: ReturnType<typeof createPluginContext>) => ctx.workflows.register({ kind: 'k' }),
    ],
    [
      'integrations.register',
      (ctx: ReturnType<typeof createPluginContext>) =>
        ctx.integrations.register({
          kind: 'k',
          validate: () => ({ ok: true }),
          handler: async () => {},
          events: [],
        }),
    ],
    [
      'harnesses.register',
      (ctx: ReturnType<typeof createPluginContext>) =>
        ctx.harnesses.register({ id: 'x', displayName: 'X', ...stubHarnessFns }),
    ],
    [
      'http.route',
      (ctx: ReturnType<typeof createPluginContext>) => ctx.http.route('GET', '/x', async () => {}),
    ],
    [
      'facts.define',
      (ctx: ReturnType<typeof createPluginContext>) => ctx.facts.define({ type: 'x', schema: {} }),
    ],
    [
      'facts.put',
      // The type was never `ctx.facts.define()`d for this plugin id (this row
      // grants ONLY facts.put), so the returned promise rejects downstream in
      // facts.ts — irrelevant here, this test only asserts the grant check
      // itself doesn't throw synchronously. Silence the rejection so it
      // doesn't surface as an unhandled rejection.
      (ctx: ReturnType<typeof createPluginContext>) => {
        const result = ctx.facts.put('task-1', 'x', {});
        result.catch(() => {});
      },
    ],
    [
      'ui.panel',
      (ctx: ReturnType<typeof createPluginContext>) =>
        ctx.ui.panel({ slot: 'task.panel', fact: 'x', as: 'stat' }),
    ],
    [
      'ui.action',
      (ctx: ReturnType<typeof createPluginContext>) =>
        ctx.ui.action({ id: 'x', label: 'X', run: async () => {} }),
    ],
    [
      // SHR-272: ctx.agents.run() is async and, with no real harness/substrate
      // wired in this test file, rejects downstream once past the grant
      // check. Same pattern as the facts.put row above — only the synchronous
      // grant check is asserted; silence the rejection so it doesn't surface
      // as an unhandled rejection.
      'agents.run',
      (ctx: ReturnType<typeof createPluginContext>) => {
        const result = ctx.agents.run({ input: 'x', outputSchema: {} });
        result.catch(() => {});
      },
    ],
    [
      'collections.define',
      (ctx: ReturnType<typeof createPluginContext>) =>
        ctx.collections.define({ name: 'x', key: 'id', schema: {} }),
    ],
    [
      'collections.write',
      // Same reasoning as facts.put above: the collection was never defined
      // for this plugin id, so the returned promise rejects downstream in
      // collections.ts — irrelevant here, this only pins the grant check
      // itself not throwing synchronously. Silence the rejection.
      (ctx: ReturnType<typeof createPluginContext>) => {
        const result = ctx.collections.put('x', { id: '1' });
        result.catch(() => {});
      },
    ],
  ])('a call granted only "%s" is allowed through, everything else stays denied', (cap, call) => {
    const ctx = createPluginContext('onegrant', [cap as (typeof ALL_CAPS)[number]]);
    expect(() => call(ctx)).not.toThrow();
  });
});

describe('ctx.policy', () => {
  it('registers a hook when granted', () => {
    const ctx = createPluginContext('policy-plugin', ['policy.intercept']);
    const hook = () => undefined;
    ctx.policy.intercept('task.launch', hook);

    expect(registeredPolicyHooks).toEqual([
      { pluginId: 'policy-plugin', point: 'task.launch', hook },
    ]);
  });

  it('throws without the policy.intercept grant, naming the plugin', () => {
    const ctx = createPluginContext('policy-plugin-2');
    expect(() => ctx.policy.intercept('task.launch', () => undefined)).toThrow(/"policy-plugin-2"/);
    expect(() => ctx.policy.intercept('task.launch', () => undefined)).toThrow(
      /"policy\.intercept"/,
    );
    expect(registeredPolicyHooks).toEqual([]);
  });

  it('rejects an unknown policy point, listing the valid ones', () => {
    const ctx = createPluginContext('policy-plugin-3', ['policy.intercept']);
    expect(() => ctx.policy.intercept('task.merge' as never, () => undefined)).toThrow(
      /task\.launch/,
    );
    expect(registeredPolicyHooks).toEqual([]);
  });

  it('rejects a non-function hook', () => {
    const ctx = createPluginContext('policy-plugin-4', ['policy.intercept']);
    expect(() => ctx.policy.intercept('task.launch', 'nope' as never)).toThrow(/function/);
  });

  it('is denied after revoke even with the grant present', () => {
    const ctx = createPluginContext('policy-plugin-5', ['policy.intercept']);
    revokePluginContext(ctx);
    expect(() => ctx.policy.intercept('task.launch', () => undefined)).toThrow(/revoked/);
  });
});

describe('ctx.collections (SHR-275)', () => {
  it('define throws without collections.define, succeeds with it', () => {
    const ctx = createPluginContext('coll-define');
    expect(() => ctx.collections.define({ name: 'x', key: 'id', schema: {} })).toThrow(
      /not granted/,
    );

    const granted = createPluginContext('coll-define-2', ['collections.define']);
    expect(() =>
      granted.collections.define({ name: 'x', key: 'id', schema: { type: 'object' } }),
    ).not.toThrow();
  });

  it('put throws without collections.write, succeeds (and actually stores) with it', async () => {
    const ctx = createPluginContext('coll-write');
    expect(() => ctx.collections.put('x', { id: '1' })).toThrow(/not granted/);

    const granted = createPluginContext('coll-write-2', [
      'collections.define',
      'collections.write',
    ]);
    granted.collections.define({ name: 'baselines', key: 'id', schema: { type: 'object' } });
    await expect(
      granted.collections.put('baselines', { id: '1', ok: true }),
    ).resolves.toBeUndefined();
    expect(await granted.collections.query('baselines')).toEqual([{ id: '1', ok: true }]);
  });

  it('query and watch work without any grant — reads are ungated, like facts.read', async () => {
    const owner = createPluginContext('coll-owner-read', [
      'collections.define',
      'collections.write',
    ]);
    owner.collections.define({ name: 'things', key: 'id', schema: { type: 'object' } });
    await owner.collections.put('things', { id: '1' });

    const reader = createPluginContext('coll-reader-noGrant');
    await expect(reader.collections.query('coll-owner-read:things')).resolves.toEqual([
      { id: '1' },
    ]);
    expect(() => reader.collections.watch('coll-owner-read:things', () => {})).not.toThrow();
  });

  it("watch's unsubscribe is auto-disposed by disposePluginContext — a watcher on a sibling's collection stops firing once the watching plugin is disposed", async () => {
    const owner = createPluginContext('coll-owner-3', ['collections.define', 'collections.write']);
    owner.collections.define({ name: 'events', key: 'id', schema: { type: 'object' } });

    const watcherCtx = createPluginContext('coll-watcher-3');
    const seen: unknown[] = [];
    watcherCtx.collections.watch('coll-owner-3:events', (record) => seen.push(record));

    await owner.collections.put('events', { id: '1' });
    expect(seen).toEqual([{ id: '1' }]);

    await disposePluginContext(watcherCtx);

    await owner.collections.put('events', { id: '2' });
    // The watcher's own plugin was disposed, so its subscription is gone —
    // even though `owner` (which defines and owns the collection) was never
    // touched.
    expect(seen).toEqual([{ id: '1' }]);
  });
});

describe('disposePluginContext clears grants', () => {
  it('clearPluginGrants runs on unmount, denying a subsequent context created for the same id without grants', async () => {
    const { disposePluginContext } = await import('./context.js');
    const { getPluginGrants } = await import('./grants.js');

    const ctx = createPluginContext('disposed-plugin', ['http.route']);
    expect(getPluginGrants('disposed-plugin')).toEqual(['http.route']);

    await disposePluginContext(ctx);

    expect(getPluginGrants('disposed-plugin')).toEqual([]);
  });
});
describe('ctx.fanout', () => {
  it('run() reaches the engine when the fanout.run grant is present', async () => {
    const ctx = createPluginContext('fan-plugin', ['fanout.run']);
    const spec = { name: 'enrich', source: { items: [1, 2] }, each: async () => 'ok' };

    await expect(ctx.fanout.run(spec)).resolves.toEqual({ runId: 'run-1' });
    expect(fanoutCalls).toEqual([{ pluginId: 'fan-plugin', method: 'run', arg: spec }]);
  });

  it('run() throws without the grant, naming the plugin and the capability', () => {
    const ctx = createPluginContext('fan-plugin-2');
    const spec = { name: 'enrich', source: { items: [] }, each: async () => 'ok' };

    expect(() => ctx.fanout.run(spec)).toThrow(/"fan-plugin-2"/);
    expect(() => ctx.fanout.run(spec)).toThrow(/"fanout\.run"/);
    expect(fanoutCalls).toEqual([]);
  });

  // Reads follow the facts.read / artifacts.list precedent: ungated.
  it.each([
    [
      'status',
      (ctx: ReturnType<typeof createPluginContext>) => ctx.fanout.status('run-1'),
      'run-1',
    ],
    ['list', (ctx: ReturnType<typeof createPluginContext>) => ctx.fanout.list('enrich'), 'enrich'],
  ])('%s() is an ungated read', async (method, call, arg) => {
    const ctx = createPluginContext(`fan-read-${method}`);

    await call(ctx);

    expect(fanoutCalls).toEqual([{ pluginId: `fan-read-${method}`, method, arg }]);
  });

  // A fan-out is the one thing still RUNNING at unmount — everything else
  // registered through ctx is just a table row to delete.
  it("aborts this plugin's in-flight runs on unmount", async () => {
    const { disposePluginContext } = await import('./context.js');
    const ctx = createPluginContext('fan-unmount', ['fanout.run']);

    expect(abortedFanOutPlugins).toEqual([]);
    await disposePluginContext(ctx);

    expect(abortedFanOutPlugins).toEqual(['fan-unmount']);
  });

  // Deliberately NOT assertLive-gated: a fan-out is work a healthy plugin
  // starts long after apply() returned, same as facts.put / artifacts.write.
  it('still runs after revoke, given the grant', async () => {
    const ctx = createPluginContext('fan-revoked', ['fanout.run']);
    revokePluginContext(ctx);

    await expect(
      ctx.fanout.run({ name: 'enrich', source: { items: [] }, each: async () => 'ok' }),
    ).resolves.toEqual({ runId: 'run-1' });
  });
});

describe('ctx.secrets (SHR-277)', () => {
  it('list() works with NO grants declared (ungated) and returns names only', async () => {
    putSecret('api-key', 'super-secret-value-123', 'demo');
    const ctx = createPluginContext('secrets-list-plugin');

    const names = await ctx.secrets.list();

    expect(names).toEqual(['api-key']);
    // Names only — nothing resembling the value leaked through.
    for (const name of names) {
      expect(name).not.toContain('super-secret-value-123');
    }
  });

  it('resolve() throws without secrets.read, naming the plugin and the capability', async () => {
    putSecret('api-key', 'super-secret-value-123');
    const ctx = createPluginContext('secrets-resolve-nogrant');

    await expect(ctx.secrets.resolve('${secret:api-key}')).rejects.toThrow(
      /"secrets-resolve-nogrant"/,
    );
    await expect(ctx.secrets.resolve('${secret:api-key}')).rejects.toThrow(/"secrets\.read"/);
  });

  it('resolve() substitutes ${secret:NAME} when secrets.read IS granted', async () => {
    putSecret('api-key', 'super-secret-value-123');
    const ctx = createPluginContext('secrets-resolve-granted', ['secrets.read']);

    await expect(ctx.secrets.resolve('Bearer ${secret:api-key}')).resolves.toBe(
      'Bearer super-secret-value-123',
    );
  });

  it('list() throws after the context is revoked (assertLive)', async () => {
    const ctx = createPluginContext('secrets-list-revoked');
    revokePluginContext(ctx);

    await expect(ctx.secrets.list()).rejects.toThrow(/revoked/);
  });

  it('resolve() throws after the context is revoked (assertLive), even with the grant', async () => {
    putSecret('api-key', 'super-secret-value-123');
    const ctx = createPluginContext('secrets-resolve-revoked', ['secrets.read']);
    revokePluginContext(ctx);

    await expect(ctx.secrets.resolve('${secret:api-key}')).rejects.toThrow(/revoked/);
  });
});
