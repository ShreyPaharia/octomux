import { describe, it, expect } from '../bun-test.js';
import { validateAgentName, validateFlagString } from './types.js';
import type { Harness } from './types.js';
import claudeCodeDefault, { claudeCodeHarness } from './claude-code.js';
import cursorDefault, { cursorHarness } from './cursor.js';

// Type-level: fails `bun run typecheck` if either harness stops satisfying
// the widened `Harness` interface (new members are all optional, so nothing
// here should have needed a code change).
const _harnessesSatisfyInterface: Harness[] = [claudeCodeHarness, cursorHarness];
void _harnessesSatisfyInterface;

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

describe('Harness interface surface', () => {
  it.each([
    ['claude-code', claudeCodeHarness, claudeCodeDefault],
    ['cursor', cursorHarness, cursorDefault],
  ])('%s: default export is the same object as the named export', (_id, named, def) => {
    expect(def).toBe(named);
  });

  it.each([
    ['claude-code', claudeCodeHarness],
    ['cursor', cursorHarness],
  ])('%s: syncAgents is gone', (_id, harness) => {
    expect('syncAgents' in harness).toBe(false);
  });
});
