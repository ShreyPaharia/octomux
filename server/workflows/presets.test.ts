import { describe, it, expect, beforeEach, afterEach, vi } from '../bun-test.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Side-effect import registers every code handler, which `checkPresetShape`
// needs to accept an `execution: task|chat` preset (§3.2 last rule).
import './index.js';
import { checkPresetShape, loadPresets, listPresets, reloadPresets } from './presets.js';
import { listCronWorkflowKinds } from './registry.js';

const VALID_SESSION = {
  kind: 'my-kind',
  displayName: 'My Kind',
  execution: 'session',
};

describe('checkPresetShape', () => {
  it('accepts a minimal session preset', () => {
    const r = checkPresetShape(VALID_SESSION, 'home', 'my-kind');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preset.kind).toBe('my-kind');
      expect(r.preset.execution).toBe('session');
    }
  });

  it('carries optional fields through when present', () => {
    const r = checkPresetShape(
      {
        ...VALID_SESSION,
        defaultCron: '0 9 * * 1',
        prompt: 'do the thing',
        config: { type: 'object', properties: { a: { type: 'string' } } },
        output: { type: 'object', properties: { b: { type: 'number' } } },
      },
      'home',
      'my-kind',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preset.defaultCron).toBe('0 9 * * 1');
      expect(r.preset.prompt).toBe('do the thing');
      expect(r.preset.config).toBeDefined();
      expect(r.preset.output).toBeDefined();
    }
  });

  // §3.2 rejection matrix. Every case must be rejected, never thrown.
  it.each([
    ['not an object', 'null value', null, 'home', 'my-kind'],
    ['not an object', 'an array', [], 'home', 'my-kind'],
    ['not an object', 'a string', 'nope', 'home', 'my-kind'],
    ['bad kind', 'missing kind', { displayName: 'X', execution: 'session' }, 'home', 'my-kind'],
    ['bad kind', 'uppercase kind', { ...VALID_SESSION, kind: 'MyKind' }, 'home', 'MyKind'],
    ['bad kind', 'traversal-shaped kind', { ...VALID_SESSION, kind: '../evil' }, 'home', '../evil'],
    ['kind mismatch', 'kind !== filename stem', VALID_SESSION, 'home', 'other-name'],
    [
      'displayName',
      'missing displayName',
      { kind: 'my-kind', execution: 'session' },
      'home',
      'my-kind',
    ],
    [
      'displayName',
      'blank displayName',
      { ...VALID_SESSION, displayName: '   ' },
      'home',
      'my-kind',
    ],
    ['execution', 'missing execution', { kind: 'my-kind', displayName: 'X' }, 'home', 'my-kind'],
    ['execution', 'unknown execution', { ...VALID_SESSION, execution: 'batch' }, 'home', 'my-kind'],
    [
      'home tier',
      'home-tier task rejected',
      { ...VALID_SESSION, execution: 'task' },
      'home',
      'my-kind',
    ],
    [
      'home tier',
      'home-tier chat rejected',
      { ...VALID_SESSION, execution: 'chat' },
      'home',
      'my-kind',
    ],
    [
      'plugin tier',
      'plugin-tier task rejected',
      { ...VALID_SESSION, execution: 'task' },
      'plugin',
      'my-kind',
    ],
    [
      'plugin tier',
      'plugin-tier chat rejected',
      { ...VALID_SESSION, execution: 'chat' },
      'plugin',
      'my-kind',
    ],
    [
      'schema',
      'invalid config schema',
      { ...VALID_SESSION, config: { type: 'not-a-type' } },
      'home',
      'my-kind',
    ],
    [
      'schema',
      'invalid output schema',
      { ...VALID_SESSION, output: { type: 'not-a-type' } },
      'home',
      'my-kind',
    ],
    [
      'cron',
      'invalid defaultCron',
      { ...VALID_SESSION, defaultCron: 'not a cron' },
      'home',
      'my-kind',
    ],
    ['prompt', 'non-string prompt', { ...VALID_SESSION, prompt: 42 }, 'home', 'my-kind'],
    [
      'handler',
      'builtin task kind with no registered handler',
      { kind: 'no-handler-kind', displayName: 'X', execution: 'task' },
      'builtin',
      'no-handler-kind',
    ],
  ])('rejects [%s] %s', (_group, _label, data, tier, expectedKind) => {
    const r = checkPresetShape(data, tier as 'builtin' | 'home' | 'plugin', expectedKind as string);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(typeof r.error).toBe('string');
  });

  it('accepts a builtin task preset when a code handler is registered', () => {
    const r = checkPresetShape(
      { kind: 'doc-drift', displayName: 'Doc Drift', execution: 'task' },
      'builtin',
      'doc-drift',
    );
    expect(r.ok).toBe(true);
  });
});

