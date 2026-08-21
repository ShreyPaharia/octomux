import { describe, it, expect, afterEach } from '../bun-test.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseManifest, readManifest } from './manifest.js';

describe('parseManifest', () => {
  it('parses an empty document as no plugins', () => {
    expect(parseManifest('')).toEqual({ plugins: [] });
  });

  it('parses a document with no "plugins" key as no plugins', () => {
    expect(parseManifest('{}\n')).toEqual({ plugins: [] });
  });

  it('parses a minimal valid row', () => {
    const m = parseManifest(`
plugins:
  - id: demo
    name: octomux-plugin-demo
`);
    expect(m.plugins).toEqual([{ id: 'demo', name: 'octomux-plugin-demo' }]);
  });

  it('carries optional fields through', () => {
    const m = parseManifest(`
plugins:
  - id: demo
    name: octomux-plugin-demo
    version: 1.2.3
    integrity: sha512-abc
    config:
      foo: bar
    disabled: true
`);
    expect(m.plugins).toEqual([
      {
        id: 'demo',
        name: 'octomux-plugin-demo',
        version: '1.2.3',
        integrity: 'sha512-abc',
        config: { foo: 'bar' },
        disabled: true,
      },
    ]);
  });

  it('marks disabled rows as disabled without dropping them', () => {
    const m = parseManifest(`
plugins:
  - id: demo
    name: octomux-plugin-demo
    disabled: true
`);
    expect(m.plugins).toHaveLength(1);
    expect(m.plugins[0].disabled).toBe(true);
  });

  it.each([
    ['unknown top-level key', 'plugins: []\nextra: true\n'],
    [
      'duplicate row id',
      `
plugins:
  - id: demo
    name: pkg-a
  - id: demo
    name: pkg-b
`,
    ],
    [
      'id fails KIND_NAME_RE (uppercase)',
      `
plugins:
  - id: Demo
    name: octomux-plugin-demo
`,
    ],
    [
      'id fails KIND_NAME_RE (traversal-shaped)',
      `
plugins:
  - id: ../evil
    name: octomux-plugin-demo
`,
    ],
    [
      'row missing name',
      `
plugins:
  - id: demo
`,
    ],
    [
      'row with blank name',
      `
plugins:
  - id: demo
    name: "   "
`,
    ],
    [
      'row is not an object',
      `
plugins:
  - "just a string"
`,
    ],
    ['plugins is not an array', 'plugins: not-an-array\n'],
    ['top level is not an object', '- a\n- b\n'],
    [
      'row has an unknown key',
      `
plugins:
  - id: demo
    name: octomux-plugin-demo
    mystery: 1
`,
    ],
  ])('rejects: %s', (_label, text) => {
    expect(() => parseManifest(text)).toThrow();
  });

  // dsh postmortem 0002: an uninterpolated YAML tag/expression node (e.g.
  // `!!js/function`) resolved truthy and silently disabled a whole tool stack.
  // JSON_SCHEMA has no custom-tag resolvers, so any tag must throw, never parse.
  it('rejects a YAML tag/expression node instead of silently resolving it', () => {
    const text = `
plugins:
  - id: demo
    name: octomux-plugin-demo
    disabled: !!js/function >
      function(){ return true }
`;
    expect(() => parseManifest(text)).toThrow();
  });

  // `import()` natively resolves data:/http(s):/file: URLs — a `name` shaped
  // like one of these is direct code execution once the STEP-2 loader imports
  // it. Only an npm package name or an absolute path may pass.
  it.each([
    ['a data: URL', 'data:text/javascript,globalThis.pwned=1'],
    ['an http: URL', 'http://evil/x.js'],
    ['a file: URL', 'file:///tmp/evil.js'],
    ['a relative traversal path', '../../../etc/passwd'],
    ['an embedded NUL', 'x\0y'],
  ])('rejects a plugin name that is %s', (_label, name) => {
    const text = `
plugins:
  - id: demo
    name: ${JSON.stringify(name)}
`;
    expect(() => parseManifest(text)).toThrow();
  });

  it.each([
    ['an unscoped npm package name', 'octomux-plugin-demo'],
    ['a scoped npm package name', '@octomux/plugin-demo'],
    ['an absolute path', '/Users/dev/my-plugin'],
  ])('accepts a plugin name that is %s', (_label, name) => {
    const text = `
plugins:
  - id: demo
    name: ${JSON.stringify(name)}
`;
    expect(() => parseManifest(text)).not.toThrow();
  });

  // js-yaml has no `maxAliasCount`. A short anchor/alias chain shares object
  // references during parsing itself (cheap), but blows up to tens of MB the
  // moment anything downstream walks or serializes the tree — so this must be
  // rejected before `yaml.load` runs at all, not measured after the fact.
  // This fixture is intentionally tiny (no exponential allocation happens here
  // — the assertion is that it's rejected, never that it OOMs).
  it('rejects a YAML anchor/alias bomb before parsing it', () => {
    const text = `
plugins:
  - id: demo
    name: octomux-plugin-demo
    config:
      a: &a ["x","x","x","x","x","x","x","x","x"]
      b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
      c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
      d: [*c,*c,*c,*c,*c,*c,*c,*c,*c]
`;
    expect(() => parseManifest(text)).toThrow();
  });

  it('rejects a bare anchor definition with no alias use at all', () => {
    const text = `
plugins:
  - id: demo
    name: octomux-plugin-demo
    config:
      a: &anchor
        foo: bar
`;
    expect(() => parseManifest(text)).toThrow();
  });

  it('does not false-positive on `&`/`*` inside a quoted scalar', () => {
    const text = `
plugins:
  - id: demo
    name: octomux-plugin-demo
    config:
      pattern: "*.ts"
      company: "Foo & Bar"
`;
    expect(() => parseManifest(text)).not.toThrow();
  });

  // §Fix 6 negative tests: hostile YAML mapping shapes.
  it('does not let a `__proto__` key pollute the prototype', () => {
    const text = `
plugins:
  - id: demo
    name: octomux-plugin-demo
    config:
      __proto__:
        polluted: true
`;
    const m = parseManifest(text);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(m.plugins[0].config).toBeDefined();
  });

  it('rejects duplicate mapping keys within a row', () => {
    const text = `
plugins:
  - id: demo
    name: octomux-plugin-demo
    name: octomux-plugin-other
`;
    expect(() => parseManifest(text)).toThrow();
  });

  it('rejects a row using a YAML merge key (`<<:`) — unknown key, not merged', () => {
    const text = `
plugins:
  - id: demo
    name: octomux-plugin-demo
    <<: { version: "1.0.0" }
`;
    expect(() => parseManifest(text)).toThrow();
  });
});

