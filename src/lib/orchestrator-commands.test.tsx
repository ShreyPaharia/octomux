import { describe, it, expect } from 'vitest';
import { filterCommands, COMMANDS } from './orchestrator-commands';

describe('filterCommands', () => {
  it('returns all commands for empty query', () => {
    expect(filterCommands('')).toEqual(COMMANDS);
  });

  it('filters by prefix', () => {
    const result = filterCommands('cr');
    expect(result.map((c) => c.slash)).toEqual(['/create-task', '/create-pr']);
  });

  it('returns empty for no match', () => {
    expect(filterCommands('xyz')).toEqual([]);
  });
});

describe('buildMessage', () => {
  it('list-tasks builds message without values', () => {
    const cmd = COMMANDS.find((c) => c.slash === '/list-tasks')!;
    expect(cmd.buildMessage({})).toBe('Show me all running tasks');
  });

  it('create-task builds message from field values', () => {
    const cmd = COMMANDS.find((c) => c.slash === '/create-task')!;
    const msg = cmd.buildMessage({
      title: 'Fix bug',
      repo: '/tmp/repo',
      baseBranch: 'main',
      description: 'Fix the login bug',
      prompt: 'Please fix the login validation',
    });
    expect(msg).toContain('Fix bug');
    expect(msg).toContain('/tmp/repo');
    expect(msg).toContain('main');
    expect(msg).toContain('Fix the login bug');
    expect(msg).toContain('Please fix the login validation');
  });

  it('create-task handles missing optional fields without undefined', () => {
    const cmd = COMMANDS.find((c) => c.slash === '/create-task')!;
    const msg = cmd.buildMessage({
      title: 'Fix bug',
      repo: '/tmp/repo',
    });
    expect(msg).not.toContain('undefined');
    expect(msg).toContain('Fix bug');
    expect(msg).toContain('/tmp/repo');
  });
});
