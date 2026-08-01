import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { WEEKLY_UPDATE_SCHEMA } from './schema.js';

describe('WEEKLY_UPDATE_SCHEMA', () => {
  it('requires the run-result envelope alongside kind-specific fields', () => {
    const validate = new Ajv().compile(WEEKLY_UPDATE_SCHEMA);

    expect(validate({ period: 'Jan 1 - 7', themes: [], highlights: [] })).toBe(false);
    expect(
      validate({
        outcome: 'done',
        summary: 'Quiet week.',
        period: 'Jan 1 - 7',
        themes: [],
        highlights: [],
      }),
    ).toBe(true);
  });

  it('rejects an outcome outside the enum', () => {
    const validate = new Ajv().compile(WEEKLY_UPDATE_SCHEMA);

    expect(
      validate({
        outcome: 'success',
        summary: 'x',
        period: 'Jan 1 - 7',
        themes: [],
        highlights: [],
      }),
    ).toBe(false);
  });

  it('accepts an optional links array', () => {
    const validate = new Ajv().compile(WEEKLY_UPDATE_SCHEMA);

    expect(
      validate({
        outcome: 'done',
        summary: 'x',
        period: 'Jan 1 - 7',
        themes: [],
        highlights: [],
        links: [{ label: 'Report', url: 'https://example.com/report' }],
      }),
    ).toBe(true);
  });
});
