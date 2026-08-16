import { describe, it, expect } from '../bun-test.js';
import { repoBasename } from './utils';

describe('repoBasename', () => {
  it.each([
    ['/Users/dev/projects/my-repo', 'my-repo'],
    ['/Users/dev/projects/my-repo/', 'my-repo'],
    ['/single', 'single'],
    ['no-slashes', 'no-slashes'],
    ['', ''],
    ['/', '/'],
  ])('repoBasename(%s) === %s', (input, expected) => {
    expect(repoBasename(input)).toBe(expected);
  });
});