describe('grants', () => {
  it.each([
    ['a single valid capability', ['http.route'], ['http.route']],
    [
      'multiple valid capabilities',
      ['http.route', 'ui.panel', 'policy.intercept'],
      ['http.route', 'ui.panel', 'policy.intercept'],
    ],
    [
      'collections.define and collections.write (SHR-275)',
      ['collections.define', 'collections.write'],
      ['collections.define', 'collections.write'],
    ],
    ['an empty list', [], []],
    ['duplicates, de-duped silently', ['http.route', 'http.route'], ['http.route']],
  ])('accepts %s', (_label, grants, expected) => {
    const text = `
plugins:
  - id: demo
    name: octomux-plugin-demo
    grants: ${JSON.stringify(grants)}
`;
    const m = parseManifest(text);
    expect(m.plugins[0].grants).toEqual(expected);
  });

  it('omits the "grants" key entirely when the row declares none', () => {
    const m = parseManifest(`
plugins:
  - id: demo
    name: octomux-plugin-demo
`);
    expect(m.plugins[0].grants).toBeUndefined();
  });

  it.each([
    ['an unknown capability', '["policy.deny"]'],
    ['a typo of a real capability', '["http.routes"]'],
    ['a typo of collections.write ("collections.put")', '["collections.put"]'],
    ['a non-array (string)', '"http.route"'],
    ['a non-array (object)', '{}'],
    ['an array with a non-string entry', '[42]'],
    ['an array with a mixed valid/invalid entry', '["http.route", "nope.nope"]'],
  ])('rejects grants that are %s', (_label, grantsJson) => {
    const text = `
plugins:
  - id: demo
    name: octomux-plugin-demo
    grants: ${grantsJson}
`;
    expect(() => parseManifest(text)).toThrow();
  });

  it('names the offending capability and lists the valid ones on rejection', () => {
    const text = `
plugins:
  - id: demo
    name: octomux-plugin-demo
    grants: ["policy.deny"]
`;
    expect(() => parseManifest(text)).toThrow(/"policy\.deny"/);
    expect(() => parseManifest(text)).toThrow(/policy\.intercept/); // one of the valid names
  });
});

describe('readManifest', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty manifest when the file does not exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-manifest-'));
    const missing = path.join(tmpDir, 'does-not-exist.yml');
    expect(readManifest(missing)).toEqual({ plugins: [] });
  });

  it('reads and parses an existing manifest file', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-manifest-'));
    const file = path.join(tmpDir, 'octomux.yml');
    fs.writeFileSync(
      file,
      `
plugins:
  - id: demo
    name: octomux-plugin-demo
`,
      'utf-8',
    );
    expect(readManifest(file)).toEqual({
      plugins: [{ id: 'demo', name: 'octomux-plugin-demo' }],
    });
  });

  it('still throws for an existing file that fails to parse', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-manifest-'));
    const file = path.join(tmpDir, 'octomux.yml');
    fs.writeFileSync(file, 'plugins: not-an-array\n', 'utf-8');
    expect(() => readManifest(file)).toThrow();
  });
});
