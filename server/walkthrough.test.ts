import { describe, it, expect } from 'vitest';
import { validateWalkthrough } from './walkthrough.js';

const VALID = {
  global: {
    type: 'Enhancement',
    risk: 'low',
    effort: 2,
    relevant_tests: 'yes',
    security_concerns: null,
    ticket_compliance: [],
    summary: 'adds a thing',
    key_review_points: ['look at the thing'],
  },
  groups: [
    {
      name: 'Schema',
      summary: '',
      files: [{ path: 'server/db.ts', label: 'dependencies', summary: 'adds column' }],
    },
  ],
};

describe('validateWalkthrough', () => {
  it('accepts a valid walkthrough when group files match diff', () => {
    const result = validateWalkthrough(VALID, ['server/db.ts']);
    expect(result.ok).toBe(true);
  });

  it('rejects unknown PR type', () => {
    const bad = { ...VALID, global: { ...VALID.global, type: 'Refactor' } };
    const result = validateWalkthrough(bad, ['server/db.ts']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain(
      'global.type must be one of: Bug fix, Tests, Enhancement, Documentation, Other',
    );
  });

  it('rejects effort outside 1-5', () => {
    const bad = { ...VALID, global: { ...VALID.global, effort: 7 } };
    const result = validateWalkthrough(bad, ['server/db.ts']);
    expect(result.ok).toBe(false);
  });

  it('rejects a file path that is not in the diff', () => {
    const bad = {
      ...VALID,
      groups: [
        {
          name: 'X',
          summary: '',
          files: [{ path: 'made/up.ts', label: 'miscellaneous', summary: '' }],
        },
      ],
    };
    const result = validateWalkthrough(bad, ['server/db.ts']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/hallucinated file path/);
  });

  it('reports orphans (diff files not in any group) without rejecting', () => {
    const result = validateWalkthrough(VALID, ['server/db.ts', 'package-lock.json']);
    expect(result.ok).toBe(true);
    expect(result.orphans).toEqual(['package-lock.json']);
  });
});
