import { describe, it, expect } from 'vitest';
import { buildPRPrompt, type PRPromptContext } from './pr-template.js';

describe('buildPRPrompt', () => {
  const baseContext: PRPromptContext = {
    taskTitle: 'Fix order validation',
    taskDescription: 'Add negative quantity checks',
    commitLog: 'abc1234 fix: validate order quantities',
    diffStats: ' src/orders.ts | 10 +++++\n 1 file changed, 10 insertions(+)',
  };

  it('includes task title and description', () => {
    const prompt = buildPRPrompt(baseContext);
    expect(prompt).toContain('Task: Fix order validation');
    expect(prompt).toContain('Description: Add negative quantity checks');
  });

  it('includes commit log', () => {
    const prompt = buildPRPrompt(baseContext);
    expect(prompt).toContain('abc1234 fix: validate order quantities');
  });

  it('includes diff stats', () => {
    const prompt = buildPRPrompt(baseContext);
    expect(prompt).toContain('src/orders.ts | 10 +++++');
  });

  it('includes Conventional Commits requirement', () => {
    const prompt = buildPRPrompt(baseContext);
    expect(prompt).toContain('Conventional Commits');
    expect(prompt).toContain('feat, fix, refactor, test, docs, chore');
  });

  it('requests JSON output format', () => {
    const prompt = buildPRPrompt(baseContext);
    expect(prompt).toContain('Return ONLY valid JSON');
    expect(prompt).toContain('"title"');
    expect(prompt).toContain('"body"');
  });

  const requiredSections = ['## What', '## Why', '## Testing'];

  it.each(requiredSections)('includes PR body section "%s"', (section) => {
    const prompt = buildPRPrompt(baseContext);
    expect(prompt).toContain(section);
  });

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
