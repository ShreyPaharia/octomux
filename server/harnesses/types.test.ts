import { describe, it, expect } from 'vitest';
import { validateAgentName, validateFlagString } from './types.js';

describe('validateAgentName', () => {
  it.each([
    ['orchestrator', 'orchestrator'],
    ['plan-week', 'plan-week'],
    ['Agent_42', 'Agent_42'],
  ])('accepts %s', (input, expected) => {
    expect(validateAgentName(input)).toBe(expected);
  });

  it.each(['', 'has space', 'foo;rm -rf /', '../../../etc', 'a'.repeat(65), '$(whoami)'])(
    'rejects %s',
    (input) => {
      expect(() => validateAgentName(input)).toThrow(/Invalid agent name/);
    },
  );
});

describe('validateFlagString', () => {
  it.each(['', '--verbose', '--model claude-opus-4-7', "--prompt 'hello world'"])(
    'accepts %s',
    (input) => {
      expect(validateFlagString(input, 'flags')).toBe(input.trim());
    },
  );

  it.each([
    '`whoami`',
    '$(whoami)',
    '--verbose; rm -rf /',
    '| cat',
    '&& evil',
    '> /etc/passwd',
    'foo\nbar',
    "--unbalanced 'quote",
  ])('rejects %s', (input) => {
    expect(() => validateFlagString(input, 'flags')).toThrow(/Invalid flags/);
  });
});
