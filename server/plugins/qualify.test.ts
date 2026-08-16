import { describe, it, expect } from '../bun-test.js';
import { KIND_NAME_RE, QUALIFIED_KIND_RE, sanitizePackageName, qualify } from './qualify.js';

describe('sanitizePackageName', () => {
  it.each([
    ['@foo/bar', 'foo-bar'],
    ['@octomux/plugin-demo', 'octomux-plugin-demo'],
    ['octomux-plugin-x', 'octomux-plugin-x'],
    ['demo', 'demo'],
  ])('%s -> %s', (input, expected) => {
    expect(sanitizePackageName(input)).toBe(expected);
  });
});

describe('qualify', () => {
  it('joins a bare plugin id and local id with a colon', () => {
    expect(qualify('demo', 'changelog')).toBe('demo:changelog');
  });

  it('sanitizes a scoped package name before qualifying', () => {
    expect(qualify('@foo/bar', 'changelog')).toBe('foo-bar:changelog');
  });

  it.each([
    ['uppercase plugin id', 'Demo', 'changelog'],
    ['uppercase local id', 'demo', 'Changelog'],
    ['traversal-shaped plugin id', '../evil', 'changelog'],
    ['traversal-shaped local id', 'demo', '../evil'],
    ['empty plugin id', '', 'changelog'],
    ['empty local id', 'demo', ''],
  ])('throws on %s', (_label, pluginId, localId) => {
    expect(() => qualify(pluginId, localId)).toThrow();
  });

  it('never produces a string KIND_NAME_RE accepts', () => {
    const qualified = qualify('demo', 'changelog');
    expect(QUALIFIED_KIND_RE.test(qualified)).toBe(true);
    expect(KIND_NAME_RE.test(qualified)).toBe(false);
  });

  it('a scoped-then-sanitized qualification also never matches KIND_NAME_RE', () => {
    const qualified = qualify('@foo/bar', 'changelog');
    expect(QUALIFIED_KIND_RE.test(qualified)).toBe(true);
    expect(KIND_NAME_RE.test(qualified)).toBe(false);
  });

  it('rejects a namespace-squat attempt (a local id that embeds another qualifier)', () => {
    // `other:kind` fails KIND_NAME_RE (no `:` allowed), so this can never
    // produce `demo:other:kind` and pretend to be plugin "other"'s kind.
    expect(() => qualify('demo', 'other:kind')).toThrow();
  });
});
