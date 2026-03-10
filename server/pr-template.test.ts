import { describe, it, expect } from 'vitest';
import { buildPRPrompt, type PRPromptContext } from './pr-template.js';

describe('buildPRPrompt', () => {
  const baseContext: PRPromptContext = {
    taskTitle: 'Fix order validation',
    taskDescription: 'Add negative quantity checks',
    commitLog: 'abc1234 fix: validate order quantities',
    diffStats: ' src/orders.ts | 10 +++++\n 1 file changed, 10 insertions(+)',
  };

  // ─── Required content (table-driven) ──────────────────────────────────────

  const contentCases = [
    { name: 'task title', expected: 'Task: Fix order validation' },
    { name: 'task description', expected: 'Description: Add negative quantity checks' },
    { name: 'commit log', expected: 'abc1234 fix: validate order quantities' },
    { name: 'diff stats', expected: 'src/orders.ts | 10 +++++' },
    { name: 'Conventional Commits', expected: 'Conventional Commits' },
    { name: 'commit types', expected: 'feat, fix, refactor, test, docs, chore' },
    { name: 'JSON output format', expected: 'Return ONLY valid JSON' },
    { name: 'title key', expected: '"title"' },
    { name: 'body key', expected: '"body"' },
  ];

  it.each(contentCases)('includes $name', ({ expected }) => {
    const prompt = buildPRPrompt(baseContext);
    expect(prompt).toContain(expected);
  });

  // ─── PR body sections (table-driven) ──────────────────────────────────────

  const requiredSections = ['## What', '## Why', '## Testing'];

  it.each(requiredSections)('includes PR body section "%s"', (section) => {
    const prompt = buildPRPrompt(baseContext);
    expect(prompt).toContain(section);
  });

  // ─── Edge cases ───────────────────────────────────────────────────────────

  it('handles multi-line commit logs', () => {
    const context: PRPromptContext = {
      ...baseContext,
      commitLog: 'abc1234 feat: add login\ndef5678 fix: handle edge case\nghi9012 test: add tests',
    };
    const prompt = buildPRPrompt(context);
    expect(prompt).toContain('abc1234 feat: add login');
    expect(prompt).toContain('ghi9012 test: add tests');
  });

  it('handles empty commit log and diff stats', () => {
    const context: PRPromptContext = {
      ...baseContext,
      commitLog: '',
      diffStats: '',
    };
    const prompt = buildPRPrompt(context);
    expect(prompt).toContain('Commits:\n\n');
    expect(prompt).toContain('File changes:\n\n');
  });
});
