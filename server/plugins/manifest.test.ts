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
