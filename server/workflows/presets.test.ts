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
    const r = checkPresetShape(data, tier as 'builtin' | 'home', expectedKind as string);
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
    reloadPresets();
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
