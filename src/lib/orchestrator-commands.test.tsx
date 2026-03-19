import { describe, it, expect } from 'vitest';
import { filterCommands, findFirstPlaceholder, COMMANDS } from './orchestrator-commands';

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

describe('findFirstPlaceholder', () => {
  it('finds first bracketed placeholder', () => {
    const result = findFirstPlaceholder('Create task "[title]" in [repo]');
    expect(result).toEqual({ start: 13, end: 20 });
  });

  it('returns null when no placeholder', () => {
    expect(findFirstPlaceholder('Show me all running tasks')).toBeNull();
  });
});