describe('shipped presets', () => {
  beforeEach(() => {
    // Point the manifest at a file that never exists so this describe block
    // is hermetic regardless of whatever real `~/.octomux/octomux.yml` (if
    // any) exists on the machine running the tests.
    vi.stubEnv('OCTOMUX_PLUGIN_MANIFEST', path.join(os.tmpdir(), 'octomux-no-such-manifest.yml'));
    reloadPresets();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('loads all seven shipped kinds', () => {
    const kinds = listPresets()
      .map((p) => p.kind)
      .sort();
    expect(kinds).toEqual(
      [
        'custom',
        'daily-plan',
        'doc-drift',
        'overnight-log-summary',
        'prod-log-triage',
        'slack-watcher',
        'weekly-update',
      ].sort(),
    );
  });

  it('declares the expected execution per kind', () => {
    const byKind = new Map(listPresets().map((p) => [p.kind, p.execution]));
    expect(byKind.get('doc-drift')).toBe('task');
    expect(byKind.get('prod-log-triage')).toBe('task');
    expect(byKind.get('daily-plan')).toBe('chat');
    expect(byKind.get('weekly-update')).toBe('session');
    expect(byKind.get('overnight-log-summary')).toBe('session');
    expect(byKind.get('slack-watcher')).toBe('session');
    expect(byKind.get('custom')).toBe('session');
  });

  it('ships a non-empty prompt for every kind except custom', () => {
    for (const p of listPresets()) {
      if (p.kind === 'custom') {
        expect(p.prompt ?? '').toBe('');
      } else {
        expect(p.prompt && p.prompt.length > 100).toBe(true);
      }
    }
  });

  it('marks every shipped preset as the builtin tier', () => {
    expect(listPresets().every((p) => p.source === 'builtin')).toBe(true);
  });

  it('listCronWorkflowKinds equals the preset set', () => {
    expect(listCronWorkflowKinds().sort()).toEqual(
      listPresets()
        .map((p) => p.kind)
        .sort(),
    );
  });
});

describe('home tier', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-kinds-'));
    vi.stubEnv('OCTOMUX_KINDS_DIR', tmpDir);
    vi.stubEnv('OCTOMUX_PLUGIN_MANIFEST', path.join(os.tmpdir(), 'octomux-no-such-manifest.yml'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    reloadPresets();
  });

  function writeKind(name: string, body: unknown): void {
    fs.writeFileSync(path.join(tmpDir, `${name}.json`), JSON.stringify(body), 'utf-8');
  }

  it('adds a home-only kind alongside the shipped ones', () => {
    writeKind('release-notes', {
      kind: 'release-notes',
      displayName: 'Release Notes',
      execution: 'session',
      prompt: 'summarize the release',
    });

    const presets = loadPresets();
    const added = presets.get('release-notes');
    expect(added).toBeDefined();
    expect(added!.source).toBe('home');
    expect(presets.get('weekly-update')).toBeDefined();
  });

  it('home overrides a shipped kind of the same name', () => {
    writeKind('weekly-update', {
      kind: 'weekly-update',
      displayName: 'My Weekly Update',
      execution: 'session',
      prompt: 'my own body',
    });

    const p = loadPresets().get('weekly-update');
    expect(p!.source).toBe('home');
    expect(p!.displayName).toBe('My Weekly Update');
    expect(p!.prompt).toBe('my own body');
  });

  it('skips malformed JSON without throwing, keeping the other kinds', () => {
    fs.writeFileSync(path.join(tmpDir, 'broken.json'), '{ not json', 'utf-8');

    expect(() => loadPresets()).not.toThrow();
    const presets = loadPresets();
    expect(presets.get('broken')).toBeUndefined();
    expect(presets.get('weekly-update')).toBeDefined();
  });

  it.each([
    [
      'filename/kind mismatch',
      'mismatch',
      { kind: 'other', displayName: 'X', execution: 'session' },
    ],
    [
      'home-tier task execution',
      'sneaky-task',
      { kind: 'sneaky-task', displayName: 'X', execution: 'task' },
    ],
    [
      'invalid config schema',
      'bad-schema',
      {
        kind: 'bad-schema',
        displayName: 'X',
        execution: 'session',
        config: { type: 'not-a-type' },
      },
    ],
  ])('skips a home preset with %s without throwing', (_label, file, body) => {
    writeKind(file, body);

    expect(() => loadPresets()).not.toThrow();
    expect(loadPresets().get(file)).toBeUndefined();
    expect(loadPresets().get('weekly-update')).toBeDefined();
  });
});

describe('plugin tier', () => {
  let tmpDir: string;
  let homeDir: string;
  let manifestFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-plugin-prefix-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-kinds-'));
    manifestFile = path.join(tmpDir, 'octomux.yml');
    vi.stubEnv('OCTOMUX_PLUGIN_PREFIX', tmpDir);
    vi.stubEnv('OCTOMUX_PLUGIN_MANIFEST', manifestFile);
    vi.stubEnv('OCTOMUX_KINDS_DIR', homeDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    reloadPresets();
  });

  function writePluginKind(pkg: string, name: string, body: unknown): void {
    const dir = path.join(tmpDir, 'node_modules', pkg, 'kinds');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body), 'utf-8');
  }

  function writeHomeKind(name: string, body: unknown): void {
    fs.writeFileSync(path.join(homeDir, `${name}.json`), JSON.stringify(body), 'utf-8');
  }

  // The plugin tier is gated on the manifest, not a directory listing — a row
  // is required, `id: name` unless a test needs them to differ.
  function writeManifest(rows: Array<{ id: string; name: string; disabled?: boolean }>): void {
    const lines = ['plugins:'];
    for (const r of rows) {
      lines.push(`  - id: ${r.id}`);
      // quoted: `@` and `/` are YAML-significant unquoted (scoped package
      // names, absolute paths) — quoting matches how a real manifest author
      // would write these.
      lines.push(`    name: ${JSON.stringify(r.name)}`);
      if (r.disabled) lines.push(`    disabled: true`);
    }
    fs.writeFileSync(manifestFile, lines.join('\n') + '\n', 'utf-8');
  }

  it('registers a kind from a plugin dir, qualified to <id>:<kind>', () => {
    writePluginKind('demo', 'changelog', {
      kind: 'changelog',
      displayName: 'Changelog',
      execution: 'session',
      prompt: 'summarize the changelog',
    });
    writeManifest([{ id: 'demo', name: 'demo' }]);

    const presets = loadPresets();
    const added = presets.get('demo:changelog');
    expect(added).toBeDefined();
    expect(added!.source).toBe('plugin');
    expect(added!.kind).toBe('demo:changelog');
    // the bare, unqualified form never appears in the map
    expect(presets.get('changelog')).toBeUndefined();
  });

  it('coexists with built-in and home tiers at once (precedence across all three)', () => {
    writeHomeKind('weekly-update', {
      kind: 'weekly-update',
      displayName: 'My Weekly Update',
      execution: 'session',
      prompt: 'my own body',
    });
    writePluginKind('demo', 'changelog', {
      kind: 'changelog',
      displayName: 'Changelog',
      execution: 'session',
    });
    writeManifest([{ id: 'demo', name: 'demo' }]);

    const presets = loadPresets();
    expect(presets.get('weekly-update')!.source).toBe('home'); // home still wins
    expect(presets.get('demo:changelog')!.source).toBe('plugin');
    expect(presets.get('doc-drift')!.source).toBe('builtin'); // untouched built-in
  });

  it('skips malformed plugin JSON with a warn, keeping other plugin kinds', () => {
    const dir = path.join(tmpDir, 'node_modules', 'demo', 'kinds');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json', 'utf-8');
    writePluginKind('demo', 'changelog', {
      kind: 'changelog',
      displayName: 'Changelog',
      execution: 'session',
    });
    writeManifest([{ id: 'demo', name: 'demo' }]);

    expect(() => loadPresets()).not.toThrow();
    const presets = loadPresets();
    expect(presets.get('demo:broken')).toBeUndefined();
    expect(presets.get('demo:changelog')).toBeDefined();
  });

  it('skips a plugin kind whose filename does not match its declared kind', () => {
    writePluginKind('demo', 'mismatch', { kind: 'other', displayName: 'X', execution: 'session' });
    writeManifest([{ id: 'demo', name: 'demo' }]);

    expect(() => loadPresets()).not.toThrow();
    expect(loadPresets().get('demo:other')).toBeUndefined();
  });

  it('cannot shadow a built-in id — qualification namespaces it away', () => {
    // same bare kind as a shipped built-in preset
    writePluginKind('demo', 'weekly-update', {
      kind: 'weekly-update',
      displayName: 'Fake Weekly Update',
      execution: 'session',
    });
    writeManifest([{ id: 'demo', name: 'demo' }]);

    const presets = loadPresets();
    expect(presets.get('weekly-update')!.source).toBe('builtin');
    expect(presets.get('weekly-update')!.displayName).not.toBe('Fake Weekly Update');
    expect(presets.get('demo:weekly-update')!.source).toBe('plugin');
    expect(presets.get('demo:weekly-update')!.displayName).toBe('Fake Weekly Update');
  });

  // --- manifest gate (the plugin tier no longer trusts a directory listing) ---

  it('a plugin directory on disk with no manifest row contributes nothing', () => {
    // no writeManifest() call at all — an installed-but-unlisted package
    // (or an npm-hoisted transitive dependency that happens to ship a
    // `kinds/` dir) must not be scanned just because it exists on disk.
    writePluginKind('demo', 'changelog', {
      kind: 'changelog',
      displayName: 'Changelog',
      execution: 'session',
    });

    const presets = loadPresets();
    expect(presets.get('demo:changelog')).toBeUndefined();
  });

  it('a manifest row marked disabled contributes nothing', () => {
    writePluginKind('demo', 'changelog', {
      kind: 'changelog',
      displayName: 'Changelog',
      execution: 'session',
    });
    writeManifest([{ id: 'demo', name: 'demo', disabled: true }]);

    const presets = loadPresets();
    expect(presets.get('demo:changelog')).toBeUndefined();
  });

  it('a manifest that fails to parse yields zero plugins, never a boot crash', () => {
    writePluginKind('demo', 'changelog', {
      kind: 'changelog',
      displayName: 'Changelog',
      execution: 'session',
    });
    fs.writeFileSync(manifestFile, 'plugins: not-an-array\n', 'utf-8');

    expect(() => loadPresets()).not.toThrow();
    const presets = loadPresets();
    expect(presets.get('demo:changelog')).toBeUndefined();
    expect(presets.get('doc-drift')!.source).toBe('builtin'); // built-in tier unaffected
  });

  it('a scoped package name resolves two directory levels deep', () => {
    const dir = path.join(tmpDir, 'node_modules', '@scope', 'demo', 'kinds');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'changelog.json'),
      JSON.stringify({ kind: 'changelog', displayName: 'Changelog', execution: 'session' }),
      'utf-8',
    );
    writeManifest([{ id: 'scoped', name: '@scope/demo' }]);

    const presets = loadPresets();
    expect(presets.get('scoped:changelog')).toBeDefined();
    expect(presets.get('scoped:changelog')!.source).toBe('plugin');
  });

  it('a symlinked package directory (npm link / pnpm) is still scanned', () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-plugin-real-'));
    fs.mkdirSync(path.join(realDir, 'kinds'), { recursive: true });
    fs.writeFileSync(
      path.join(realDir, 'kinds', 'changelog.json'),
      JSON.stringify({ kind: 'changelog', displayName: 'Changelog', execution: 'session' }),
      'utf-8',
    );
    const modulesDir = path.join(tmpDir, 'node_modules');
    fs.mkdirSync(modulesDir, { recursive: true });
    fs.symlinkSync(realDir, path.join(modulesDir, 'demo'), 'dir');
    writeManifest([{ id: 'demo', name: 'demo' }]);

    try {
      const presets = loadPresets();
      expect(presets.get('demo:changelog')).toBeDefined();
    } finally {
      fs.rmSync(realDir, { recursive: true, force: true });
    }
  });

  it('an absolute-path row (dev loop) resolves outside pluginModulesDir', () => {
    const devDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-plugin-dev-'));
    fs.mkdirSync(path.join(devDir, 'kinds'), { recursive: true });
    fs.writeFileSync(
      path.join(devDir, 'kinds', 'changelog.json'),
      JSON.stringify({ kind: 'changelog', displayName: 'Changelog', execution: 'session' }),
      'utf-8',
    );
    writeManifest([{ id: 'devplugin', name: devDir }]);

    try {
      const presets = loadPresets();
      expect(presets.get('devplugin:changelog')).toBeDefined();
      expect(presets.get('devplugin:changelog')!.source).toBe('plugin');
    } finally {
      fs.rmSync(devDir, { recursive: true, force: true });
    }
  });
});
