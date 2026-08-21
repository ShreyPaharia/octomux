/**
 * server/artifact-files.test.ts
 *
 * Unit coverage for the `ctx.artifacts` file backend: write/list/read plus
 * the validation matrix at the plugin/name trust boundary. Pure fs, no
 * mocking needed — real temp dirs per test.
 */
import { describe, it, expect, beforeEach, afterEach } from './bun-test.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeArtifact, listArtifacts, readArtifact } from './artifact-files.js';

describe('artifact-files', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-artifact-files-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes, lists, and reads an artifact round trip with mime preserved verbatim', () => {
    const written = writeArtifact(tmpDir, 'coverage-bot', {
      name: 'report.md',
      mime: 'text/markdown',
      body: '# Coverage\n\n100%',
    });
    expect(written).toMatchObject({
      pluginId: 'coverage-bot',
      name: 'report.md',
      mime: 'text/markdown',
      size: Buffer.byteLength('# Coverage\n\n100%', 'utf8'),
    });
    expect(written.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const listed = listArtifacts(tmpDir);
    expect(listed).toEqual([written]);

    const read = readArtifact(tmpDir, 'coverage-bot', 'report.md');
    expect(read?.record).toEqual(written);
    expect(read?.body).toBe('# Coverage\n\n100%');
  });

  it('overwriting the same (pluginId, name) updates size/mime and keeps one entry', () => {
    writeArtifact(tmpDir, 'p1', { name: 'x.json', mime: 'application/json', body: '{"a":1}' });
    const second = writeArtifact(tmpDir, 'p1', {
      name: 'x.json',
      mime: 'application/json',
      body: '{"a":1,"b":2}',
    });

    const listed = listArtifacts(tmpDir);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(second);
    expect(listed[0].size).toBe(Buffer.byteLength('{"a":1,"b":2}', 'utf8'));
  });

  it('two plugins writing the same name do not collide', () => {
    writeArtifact(tmpDir, 'plugin-a', { name: 'report.md', mime: 'text/plain', body: 'from a' });
    writeArtifact(tmpDir, 'plugin-b', { name: 'report.md', mime: 'text/plain', body: 'from b' });

    const listed = listArtifacts(tmpDir);
    expect(listed).toHaveLength(2);
    expect(readArtifact(tmpDir, 'plugin-a', 'report.md')?.body).toBe('from a');
    expect(readArtifact(tmpDir, 'plugin-b', 'report.md')?.body).toBe('from b');
  });

  const longName = 'a'.repeat(200);
  const invalidSegments: Array<{ label: string; value: string }> = [
    { label: '..', value: '..' },
    { label: 'a/b', value: 'a/b' },
    { label: 'a\\b', value: 'a\\b' },
    { label: '.hidden', value: '.hidden' },
    { label: 'empty', value: '' },
    { label: '200-char name', value: longName },
  ];

  it.each(invalidSegments)('rejects invalid name shape: $label', ({ value }) => {
    expect(() =>
      writeArtifact(tmpDir, 'plugin-ok', { name: value, mime: 'text/plain', body: 'x' }),
    ).toThrow();
    // never created anything outside .octomux/artifacts
    const artifactsDir = path.join(tmpDir, '.octomux', 'artifacts');
    const walk = (dir: string): string[] => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
    };
    for (const f of walk(tmpDir)) {
      expect(f.startsWith(artifactsDir) || !fs.existsSync(f)).toBe(true);
    }
  });

  it.each(invalidSegments)('rejects invalid pluginId shape: $label', ({ value }) => {
    expect(() =>
      writeArtifact(tmpDir, value, { name: 'ok.txt', mime: 'text/plain', body: 'x' }),
    ).toThrow();
  });

  it.each([
    { label: 'no slash', mime: 'textplain' },
    { label: 'empty', mime: '' },
    { label: 'trailing slash', mime: 'text/' },
    { label: 'leading slash', mime: '/plain' },
  ])('rejects bad mime: $label', ({ mime }) => {
    expect(() => writeArtifact(tmpDir, 'p1', { name: 'ok.txt', mime, body: 'x' })).toThrow();
  });

  it('rejects a body over 5MB', () => {
    const big = 'x'.repeat(5 * 1024 * 1024 + 1);
    expect(() =>
      writeArtifact(tmpDir, 'p1', { name: 'big.txt', mime: 'text/plain', body: big }),
    ).toThrow();
  });

  it('accepts a body at exactly 5MB', () => {
    const exact = 'x'.repeat(5 * 1024 * 1024);
    expect(() =>
      writeArtifact(tmpDir, 'p1', { name: 'exact.txt', mime: 'text/plain', body: exact }),
    ).not.toThrow();
  });

  it('listArtifacts on a nonexistent worktree returns []', () => {
    expect(listArtifacts(path.join(tmpDir, 'does-not-exist'))).toEqual([]);
  });

  it('listArtifacts on a corrupt index.json returns []', () => {
    const dir = path.join(tmpDir, '.octomux', 'artifacts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.json'), 'not json{{{');
    expect(listArtifacts(tmpDir)).toEqual([]);
  });

  it('drops an index entry whose body file was deleted from list, and read returns null', () => {
    writeArtifact(tmpDir, 'p1', { name: 'gone.txt', mime: 'text/plain', body: 'bye' });
    fs.rmSync(path.join(tmpDir, '.octomux', 'artifacts', 'p1', 'gone.txt'));

    expect(listArtifacts(tmpDir)).toEqual([]);
    expect(readArtifact(tmpDir, 'p1', 'gone.txt')).toBeNull();
  });

  it('readArtifact returns null for an unknown (pluginId, name)', () => {
    expect(readArtifact(tmpDir, 'nope', 'nope.txt')).toBeNull();
  });
});
