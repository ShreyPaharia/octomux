import { describe, it, expect } from 'vitest';
import { buildGroups, orderedPathsFromGroups, OTHER_GROUP_NAME } from '../review-file-groups';

describe('buildGroups', () => {
  it('orders files by walkthrough.groups then orphans', () => {
    const groups = buildGroups(
      ['a.ts', 'b.ts', 'c.ts'],
      {
        groups: [
          { name: 'Group A', files: [{ path: 'b.ts' }, { path: 'a.ts' }] },
        ],
      },
    );
    expect(groups.map((g) => g.name)).toEqual(['Group A', OTHER_GROUP_NAME]);
    expect(orderedPathsFromGroups(groups)).toEqual(['b.ts', 'a.ts', 'c.ts']);
  });

  it('drops walkthrough groups whose files are absent from the diff', () => {
    const groups = buildGroups(['a.ts'], {
      groups: [{ name: 'Empty', files: [{ path: 'x.ts' }] }],
    });
    expect(groups.map((g) => g.name)).toEqual([OTHER_GROUP_NAME]);
  });

  it('returns empty when no files', () => {
    expect(buildGroups([], null)).toEqual([]);
  });
});
