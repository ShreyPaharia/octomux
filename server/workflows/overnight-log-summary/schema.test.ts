import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { OVERNIGHT_LOG_SUMMARY_SCHEMA } from './schema.js';

describe('OVERNIGHT_LOG_SUMMARY_SCHEMA', () => {
  it('requires the run-result envelope alongside kind-specific fields', () => {
    const validate = new Ajv().compile(OVERNIGHT_LOG_SUMMARY_SCHEMA);

    expect(validate({ window: '8h', summary: 'ok', errorClasses: [], notableEvents: [] })).toBe(
      false,
    );
    expect(
      validate({
        outcome: 'done',
        summary: 'ok',
        window: '8h',
        errorClasses: [],
        notableEvents: [],
      }),
    ).toBe(true);
  });

  it('rejects an outcome outside the enum', () => {
    const validate = new Ajv().compile(OVERNIGHT_LOG_SUMMARY_SCHEMA);

    expect(
      validate({
        outcome: 'success',
        summary: 'ok',
        window: '8h',
        errorClasses: [],
        notableEvents: [],
      }),
    ).toBe(false);
  });

  it('accepts an optional links array', () => {
    const validate = new Ajv().compile(OVERNIGHT_LOG_SUMMARY_SCHEMA);

    expect(
      validate({
        outcome: 'blocked',
        summary: 'ok',
        window: '8h',
        errorClasses: [],
        notableEvents: [],
        links: [{ label: 'Incident', url: 'https://example.com/incident' }],
      }),
    ).toBe(true);
  });
});
