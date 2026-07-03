import { describe, it, expect } from 'vitest';
import {
  OCTOMUX_COLUMNS,
  isOctomuxColumn,
  validateFlatStatusMap,
  validateStatusMapObject,
  validateStatusMapByTeam,
} from './types.js';

describe('integration column helpers', () => {
  it('OCTOMUX_COLUMNS matches workflow statuses', () => {
    expect(OCTOMUX_COLUMNS).toEqual([
      'backlog',
      'planned',
      'in_progress',
      'human_review',
      'pr',
      'done',
    ]);
  });

  it.each([
    ['done', true],
    ['bogus', false],
  ] as const)('isOctomuxColumn(%s) → %s', (col, expected) => {
    expect(isOctomuxColumn(col)).toBe(expected);
  });

  it('validateStatusMapObject rejects non-object', () => {
    const errors: string[] = [];
    validateStatusMapObject(null, 'status_map', errors);
    expect(errors).toContain('status_map is required and must be an object');
  });

  it('validateFlatStatusMap rejects invalid column keys', () => {
    const errors: string[] = [];
    validateFlatStatusMap({ done: '41', bogus: '99' }, 'status_map', errors);
    expect(errors.some((e) => e.includes('bogus'))).toBe(true);
  });

  it('validateStatusMapByTeam rejects invalid uuid', () => {
    const errors: string[] = [];
    validateStatusMapByTeam({ BAC: { done: 'not-a-uuid' } }, 'status_map_by_team', errors);
    expect(errors.some((e) => e.includes('uuid'))).toBe(true);
  });
});
