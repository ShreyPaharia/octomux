import { describe, it, expect } from 'vitest';
import { interpolatePrompt } from './prompt-interpolate.js';

describe('interpolatePrompt', () => {
  it.each([
    // [description, body, vars, expected]
    ['replaces a string scalar', 'Hello, {{name}}!', { name: 'World' }, 'Hello, World!'],
    ['replaces a number', 'Count: {{count}}', { count: 42 }, 'Count: 42'],
    ['replaces a boolean true', 'Flag: {{ok}}', { ok: true }, 'Flag: true'],
    ['replaces a boolean false', 'Flag: {{ok}}', { ok: false }, 'Flag: false'],
    ['stringifies null', 'Value: {{v}}', { v: null as unknown as string }, 'Value: null'],
    [
      'stringifies an object via JSON.stringify',
      'Config: {{cfg}}',
      { cfg: { a: 1 } },
      'Config: {"a":1}',
    ],
    [
      'stringifies an array via JSON.stringify',
      'Items: {{list}}',
      { list: [1, 2, 3] },
      'Items: [1,2,3]',
    ],
    [
      'leaves unknown placeholder intact',
      'Hello, {{name}} and {{unknown}}!',
      { name: 'World' },
      'Hello, World and {{unknown}}!',
    ],
    [
      'replaces repeated occurrences of the same key',
      '{{x}} + {{x}} = two {{x}}',
      { x: 'foo' },
      'foo + foo = two foo',
    ],
    ['empty vars — all placeholders remain', 'Hello {{a}} and {{b}}', {}, 'Hello {{a}} and {{b}}'],
    [
      'no placeholders — body unchanged',
      'Plain text, no interpolation',
      { a: 'ignored' },
      'Plain text, no interpolation',
    ],
    [
      'single pass — var containing a placeholder stays literal',
      '{{a}}',
      { a: '{{b}}', b: 'X' },
      '{{b}}',
    ],
    [
      'single pass — nested reference in output not expanded',
      'start {{a}} end',
      { a: '{{b}}', b: 'SHOULD_NOT_APPEAR' },
      'start {{b}} end',
    ],
    [
      'key with underscores and digits is matched',
      '{{repo_path_1}}',
      { repo_path_1: '/home/repo' },
      '/home/repo',
    ],
  ] as const)(
    '%s',
    (_desc: string, body: string, vars: Record<string, unknown>, expected: string) => {
      expect(interpolatePrompt(body, vars)).toBe(expected);
    },
  );
});
