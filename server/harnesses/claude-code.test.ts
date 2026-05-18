import { describe, it, expect } from 'vitest';
import { claudeCodeHarness } from './claude-code.js';

describe('claudeCodeHarness', () => {
  it('has stable id and display name', () => {
    expect(claudeCodeHarness.id).toBe('claude-code');
    expect(claudeCodeHarness.displayName).toBe('Claude Code');
    expect(claudeCodeHarness.sessionIdMode).toBe('orchestrator-assigned');
  });

  it('newSessionId returns a UUID', () => {
    const id = claudeCodeHarness.newSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  describe('buildLaunchCommand', () => {
    it.each([
      [{ sessionId: 's1' }, 'claude --session-id s1'],
      [{ sessionId: 's1', agent: null }, 'claude --session-id s1'],
      [{ sessionId: 's1', agent: 'orchestrator' }, 'claude --agent orchestrator --session-id s1'],
      [{ sessionId: 's1', flags: ' --verbose' }, 'claude --session-id s1 --verbose'],
      [
        { sessionId: 's1', agent: 'planner', flags: ' --verbose' },
        'claude --agent planner --session-id s1 --verbose',
      ],
    ])('builds %j -> %s', (opts, expected) => {
      expect(claudeCodeHarness.buildLaunchCommand(opts)).toBe(expected);
    });

    it('rejects bad agent names', () => {
      expect(() =>
        claudeCodeHarness.buildLaunchCommand({ sessionId: 's1', agent: 'evil; rm' }),
      ).toThrow(/Invalid agent name/);
    });
  });

  describe('buildResumeCommand', () => {
    it.each([
      [{ sessionId: 's1' }, 'claude --resume s1'],
      [{ sessionId: 's1', flags: ' --verbose' }, 'claude --resume s1 --verbose'],
    ])('builds %j -> %s', (opts, expected) => {
      expect(claudeCodeHarness.buildResumeCommand(opts)).toBe(expected);
    });
  });

  describe('buildContinueCommand', () => {
    it('builds with --continue and a fresh session id', () => {
      expect(claudeCodeHarness.buildContinueCommand({ sessionId: 's1' })).toBe(
        'claude --continue --session-id s1',
      );
    });

    it('appends flags', () => {
      expect(claudeCodeHarness.buildContinueCommand({ sessionId: 's1', flags: ' --verbose' })).toBe(
        'claude --continue --session-id s1 --verbose',
      );
    });
  });
});
