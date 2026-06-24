import { describe, expect, it } from 'vitest';
import {
  parseDiffRange,
  rangeIncludesWorkingTree,
  rangeNewRef,
  rangeNumstatArgs,
  rangeOldRef,
  WORKDIR,
} from './diff-range.js';
import type { DiffRange } from './types.js';

describe('parseDiffRange', () => {
  it.each([
    [undefined, { kind: 'base' }],
    ['', { kind: 'base' }],
    ['base', { kind: 'base' }],
    ['working', { kind: 'working' }],
    ['commit:abcd', { kind: 'commit', sha: 'abcd' }],
    [
      'commit:abcdef0123456789abcdef0123456789abcdef01',
      { kind: 'commit', sha: 'abcdef0123456789abcdef0123456789abcdef01' },
    ],
    ['range:main..feature', { kind: 'range', from: 'main', to: 'feature' }],
    ['range:abc1234..def5678', { kind: 'range', from: 'abc1234', to: 'def5678' }],
    ['range:origin/main..HEAD', { kind: 'range', from: 'origin/main', to: 'HEAD' }],
  ] as Array<[string | undefined, DiffRange]>)('parses %s', (input, expected) => {
    expect(parseDiffRange(input)).toEqual(expected);
  });

  it.each([
    ['commit:'],
    ['commit:not-hex'],
    ['commit:abc'], // too short (3 chars; min 4)
    ['range:'],
    ['range:foo'],
    ['range:..bar'],
    ['range:foo..'],
    ['range:a..b..c'],
    ['range:bad branch..ok'],
    ['unknown'],
    ['commitabc'],
  ])('rejects %s', (input) => {
    expect(() => parseDiffRange(input)).toThrow();
  });
});

describe('range helpers', () => {
  const baseSha = 'aaaaaaaa';

  it.each([
    [{ kind: 'base' as const }, baseSha],
    [{ kind: 'commit' as const, sha: 'feedface' }, 'feedface^'],
    [{ kind: 'range' as const, from: 'main', to: 'HEAD' }, 'main'],
    [{ kind: 'working' as const }, 'HEAD'],
  ])('rangeOldRef returns expected ref', (range, expected) => {
    expect(rangeOldRef(range, baseSha)).toBe(expected);
  });

  it.each([
    [{ kind: 'base' as const }, 'HEAD'],
    [{ kind: 'commit' as const, sha: 'feedface' }, 'feedface'],
    [{ kind: 'range' as const, from: 'main', to: 'topic' }, 'topic'],
    [{ kind: 'working' as const }, WORKDIR],
  ] as Array<[DiffRange, string]>)('rangeNewRef returns expected ref', (range, expected) => {
    expect(rangeNewRef(range)).toBe(expected);
  });

  it.each([
    [{ kind: 'base' as const }, [`${baseSha}...HEAD`]],
    [{ kind: 'commit' as const, sha: 'feedface' }, ['feedface^..feedface']],
    [{ kind: 'range' as const, from: 'a', to: 'b' }, ['a..b']],
    [{ kind: 'working' as const }, null],
  ] as Array<[DiffRange, string[] | null]>)(
    'rangeNumstatArgs returns expected args',
    (range, expected) => {
      expect(rangeNumstatArgs(range, baseSha)).toEqual(expected);
    },
  );

  it.each([
    [{ kind: 'base' as const }, true],
    [{ kind: 'working' as const }, true],
    [{ kind: 'commit' as const, sha: 'abcd' }, false],
    [{ kind: 'range' as const, from: 'a', to: 'b' }, false],
  ] as Array<[DiffRange, boolean]>)('rangeIncludesWorkingTree(%o) === %s', (range, expected) => {
    expect(rangeIncludesWorkingTree(range)).toBe(expected);
  });
});
